"""Unit tests for the resumable batch ingestion entry point.

Everything runs against in-memory SQLite with scripted fake ingesters, so no ATS
network is touched. The JSONB/Postgres-only index shims mirror test_ingest_flow.py.
"""

from datetime import UTC, datetime, timedelta

import httpx2 as httpx
import pytest
from sqlalchemy import MetaData, create_engine
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.ingestion.batch import (
    BatchStatus,
    CompanyOutcome,
    FailureReason,
    build_summary,
    classify_failure,
    process_targets,
    run_ingestion_batch,
    select_targets,
)
from app.ingestion.workday import SlugParseError, WorkdayIngester
from app.models import Company
from app.schemas import IngestResponse


@compiles(JSONB, "sqlite")
def _render_jsonb_as_json(type_, compiler, **kw):
    """Let the JSONB columns build on SQLite so these tests need no live Postgres."""
    return "JSON"


@pytest.fixture
def session_factory():
    """In-memory SQLite shared across connections via StaticPool.

    The batch runner opens a fresh session per company, so the database must survive
    connection close; StaticPool keeps the single in-memory connection alive for the
    whole test. Postgres-only indexes are dropped via the throwaway MetaData.
    """
    meta = MetaData()
    for table in (Company.__table__,):
        table.to_metadata(meta).indexes.clear()

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    meta.create_all(engine)
    factory = sessionmaker(bind=engine)
    yield factory
    engine.dispose()


def make_company(
    factory,
    slug,
    ats_type,
    *,
    ats_slug=None,
    city=None,
    last_crawled_at=None,
    is_active=True,
):
    """Insert a company with coordinates set so the real ingester's geocode hook is skipped."""
    with factory() as db:
        company = Company(
            name=slug.title(),
            slug=slug,
            ats_type=ats_type,
            ats_slug=ats_slug if ats_slug is not None else slug,
            city=city,
            country_code="DE",
            latitude=52.52,
            longitude=13.405,
            last_crawled_at=last_crawled_at,
            is_active=is_active,
        )
        db.add(company)
        db.commit()
    return company


class FakeIngester:
    """Ingester double whose per-slug behavior is scripted by the test.

    On success it advances last_crawled_at the way BaseIngester.ingest() does and
    returns an IngestResponse with the configured counts. Failures raise without
    touching the timestamp, again mirroring the real contract.
    """

    def __init__(self, ats_type, behavior):
        self.ats_type = ats_type
        # behavior maps ats_slug -> either IngestResponse counts (dict) or an exception.
        self.behavior = behavior
        self.called: list[str] = []

    async def ingest(self, slug, db):
        self.called.append(slug)
        scripted = self.behavior[slug]
        if isinstance(scripted, BaseException):
            raise scripted

        company = db.query(Company).filter(Company.ats_slug == slug).one()
        company.last_crawled_at = datetime.now(tz=UTC)
        company.crawl_error = None
        db.commit()
        return IngestResponse(
            company_slug=company.slug,
            ats_type=self.ats_type,
            new_jobs=scripted.get("new", 0),
            updated_jobs=scripted.get("updated", 0),
            deactivated_jobs=scripted.get("deactivated", 0),
        )


def _http_status_error():
    request = httpx.Request("GET", "https://example.test")
    return httpx.HTTPStatusError(
        "404", request=request, response=httpx.Response(404, request=request)
    )


def _stale_timestamp(hours):
    return datetime.now(tz=UTC) - timedelta(hours=hours)


def _reloaded(factory, slug):
    with factory() as db:
        return db.query(Company).filter(Company.slug == slug).one()


@pytest.fixture
def anyio_backend():
    """Restrict this module to asyncio: the scheduler and its HTTP stack are asyncio-only."""
    return "asyncio"


