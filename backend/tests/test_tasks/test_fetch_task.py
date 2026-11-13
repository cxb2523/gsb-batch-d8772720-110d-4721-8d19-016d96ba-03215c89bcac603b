"""Per-adapter fetch attempt recording in the fetch task.

Uses self-made fake adapters registered into the real registry and the local
test database — no external network access. Each test runs the real
``_fetch_source`` coroutine and then inspects the summary AdapterHealthLog
and the per-attempt AdapterFetchAttempt rows it wrote.
"""
import uuid
from datetime import datetime, timezone

import pytest
import pytest_asyncio
from sqlalchemy import select

from app.adapters.base import ArticleItem, BaseAdapter, SourceInfo
from app.adapters.registry import registry
from app.models.adapter_fetch_attempt import AdapterFetchAttempt
from app.models.adapter_health_log import AdapterHealthLog
from app.models.article import Article
from app.models.source import Source
from app.tasks import fetch_task
from app.tasks import notify_task

from tests.conftest import TestSession

PLATFORM = "testplat"


class FakeAdapter(BaseAdapter):
    """Test double: either raises a fixed error or returns fixed articles."""

    platform = PLATFORM
    name = "fake"

    def __init__(self, adapter_type: str, error: Exception | None = None,
                 items: list[ArticleItem] | None = None):
        self.adapter_type = adapter_type
        self._error = error
        self._items = items if items is not None else [
            ArticleItem(title=f"via {adapter_type}", url=f"https://example.com/{adapter_type}/1")
        ]
        self.calls = 0

    def detect(self, url: str) -> bool:
        return False

    async def resolve(self, url: str) -> SourceInfo:
        raise NotImplementedError

    async def fetch(self, source: SourceInfo, cookies: str | None = None) -> list[ArticleItem]:
        self.calls += 1
        if self._error is not None:
            raise self._error
        return self._items


@pytest_asyncio.fixture
async def source(db):
    src = Source(
        id=uuid.uuid4(),
        platform=PLATFORM,
        platform_uid="uid-1",
        display_name="Test Source",
        home_url="https://example.com/uid-1",
        adapter_type="rss",
        adapter_config={},
    )
    db.add(src)
    await db.commit()
    return src


@pytest.fixture
def patched_task(monkeypatch):
    """Point the fetch task at the test DB and stub out celery notification."""
    monkeypatch.setattr(fetch_task, "_session_factory", TestSession)
    monkeypatch.setattr(notify_task.notify_new_article, "delay", lambda *a, **k: None)
    yield
    registry.unregister(PLATFORM)


async def _run(source_id) -> None:
    await fetch_task._fetch_source(str(source_id))


async def _get_logs(db) -> list[AdapterHealthLog]:
    result = await db.execute(select(AdapterHealthLog))
    return list(result.scalars().all())


async def _get_attempts(db) -> list[AdapterFetchAttempt]:
    result = await db.execute(
        select(AdapterFetchAttempt).order_by(AdapterFetchAttempt.sequence)
    )
    return list(result.scalars().all())


@pytest.mark.asyncio
async def test_first_adapter_fails_second_succeeds(db, source, patched_task):
    failing = FakeAdapter("rss", error=RuntimeError("rss boom"))
    succeeding = FakeAdapter("rsshub")
    registry.register(failing)
    registry.register(succeeding)

    await _run(source.id)

    attempts = await _get_attempts(db)
    assert len(attempts) == 2
    # Order matches the fallback chain: rss tried first, then rsshub
    assert [a.adapter_type for a in attempts] == ["rss", "rsshub"]
    assert attempts[0].sequence == 0
    assert attempts[0].success is False
    assert attempts[0].error_message == "rss boom"
    assert attempts[0].duration_ms >= 0
    assert attempts[1].sequence == 1
    assert attempts[1].success is True
    assert attempts[1].error_message is None

    logs = await _get_logs(db)
    assert len(logs) == 1
    log = logs[0]
    assert log.success is True
    assert log.adapter_type == "rsshub"
    assert log.error_message is None
    assert log.articles_count == 1
    assert all(a.health_log_id == log.id for a in attempts)

    # Fallback chain stopped at the first success
    assert failing.calls == 1
    assert succeeding.calls == 1

    # Original success behavior preserved: article stored, last_fetched_at set
    articles = (await db.execute(select(Article))).scalars().all()
    assert len(articles) == 1
    assert articles[0].title == "via rsshub"
    await db.refresh(source)
    assert source.last_fetched_at is not None
    assert source.last_fetched_at.tzinfo is not None


@pytest.mark.asyncio
async def test_all_adapters_fail(db, source, patched_task):
    adapters = [
        FakeAdapter("rss", error=RuntimeError("rss down")),
        FakeAdapter("rsshub", error=RuntimeError("rsshub down")),
        FakeAdapter("scraper", error=RuntimeError("scraper down")),
    ]
    for a in adapters:
        registry.register(a)

    await _run(source.id)

    attempts = await _get_attempts(db)
    assert len(attempts) == len(adapters)
    assert [a.adapter_type for a in attempts] == ["rss", "rsshub", "scraper"]
    assert [a.sequence for a in attempts] == [0, 1, 2]
    assert all(a.success is False for a in attempts)
    assert [a.error_message for a in attempts] == ["rss down", "rsshub down", "scraper down"]

    logs = await _get_logs(db)
    assert len(logs) == 1
    log = logs[0]
    assert log.success is False
    # Summary carries the last adapter's error
    assert log.error_message == "scraper down"
    assert log.articles_count == 0
    assert all(a.health_log_id == log.id for a in attempts)

    # Every adapter was tried exactly once
    assert all(a.calls == 1 for a in adapters)

    # No articles stored, last_fetched_at untouched
    assert (await db.execute(select(Article))).scalars().all() == []
    await db.refresh(source)
    assert source.last_fetched_at is None


@pytest.mark.asyncio
async def test_single_adapter_success(db, source, patched_task):
    only = FakeAdapter("rss")
    registry.register(only)

    await _run(source.id)

    attempts = await _get_attempts(db)
    assert len(attempts) == 1
    assert attempts[0].adapter_type == "rss"
    assert attempts[0].sequence == 0
    assert attempts[0].success is True
    assert attempts[0].error_message is None

    logs = await _get_logs(db)
    assert len(logs) == 1
    assert logs[0].success is True
    assert logs[0].adapter_type == "rss"
    assert attempts[0].health_log_id == logs[0].id


@pytest.mark.asyncio
async def test_attempts_visible_in_health_api(db, source, patched_task):
    """The per-attempt records surface through the platform health log API."""
    from app.services import health_service

    registry.register(FakeAdapter("rss", error=RuntimeError("rss boom")))
    registry.register(FakeAdapter("rsshub"))

    await _run(source.id)

    logs = await health_service.get_platform_logs(db, PLATFORM)
    assert len(logs) == 1
    attempts = logs[0]["attempts"]
    assert [a["adapter_type"] for a in attempts] == ["rss", "rsshub"]
    assert attempts[0]["success"] is False
    assert attempts[0]["error_message"] == "rss boom"
    assert attempts[0]["duration_ms"] >= 0
    assert attempts[1]["success"] is True
    assert attempts[1]["error_message"] is None
