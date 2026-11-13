"""Batch ingestion with a structured, resumable outcome for every target company.

The rotating-queue contract lives here: each tick takes the least recently crawled
active companies, runs one ingester per company in isolation, and reports what
happened to each of them. A company that raises keeps its old ``last_crawled_at``
(its ingester never got to advance it), so the next tick picks it up first; a
company that succeeds has its timestamp advanced by the ingester itself. No single
company's failure can interrupt the rest of the batch, and one company is never
processed twice in the same batch.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping, Sequence
from contextlib import AbstractContextManager
from enum import StrEnum

import httpx2 as httpx
from loguru import logger
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.config import settings
from app.ingestion.base import BaseIngester
from app.ingestion.workday import SlugParseError
from app.models import Company
from app.schemas import IngestResponse


class CompanyOutcome(StrEnum):
    SUCCESS = "success"
    FAILED = "failed"
    SKIPPED = "skipped"


class FailureReason(StrEnum):
    NETWORK = "network_error"
    HTTP_STATUS = "http_status_error"
    SLUG_PARSE = "slug_parse_error"
    OTHER = "other_error"


class BatchStatus(StrEnum):
    COMPLETED = "completed"
    LOCK_UNAVAILABLE = "lock_unavailable"


class CompanyIngestRecord(BaseModel):
    """Outcome of one target company within a batch."""

    slug: str
    ats_type: str
    city: str | None = None
    outcome: CompanyOutcome
    failure_reason: FailureReason | None = None
    error_message: str | None = None
    new_jobs: int = 0
    updated_jobs: int = 0
    deactivated_jobs: int = 0


class IngestionBatchSummary(BaseModel):
    """Structured result of a batch run, suitable for logs, scripts, or an API surface."""

    status: BatchStatus
    batch_size: int | None = None
    total_targets: int = 0
    succeeded: int = 0
    failed: int = 0
    skipped: int = 0
    new_jobs: int = 0
    updated_jobs: int = 0
    deactivated_jobs: int = 0
    failure_reasons: dict[str, int] = {}
    records: list[CompanyIngestRecord] = []

    @property
    def lock_unavailable(self) -> bool:
        """True when the whole tick was skipped because another runner holds the lock."""
        return self.status is BatchStatus.LOCK_UNAVAILABLE


def classify_failure(exc: BaseException) -> FailureReason:
    """Map an ingester exception onto the failure category reported in the summary.

    Ordering matters: slug parse errors are ValueErrors, not transport errors, and an
    ``HTTPStatusError`` is not an ``httpx.RequestError``, but each is checked explicitly
    so the categories stay stable if the underlying HTTP library changes its hierarchy.
    """
    if isinstance(exc, SlugParseError):
        return FailureReason.SLUG_PARSE
    if isinstance(exc, httpx.HTTPStatusError):
        return FailureReason.HTTP_STATUS
    if isinstance(exc, httpx.RequestError):
        return FailureReason.NETWORK
    return FailureReason.OTHER


def select_targets(session: Session, batch_size: int | None) -> list[Company]:
    """Return the least recently crawled active companies, oldest ``last_crawled_at`` first.

    ``batch_size=0`` (or ``None`` meaning "no cap") selects every active company, as the
    seed scripts need. Rows with a NULL timestamp sort first so never-crawled companies
    jump the queue.
    """
    query = (
        session.query(Company)
        .filter(Company.is_active.is_(True), Company.ats_type.isnot(None))
        .order_by(Company.last_crawled_at.asc().nullsfirst())
    )
    if batch_size:
        query = query.limit(batch_size)
    return list(query.all())


def _empty_summary(batch_size: int | None) -> IngestionBatchSummary:
    return IngestionBatchSummary(status=BatchStatus.COMPLETED, batch_size=batch_size)


async def process_targets(
    targets: Sequence[Company],
    *,
    session_factory: Callable[[], AbstractContextManager[Session]],
    ingesters: Mapping[str, BaseIngester],
    crawl_delay: float = settings.CRAWL_DELAY,
) -> list[CompanyIngestRecord]:
    """Ingest each target company once, isolating every failure to its own record.

    A fresh session is opened per company so a rolled-back failure cannot poison the
    next company's transaction. The ``seen`` set guarantees the same company slug is
    handled at most once even if the target list contains duplicates.
    """
    records: list[CompanyIngestRecord] = []
    seen_slugs: set[str] = set()

    for company in targets:
        if company.slug in seen_slugs:
            records.append(
                CompanyIngestRecord(
                    slug=company.slug,
                    ats_type=company.ats_type or "",
                    city=company.city,
                    outcome=CompanyOutcome.SKIPPED,
                    error_message="duplicate target; already processed in this batch",
                )
            )
            continue
        seen_slugs.add(company.slug)

        ats_type = company.ats_type or ""
        ingester = ingesters.get(ats_type)
        if ingester is None:
            records.append(
                CompanyIngestRecord(
                    slug=company.slug,
                    ats_type=ats_type,
                    city=company.city,
                    outcome=CompanyOutcome.SKIPPED,
                    error_message=f"no ingester registered for ats_type '{ats_type}'",
                )
            )
            continue

        try:
            with session_factory() as db:
                result: IngestResponse = await ingester.ingest(company.ats_slug, db)
        except Exception as exc:
            # The ingester commits nothing on this path, so last_crawled_at is untouched
            # and this company stays at the head of the rotating queue for next tick.
            reason = classify_failure(exc)
            logger.warning(
                f"[ingest-batch] {company.slug} ({ats_type}/{company.city}) failed: "
                f"{reason.value}: {exc}"
            )
            records.append(
                CompanyIngestRecord(
                    slug=company.slug,
                    ats_type=ats_type,
                    city=company.city,
                    outcome=CompanyOutcome.FAILED,
                    failure_reason=reason,
                    error_message=f"{type(exc).__name__}: {exc}",
                )
            )
        else:
            records.append(
                CompanyIngestRecord(
                    slug=company.slug,
                    ats_type=ats_type,
                    city=company.city,
                    outcome=CompanyOutcome.SUCCESS,
                    new_jobs=result.new_jobs,
                    updated_jobs=result.updated_jobs,
                    deactivated_jobs=result.deactivated_jobs,
                )
            )

        if crawl_delay:
            await asyncio.sleep(crawl_delay)

    return records


def build_summary(batch_size: int | None, records: Sequence[CompanyIngestRecord]):
    """Aggregate per-company records into the batch-level summary."""
    summary = _empty_summary(batch_size)
    summary.records = list(records)
    summary.total_targets = len(records)
    summary.succeeded = sum(r.outcome is CompanyOutcome.SUCCESS for r in records)
    summary.failed = sum(r.outcome is CompanyOutcome.FAILED for r in records)
    summary.skipped = sum(r.outcome is CompanyOutcome.SKIPPED for r in records)
    summary.new_jobs = sum(r.new_jobs for r in records)
    summary.updated_jobs = sum(r.updated_jobs for r in records)
    summary.deactivated_jobs = sum(r.deactivated_jobs for r in records)

    reason_counts: dict[str, int] = {}
    for record in records:
        if record.failure_reason is not None:
            reason_counts[record.failure_reason.value] = (
                reason_counts.get(record.failure_reason.value, 0) + 1
            )
    summary.failure_reasons = reason_counts
    return summary


async def run_ingestion_batch(
    *,
    batch_size: int | None,
    session_factory: Callable[[], AbstractContextManager[Session]],
    ingesters: Mapping[str, BaseIngester],
    crawl_delay: float = settings.CRAWL_DELAY,
) -> IngestionBatchSummary:
    """Select the next batch of companies and ingest them, returning a full summary."""
    with session_factory() as session:
        targets = select_targets(session, batch_size)

    logger.info(
        f"[ingest-batch] run started: {len(targets)} targets "
        f"(batch cap={batch_size if batch_size else 'all'})"
    )
    records = await process_targets(
        targets,
        session_factory=session_factory,
        ingesters=ingesters,
        crawl_delay=crawl_delay,
    )
    summary = build_summary(batch_size, records)
    logger.info(
        f"[ingest-batch] run complete: succeeded={summary.succeeded} "
        f"failed={summary.failed} skipped={summary.skipped} "
        f"new={summary.new_jobs} updated={summary.updated_jobs} "
        f"deactivated={summary.deactivated_jobs} reasons={summary.failure_reasons}"
    )
    return summary