@pytest.mark.anyio
async def test_successful_batch_records_counts_and_advances_timestamps(session_factory):
    """Happy path: every target succeeds and the summary aggregates per-company counts."""
    make_company(
        session_factory, "alpha", "fake", city="Berlin", last_crawled_at=_stale_timestamp(30)
    )
    make_company(
        session_factory, "beta", "fake", city="London", last_crawled_at=_stale_timestamp(20)
    )
    make_company(
        session_factory, "gamma", "fake", city="Paris", last_crawled_at=_stale_timestamp(10)
    )

    ingesters = {
        "fake": FakeIngester(
            "fake",
            {
                "alpha": {"new": 2, "updated": 1, "deactivated": 0},
                "beta": {"new": 0, "updated": 3, "deactivated": 1},
                "gamma": {"new": 5, "updated": 0, "deactivated": 2},
            },
        )
    }

    summary = await run_ingestion_batch(
        batch_size=10,
        session_factory=session_factory,
        ingesters=ingesters,
        crawl_delay=0,
    )

    assert summary.status is BatchStatus.COMPLETED
    assert summary.total_targets == 3
    assert summary.succeeded == 3
    assert summary.failed == 0
    assert summary.skipped == 0
    assert summary.new_jobs == 7
    assert summary.updated_jobs == 4
    assert summary.deactivated_jobs == 3
    assert summary.failure_reasons == {}
    assert [r.slug for r in summary.records] == ["alpha", "beta", "gamma"]
    assert all(r.outcome is CompanyOutcome.SUCCESS for r in summary.records)
    # City is carried on each record so operators can localize failures.
    assert [r.city for r in summary.records] == ["Berlin", "London", "Paris"]

    # Every successful company advanced its rotating-queue timestamp.
    for slug in ("alpha", "beta", "gamma"):
        company = _reloaded(session_factory, slug)
        crawled = company.last_crawled_at
        if crawled.tzinfo is None:
            crawled = crawled.replace(tzinfo=UTC)
        assert crawled > _stale_timestamp(1)


@pytest.mark.anyio
async def test_http_and_connect_failures_are_isolated_and_classified(session_factory):
    """A failure in the middle must not stop later companies; categories must be exact."""
    http_stale = _stale_timestamp(29)
    net_stale = _stale_timestamp(28)
    make_company(session_factory, "ok-one", "fake", last_crawled_at=_stale_timestamp(30))
    make_company(session_factory, "http-dead", "fake", last_crawled_at=http_stale)
    make_company(session_factory, "net-dead", "fake", last_crawled_at=net_stale)
    make_company(session_factory, "ok-two", "fake", last_crawled_at=_stale_timestamp(27))

    ingesters = {
        "fake": FakeIngester(
            "fake",
            {
                "ok-one": {"new": 1},
                "http-dead": _http_status_error(),
                "net-dead": httpx.ConnectError("connection refused"),
                "ok-two": {"new": 4},
            },
        )
    }

    summary = await run_ingestion_batch(
        batch_size=10,
        session_factory=session_factory,
        ingesters=ingesters,
        crawl_delay=0,
    )

    assert summary.succeeded == 2
    assert summary.failed == 2
    assert summary.skipped == 0
    assert summary.new_jobs == 5
    assert summary.failure_reasons == {
        FailureReason.HTTP_STATUS.value: 1,
        FailureReason.NETWORK.value: 1,
    }

    by_slug = {r.slug: r for r in summary.records}
    assert by_slug["http-dead"].outcome is CompanyOutcome.FAILED
    assert by_slug["http-dead"].failure_reason is FailureReason.HTTP_STATUS
    assert "HTTPStatusError" in by_slug["http-dead"].error_message
    assert by_slug["net-dead"].failure_reason is FailureReason.NETWORK
    assert "ConnectError" in by_slug["net-dead"].error_message
    # The whole queue was processed despite the two failures.
    assert ingesters["fake"].called == ["ok-one", "http-dead", "net-dead", "ok-two"]
    assert by_slug["ok-two"].outcome is CompanyOutcome.SUCCESS

    # Failed companies keep their old timestamp and therefore stay at the queue head;
    # the successful ones moved past them.
    failed_stale = _reloaded(session_factory, "http-dead").last_crawled_at
    assert failed_stale is not None
    if failed_stale.tzinfo is None:
        failed_stale = failed_stale.replace(tzinfo=UTC)
    assert failed_stale == http_stale

    reloaded_net = _reloaded(session_factory, "net-dead").last_crawled_at
    if reloaded_net.tzinfo is None:
        reloaded_net = reloaded_net.replace(tzinfo=UTC)
    assert reloaded_net == net_stale

    # Next tick's ordering puts the two failed companies first: resumability in action.
    with session_factory() as db:
        ordered = [c.slug for c in select_targets(db, 10)]
    assert ordered[:2] == ["http-dead", "net-dead"]
    assert ordered[2:] == ["ok-one", "ok-two"]


