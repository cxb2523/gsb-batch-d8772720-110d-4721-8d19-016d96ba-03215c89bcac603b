"""Service-level checks: history, minimum interval, --force, last known state, concurrency."""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
import respx

from mecha.core.config import Config, parse_config
from mecha.core.models import Overall, ProviderId
from mecha.core.paths import db_path
from mecha.core.scheduler import Scheduler
from mecha.core.service import MechaService
from mecha.providers import get_provider
from mecha.store.db import HISTORY_LIMIT, open_store
from tests.fakes import fake, fake_aiza
from tests.test_error_map import fixture

pytestmark = pytest.mark.anyio

FAST = parse_config("[http]\nretries = 0\nbackoff_seconds = 0\n")


class Clock:
    def __init__(self) -> None:
        self.now = datetime(2026, 11, 4, 12, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now

    def advance(self, **kw: float) -> None:
        self.now += timedelta(**kw)


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def svc(clock: Clock) -> Any:
    service = MechaService(lambda: open_store(db_path(), None), now=clock, config=FAST)
    yield service
    service.close()


def respond(router: respx.MockRouter, host: str, provider: str, name: str) -> respx.Route:
    fx = fixture(provider, name)
    return router.route(host=host).mock(
        return_value=httpx.Response(fx["status"], json=fx["body"], headers=fx["headers"])
    )


async def test_check_stores_history_and_shows_in_list(svc: MechaService) -> None:
    item = svc.add(fake("xai-"))
    with respx.mock as router:
        route = respond(router, "api.x.ai", "xai", "api_key_ok")
        [checked] = await svc.check()
    assert route.call_count == 1
    assert checked.result.overall is Overall.green
    assert not checked.cached
    [listed] = svc.list()
    assert listed.result.overall is Overall.green
    assert listed.result.mode == "passive"
    assert len(svc.store.history(item.credential.id)) == 1


async def test_min_interval_reuses_result_unless_force(svc: MechaService, clock: Clock) -> None:
    svc.add(fake("xai-"))
    with respx.mock as router:
        route = respond(router, "api.x.ai", "xai", "api_key_ok")
        await svc.check()
        clock.advance(minutes=2)
        [cached] = await svc.check()
        assert route.call_count == 1, "within 5 min: no request"
        assert cached.cached
        assert cached.result.checked_at == clock.now - timedelta(minutes=2), "says when it is from"
        [forced] = await svc.check(force=True)
        assert route.call_count == 2
        assert not forced.cached
        clock.advance(minutes=6)
        await svc.check()
        assert route.call_count == 3


async def test_grey_card_shows_last_known_state(svc: MechaService, clock: Clock) -> None:
    svc.add(fake("xai-"))
    with respx.mock as router:
        respond(router, "api.x.ai", "xai", "api_key_ok")
        await svc.check()
    green_at = clock.now
    clock.advance(hours=7)
    with respx.mock as router:
        router.route(host="api.x.ai").mock(side_effect=httpx.ConnectError("down"))
        [item] = await svc.check()
    assert item.result.overall is Overall.grey
    assert [r.code for r in item.result.reasons] == ["check_failed"]
    assert item.last_known is not None
    assert item.last_known.overall is Overall.green
    assert item.last_known.checked_at == green_at


async def test_offline_conditions_survive_a_failed_check(svc: MechaService) -> None:
    svc.add(fake_aiza())  # retiring key type
    with respx.mock as router:
        router.route(host="generativelanguage.googleapis.com").mock(
            side_effect=httpx.ConnectTimeout("t")
        )
        [item] = await svc.check()
    assert item.result.overall is Overall.amber


async def test_oauth_credentials_are_never_sent(svc: MechaService) -> None:
    svc.add(fake("sk-ant-oat01-", 95))
    with respx.mock(assert_all_called=False) as router:
        route = router.route().mock(return_value=httpx.Response(200, json={}))
        [item] = await svc.check(force=True)
    assert not route.called
    assert item.result.overall is Overall.local


async def test_concurrency_limits(clock: Clock) -> None:
    config = parse_config("[http]\nretries = 0\n[scheduler]\nconcurrency = 3\nper_provider = 2\n")
    svc = MechaService(lambda: open_store(db_path(), None), now=clock, config=config)
    for _ in range(4):
        svc.add(fake("xai-"))
    for _ in range(4):
        svc.add(fake("sk-ant-api03-"))
    active: dict[str, int] = {"total": 0, "api.x.ai": 0, "api.anthropic.com": 0}
    peak: dict[str, int] = dict.fromkeys(active, 0)

    async def slow(request: httpx.Request) -> httpx.Response:
        host = request.url.host
        for key in ("total", host):
            active[key] += 1
            peak[key] = max(peak[key], active[key])
        await asyncio.sleep(0.02)
        for key in ("total", host):
            active[key] -= 1
        body = fixture(
            "xai" if host == "api.x.ai" else "anthropic",
            "api_key_ok" if host == "api.x.ai" else "models_ok",
        )["body"]
        return httpx.Response(200, json=body)

    with respx.mock as router:
        router.route().mock(side_effect=slow)
        items = await svc.check()
    svc.close()
    assert len(items) == 8
    assert peak["total"] <= 3
    assert peak["api.x.ai"] <= 2
    assert peak["api.anthropic.com"] <= 2


async def test_plugin_crash_is_grey_not_an_exception(
    svc: MechaService, monkeypatch: pytest.MonkeyPatch
) -> None:
    svc.add(fake("xai-"))
    plugin = get_provider(ProviderId.xai)

    async def boom(*args: object, **kwargs: object) -> None:
        raise ZeroDivisionError("bug")

    monkeypatch.setattr(type(plugin), "check_passive", boom)
    [item] = await svc.check()
    assert item.result.overall is Overall.grey
    assert item.result.error is not None
    assert item.result.error.code == "internal"


async def test_history_is_capped(svc: MechaService, clock: Clock) -> None:
    item = svc.add(fake("xai-"))
    with respx.mock as router:
        respond(router, "api.x.ai", "xai", "api_key_ok")
        for _ in range(HISTORY_LIMIT + 3):
            await svc.check(force=True)
            clock.advance(seconds=1)
    assert len(svc.store.history(item.credential.id, limit=10_000)) == HISTORY_LIMIT


async def test_secret_never_in_history_or_logs(
    svc: MechaService, caplog: pytest.LogCaptureFixture
) -> None:
    secret = fake("sk-ant-api03-CANARY", 80)
    svc.add(secret)
    caplog.set_level(logging.DEBUG)
    with respx.mock as router:
        router.route(host="api.anthropic.com").mock(
            return_value=httpx.Response(
                401,
                json={
                    "type": "error",
                    "error": {"type": "authentication_error", "message": f"bad {secret}"},
                },
            )
        )
        await svc.check()
    rows = svc.store.conn.execute("SELECT payload FROM check_results").fetchall()
    payload = json.dumps([r["payload"] for r in rows])
    assert secret not in payload
    assert secret[20:50] not in payload
    assert secret not in caplog.text


async def test_scheduler_checks_only_due_credentials(svc: MechaService, clock: Clock) -> None:
    svc.add(fake("xai-"))
    svc.add(fake("sk-ant-oat01-", 95))  # never checked remotely
    sched = Scheduler(svc)
    with respx.mock as router:
        route = respond(router, "api.x.ai", "xai", "api_key_ok")
        assert len(await sched.run_once()) == 1
        clock.advance(hours=5)
        assert await sched.run_once() == []
        clock.advance(hours=1)
        assert len(await sched.run_once()) == 1
    assert route.call_count == 2


async def test_scheduler_survives_errors(
    svc: MechaService, monkeypatch: pytest.MonkeyPatch
) -> None:
    sched = Scheduler(svc, tick_seconds=0)
    calls = 0

    async def flaky() -> list[object]:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("transient")
        raise asyncio.CancelledError

    monkeypatch.setattr(sched, "run_once", flaky)
    with pytest.raises(asyncio.CancelledError):
        await sched.run_forever()
    assert calls == 2


def test_default_config() -> None:
    c = Config()
    assert c.scheduler.interval_hours == 6
    assert c.scheduler.min_interval_minutes == 5
    assert c.scheduler.concurrency == 4
    assert c.scheduler.per_provider == 2
    assert c.http.timeout_seconds == 10
    assert c.http.retries == 3
    assert c.providers.anthropic.version == "2026-10-21"


async def test_failed_manual_check_is_not_fresh(svc: MechaService, clock: Clock) -> None:
    svc.add(fake("xai-"))
    with respx.mock as router:
        route = router.route(host="api.x.ai").mock(
            side_effect=[
                httpx.ConnectError("down"),
                httpx.Response(200, json=fixture("xai", "api_key_ok")["body"]),
            ]
        )
        [first] = await svc.check()
        assert first.result.overall is Overall.grey
        clock.advance(minutes=1)
        [second] = await svc.check()  # within 5 min, but the last one failed: check again
    assert route.call_count == 2
    assert not second.cached
    assert second.result.overall is Overall.green


async def test_scheduler_backs_off_after_failures(svc: MechaService, clock: Clock) -> None:
    """Failures retry at min_interval, 2x, 4x… capped at interval_hours; success resets."""
    svc.add(fake("xai-"))
    sched = Scheduler(svc)
    with respx.mock as router:
        route = router.route(host="api.x.ai").mock(side_effect=httpx.ConnectError("asleep"))
        await sched.run_once()  # first check fails
        waits = []
        for _ in range(8):
            start = clock.now
            while not await sched.run_once():
                clock.advance(minutes=1)
            waits.append(int((clock.now - start).total_seconds() // 60))
    assert waits == [5, 10, 20, 40, 80, 160, 320, 360]  # capped at 6 h
    assert route.call_count == 9


async def test_scheduler_back_to_normal_interval_after_recovery(
    svc: MechaService, clock: Clock
) -> None:
    svc.add(fake("xai-"))
    sched = Scheduler(svc)
    ok = httpx.Response(200, json=fixture("xai", "api_key_ok")["body"])
    with respx.mock as router:
        router.route(host="api.x.ai").mock(side_effect=[httpx.ConnectError("x"), ok, ok])
        await sched.run_once()  # fail
        clock.advance(minutes=5)
        [recovered] = await sched.run_once()  # retried after 5 min
        assert recovered.result.overall is Overall.green
        clock.advance(hours=5, minutes=59)
        assert await sched.run_once() == []  # regular 6 h interval again
        clock.advance(minutes=1)
        assert len(await sched.run_once()) == 1


def test_retry_delay_values(svc: MechaService) -> None:
    assert svc.retry_delay(0) == timedelta(hours=6)
    assert svc.retry_delay(1) == timedelta(minutes=5)
    assert svc.retry_delay(3) == timedelta(minutes=20)
    assert svc.retry_delay(50) == timedelta(hours=6)


def test_backoff_has_a_one_minute_floor(clock: Clock) -> None:
    config = parse_config("[scheduler]\nmin_interval_minutes = 0\n")
    svc = MechaService(lambda: open_store(db_path(), None), now=clock, config=config)
    assert svc.retry_delay(1) == timedelta(minutes=1)  # never "every tick"
    assert svc.retry_delay(2) == timedelta(minutes=2)
    assert svc.retry_delay(0) == timedelta(hours=6)