@pytest.mark.anyio
async def test_workday_malformed_slug_is_a_slug_parse_error(session_factory):
    """Workday composite-slug failures classify as slug errors, never as network errors.

    The real WorkdayIngester parses its slug inside fetch_raw() before opening any
    HTTP connection, so no network is involved at all.
    """
    broken_stale = _stale_timestamp(40)
    make_company(
        session_factory,
        "broken-workday",
        "workday",
        ats_slug="tenant::board",  # empty data-center segment -> SlugParseError
        last_crawled_at=broken_stale,
    )
    make_company(session_factory, "fine", "fake", last_crawled_at=_stale_timestamp(5))
    ingesters = {
        "workday": WorkdayIngester(),
        "fake": FakeIngester("fake", {"fine": {"new": 1}}),
    }

    summary = await run_ingestion_batch(
        batch_size=10,
        session_factory=session_factory,
        ingesters=ingesters,
        crawl_delay=0,
    )

    record = next(r for r in summary.records if r.slug == "broken-workday")
    assert record.outcome is CompanyOutcome.FAILED
    assert record.failure_reason is FailureReason.SLUG_PARSE
    assert FailureReason.NETWORK.value not in summary.failure_reasons
    assert summary.failure_reasons == {FailureReason.SLUG_PARSE.value: 1}
    # The batch continued to the healthy company.
    assert summary.succeeded == 1

    # Resumable: the malformed company keeps its original timestamp.
    stale = _reloaded(session_factory, "broken-workday").last_crawled_at
    if stale.tzinfo is None:
        stale = stale.replace(tzinfo=UTC)
    assert stale == broken_stale


@pytest.mark.anyio
async def test_unknown_ats_type_is_skipped_not_failed(session_factory):
    make_company(session_factory, "mystery", "atari", last_crawled_at=_stale_timestamp(3))
    make_company(session_factory, "regular", "fake", last_crawled_at=_stale_timestamp(2))
    ingesters = {"fake": FakeIngester("fake", {"regular": {"new": 1}})}

    summary = await run_ingestion_batch(
        batch_size=10,
        session_factory=session_factory,
        ingesters=ingesters,
        crawl_delay=0,
    )

    by_slug = {r.slug: r for r in summary.records}
    assert by_slug["mystery"].outcome is CompanyOutcome.SKIPPED
    assert by_slug["mystery"].failure_reason is None
    assert "atari" in by_slug["mystery"].error_message
    assert by_slug["regular"].outcome is CompanyOutcome.SUCCESS
    assert summary.skipped == 1
    assert summary.failed == 0


@pytest.mark.anyio
async def test_same_company_is_processed_at_most_once_per_batch(session_factory):
    """Duplicate target rows must be de-duplicated inside one batch."""
    make_company(session_factory, "alpha", "fake", last_crawled_at=_stale_timestamp(10))
    make_company(session_factory, "beta", "fake", last_crawled_at=_stale_timestamp(9))

    with session_factory() as db:
        targets = select_targets(db, 10)
    duplicated = targets + [targets[0]]  # alpha appears twice

    ingester = FakeIngester("fake", {"alpha": {"new": 1}, "beta": {"new": 2}})
    records = await process_targets(
        duplicated,
        session_factory=session_factory,
        ingesters={"fake": ingester},
        crawl_delay=0,
    )
    summary = build_summary(10, records)

    assert ingester.called == ["alpha", "beta"]
    assert summary.total_targets == 3
    assert summary.succeeded == 2
    assert summary.skipped == 1
    duplicate_record = next(r for r in records if r.outcome is CompanyOutcome.SKIPPED)
    assert duplicate_record.slug == "alpha"
    assert "duplicate" in duplicate_record.error_message


@pytest.mark.anyio
async def test_inactive_and_never_crawled_companies_ordering(session_factory):
    """Selection honors is_active/ats_type filters and puts NULL timestamps first."""
    make_company(
        session_factory, "inactive", "fake", is_active=False, last_crawled_at=_stale_timestamp(100)
    )
    make_company(session_factory, "no-ats", None, last_crawled_at=_stale_timestamp(100))
    make_company(session_factory, "fresh", "fake", last_crawled_at=_stale_timestamp(1))
    make_company(session_factory, "never-crawled", "fake", last_crawled_at=None)

    with session_factory() as db:
        slugs = [c.slug for c in select_targets(db, 10)]
    assert slugs == ["never-crawled", "fresh"]

    with session_factory() as db:
        capped = [c.slug for c in select_targets(db, 1)]
    assert capped == ["never-crawled"]

    # batch_size=0 means an uncapped full pass.
    with session_factory() as db:
        full = [c.slug for c in select_targets(db, 0)]
    assert full == ["never-crawled", "fresh"]


def test_classify_failure_covers_all_categories():
    assert classify_failure(_http_status_error()) is FailureReason.HTTP_STATUS
    assert classify_failure(httpx.ConnectError("x")) is FailureReason.NETWORK
    assert classify_failure(httpx.ReadTimeout("x")) is FailureReason.NETWORK
    assert classify_failure(SlugParseError("bad slug")) is FailureReason.SLUG_PARSE
    # SlugParseError stays backward compatible with plain ValueError handling.
    assert isinstance(SlugParseError("x"), ValueError)
    assert classify_failure(RuntimeError("boom")) is FailureReason.OTHER


def test_lock_unavailable_summary_is_distinct_from_company_failures():
    """The two 'nothing happened' shapes must not be conflatable by callers."""
    from app.ingestion.batch import IngestionBatchSummary

    locked = IngestionBatchSummary(status=BatchStatus.LOCK_UNAVAILABLE, batch_size=25)
    assert locked.lock_unavailable is True
    assert locked.total_targets == 0
    assert locked.records == []
    assert locked.failed == 0

    completed = IngestionBatchSummary(status=BatchStatus.COMPLETED)
    assert completed.lock_unavailable is False


@pytest.mark.anyio
async def test_batch_with_no_targets_returns_empty_completed_summary(session_factory):
    summary = await run_ingestion_batch(
        batch_size=10,
        session_factory=session_factory,
        ingesters={"fake": FakeIngester("fake", {})},
        crawl_delay=0,
    )
    assert summary.status is BatchStatus.COMPLETED
    assert summary.total_targets == 0
    assert summary.records == []


@pytest.mark.anyio
async def test_lock_unavailable_skips_entire_batch_without_touching_timestamps(
    session_factory, monkeypatch
):
    """When the advisory lock is held elsewhere, no company is processed at all."""
    from contextlib import contextmanager

    from app import scheduler

    original_stale = _stale_timestamp(50)
    make_company(session_factory, "alpha", "fake", last_crawled_at=original_stale)
    make_company(session_factory, "beta", "fake", last_crawled_at=_stale_timestamp(40))
    ingester = FakeIngester("fake", {"alpha": {"new": 1}, "beta": {"new": 1}})
    monkeypatch.setitem(scheduler.INGESTERS, "fake", ingester)
    monkeypatch.setattr(scheduler, "get_session", lambda: session_factory())

    @contextmanager
    def _locked_out(_key, *, wait=False):
        yield False

    monkeypatch.setattr(scheduler, "advisory_lock", _locked_out)

    summary = await scheduler.run_ingestion_tick()

    assert summary.status is BatchStatus.LOCK_UNAVAILABLE
    assert summary.lock_unavailable is True
    assert summary.records == []
    assert summary.total_targets == 0
    # Nothing ran, so no ingester was invoked and no timestamp moved.
    assert ingester.called == []
    alpha = _reloaded(session_factory, "alpha")
    crawled = alpha.last_crawled_at
    if crawled.tzinfo is None:
        crawled = crawled.replace(tzinfo=UTC)
    assert crawled == original_stale


@pytest.mark.anyio
async def test_acquired_lock_runs_the_full_batch(session_factory, monkeypatch):
    """The normal tick path: lock acquired -> ordinary completed summary."""
    from contextlib import contextmanager

    from app import scheduler

    make_company(session_factory, "alpha", "fake", last_crawled_at=_stale_timestamp(50))
    ingester = FakeIngester("fake", {"alpha": {"new": 3}})
    monkeypatch.setitem(scheduler.INGESTERS, "fake", ingester)
    monkeypatch.setattr(scheduler, "get_session", lambda: session_factory())
    monkeypatch.setattr(scheduler.settings, "CRAWL_DELAY", 0)

    @contextmanager
    def _acquired(_key, *, wait=False):
        yield True

    monkeypatch.setattr(scheduler, "advisory_lock", _acquired)

    summary = await scheduler.run_ingestion_tick()

    assert summary.status is BatchStatus.COMPLETED
    assert summary.succeeded == 1
    assert summary.new_jobs == 3
    assert ingester.called == ["alpha"]
