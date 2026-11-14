"""Active probes: model choice, minimal requests, persisted facts, the hourly limit."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import httpx
import pytest
import respx

from mecha.core.capabilities import load_probes, month_label
from mecha.core.config import parse_config
from mecha.core.models import FundsState, Overall, ProviderId
from mecha.core.paths import db_path
from mecha.core.scheduler import Scheduler
from mecha.core.service import MechaService
from mecha.store.db import open_store
from tests.fakes import fake, fake_aq
from tests.test_check import Clock
from tests.test_error_map import fixture

pytestmark = pytest.mark.anyio


def service(clock: Clock, extra: str = "") -> MechaService:
    config = parse_config("[http]\nretries = 0\nbackoff_seconds = 0\n" + extra)
    return MechaService(lambda: open_store(db_path(), None), now=clock, config=config)


@pytest.fixture
def clock() -> Clock:
    return Clock()


def anthropic_models() -> dict[str, Any]:
    return {
        "data": [
            {
                "id": "claude-opus-5-5",
                "line": "opus",
                "lifecycle": "active",
                "created_at": "2026-09-21T00:00:00Z",
            },
            {
                "id": "claude-haiku-5",
                "line": "haiku",
                "lifecycle": "active",
                "created_at": "2026-03-01T00:00:00Z",
            },
            {
                "id": "claude-haiku-5-5",
                "line": "haiku",
                "lifecycle": "active",
                "created_at": "2026-09-21T00:00:00Z",
            },
        ]
    }


MESSAGE_OK = {
    "id": "msg_1",
    "type": "message",
    "role": "assistant",
    "content": [{"type": "text", "text": "."}],
    "model": "claude-haiku-5-5",
    "stop_reason": "max_tokens",
    "usage": {"input_tokens": 8, "output_tokens": 1},
}


async def test_anthropic_probe_picks_newest_haiku_and_sends_one_token(clock: Clock) -> None:
    svc = service(clock)
    item = svc.add(fake("sk-ant-api03-"))
    with respx.mock as router:
        router.get("https://api.anthropic.com/v1/models").mock(
            return_value=httpx.Response(200, json=anthropic_models())
        )
        post = router.post("https://api.anthropic.com/v1/messages").mock(
            return_value=httpx.Response(
                200,
                json=MESSAGE_OK,
                headers={
                    "anthropic-ratelimit-requests-limit": "50",
                    "anthropic-ratelimit-requests-remaining": "49",
                },
            )
        )
        [r] = await svc.check([item.credential.id], active=True)
    body = json.loads(post.calls.last.request.content)
    assert body["model"] == "claude-haiku-5-5"
    assert body["max_tokens"] == 1
    assert r.result.mode == "active"
    assert r.result.overall is Overall.green
    facts = svc.store.get(item.credential.id).facts  # type: ignore[union-attr]
    assert facts.last_probe_at == clock.now
    assert facts.probe_model == "claude-haiku-5-5"
    assert facts.funds is not None
    assert facts.funds.value.state is FundsState.ok
    assert facts.limits is not None
    svc.close()


async def test_probe_out_of_funds_survives_scheduled_passive_checks(clock: Clock) -> None:
    svc = service(clock)
    item = svc.add(fake("sk-ant-api03-"))
    cid = item.credential.id
    credit = fixture("anthropic", "credit_balance_low")
    with respx.mock as router:
        router.get("https://api.anthropic.com/v1/models").mock(
            return_value=httpx.Response(200, json=anthropic_models())
        )
        router.post("https://api.anthropic.com/v1/messages").mock(
            return_value=httpx.Response(400, json=credit["body"])
        )
        [r] = await svc.check([cid], active=True)
    assert r.result.overall is Overall.red
    clock.advance(hours=6)
    with respx.mock as router:  # the scheduler's passive check knows nothing about funds
        router.get("https://api.anthropic.com/v1/models").mock(
            return_value=httpx.Response(200, json=anthropic_models())
        )
        [r] = await Scheduler(svc).run_once()
    assert r.result.mode == "passive"
    assert r.result.overall is Overall.red, "a passive check must not undo «out of funds»"
    assert r.result.funds.value.state is FundsState.empty
    svc.close()


async def test_missing_probe_model_is_misconfigured_not_invalid(clock: Clock) -> None:
    svc = service(clock, '[probes]\nanthropic_model = "claude-gone-1"\n')
    item = svc.add(fake("sk-ant-api03-"))
    with respx.mock as router:
        listing = router.get("https://api.anthropic.com/v1/models")
        router.post("https://api.anthropic.com/v1/messages").mock(
            return_value=httpx.Response(
                404,
                json={
                    "type": "error",
                    "error": {"type": "not_found_error", "message": "model: claude-gone-1"},
                },
            )
        )
        [r] = await svc.check([item.credential.id], active=True)
    assert not listing.called, "a pinned model needs no model list"
    assert r.result.overall is Overall.grey
    assert [x.code for x in r.result.reasons] == ["probe_misconfigured"]
    assert r.result.validity.value.value != "invalid"
    assert svc.store.get(item.credential.id).facts.probe_model is None  # type: ignore[union-attr]
    svc.close()


async def test_probe_timeout_is_uncertain_and_never_resent(clock: Clock) -> None:
    # Even with retries configured for reads, a paid POST is sent exactly once.
    config = parse_config(
        '[http]\nretries = 3\nbackoff_seconds = 0\n[probes]\nanthropic_model = "claude-haiku-5-5"\n'
    )
    svc = MechaService(lambda: open_store(db_path(), None), now=clock, config=config)
    item = svc.add(fake("sk-ant-api03-"))
    with respx.mock as router:
        post = router.post("https://api.anthropic.com/v1/messages").mock(
            side_effect=httpx.ReadTimeout("slow")
        )
        [r] = await svc.check([item.credential.id], active=True)
    assert post.call_count == 1
    assert r.result.overall is Overall.grey
    assert [x.code for x in r.result.reasons] == ["probe_uncertain"]
    assert svc.store.get(item.credential.id).facts.last_probe_at == clock.now  # type: ignore[union-attr]
    svc.close()


async def test_free_count_tokens_probe_does_not_claim_funds(clock: Clock) -> None:
    svc = service(clock, '[probes]\nfree = true\nanthropic_model = "claude-haiku-5-5"\n')
    item = svc.add(fake("sk-ant-api03-"))
    with respx.mock as router:
        post = router.post("https://api.anthropic.com/v1/messages/count_tokens").mock(
            return_value=httpx.Response(200, json={"input_tokens": 8})
        )
        [r] = await svc.check([item.credential.id], active=True)
    assert "max_tokens" not in json.loads(post.calls.last.request.content)
    assert r.result.overall is Overall.green
    assert (
        r.result.funds.value.state is FundsState.unknown
    )  # undocumented whether it sees no-credit
    svc.close()


async def test_openai_gemini_xai_probes(clock: Clock) -> None:
    svc = service(clock)
    oa = svc.add(fake("sk-proj-", 100)).credential.id
    gm = svc.add(fake_aq()).credential.id
    xa = svc.add(fake("xai-")).credential.id
    with respx.mock as router:
        router.get("https://api.openai.com/v1/models").mock(
            return_value=httpx.Response(
                200,
                json={
                    "data": [
                        {"id": "gpt-5.5"},
                        {"id": "text-embedding-3-large"},
                        {"id": "text-embedding-3-small"},
                    ]
                },
            )
        )
        oa_post = router.post("https://api.openai.com/v1/embeddings").mock(
            return_value=httpx.Response(
                429, json=fixture("openai", "credit_balance_exhausted")["body"]
            )
        )
        router.get("https://generativelanguage.googleapis.com/v1beta/models").mock(
            return_value=httpx.Response(
                200,
                json={
                    "models": [
                        {
                            "name": "models/gemini-3.8-flash",
                            "supportedGenerationMethods": ["generateContent"],
                        },
                        {
                            "name": "models/gemini-3.5-flash-lite",
                            "supportedGenerationMethods": ["generateContent"],
                        },
                        {
                            "name": "models/gemini-embedding-2",
                            "supportedGenerationMethods": ["embedContent"],
                        },
                    ]
                },
            )
        )
        gm_post = router.post(
            url__regex=r".*/v1beta/models/gemini-3\.5-flash-lite:generateContent"
        ).mock(return_value=httpx.Response(402, json=fixture("gemini", "payment_required")["body"]))
        router.get("https://api.x.ai/v1/models").mock(
            return_value=httpx.Response(
                200,
                json={
                    "data": [
                        {"id": "grok-4.6"},
                        {"id": "grok-4.20-0309-non-reasoning"},
                        {"id": "grok-4.20-0309-reasoning"},
                    ]
                },
            )
        )
        xa_post = router.post("https://api.x.ai/v1/chat/completions").mock(
            return_value=httpx.Response(
                200, json={"id": "c1", "choices": [{"message": {"content": "."}}]}
            )
        )
        items = {i.credential.id: i for i in await svc.check(active=True)}
    assert json.loads(oa_post.calls.last.request.content) == {
        "model": "text-embedding-3-small",
        "input": "ping",
    }
    assert json.loads(gm_post.calls.last.request.content)["generationConfig"] == {
        "maxOutputTokens": 1
    }
    assert json.loads(xa_post.calls.last.request.content)["model"] == "grok-4.20-0309-non-reasoning"
    assert json.loads(xa_post.calls.last.request.content)["max_tokens"] == 1
    assert items[oa].result.overall is Overall.red
    assert items[gm].result.overall is Overall.red
    assert items[xa].result.overall is Overall.green
    svc.close()


async def test_hourly_limit_manual_force_and_scheduler(clock: Clock) -> None:
    svc = service(clock, '[probes]\nanthropic_model = "claude-haiku-5-5"\n')
    item = svc.add(fake("sk-ant-api03-"))
    cid = item.credential.id
    svc.update(cid, active_probe=True)
    with respx.mock as router:
        post = router.post("https://api.anthropic.com/v1/messages").mock(
            return_value=httpx.Response(200, json=MESSAGE_OK)
        )
        router.get("https://api.anthropic.com/v1/models").mock(
            return_value=httpx.Response(200, json=anthropic_models())
        )
        await svc.check([cid], active=True)
        clock.advance(minutes=10)
        [blocked] = await svc.check([cid], active=True)
        assert post.call_count == 1
        assert blocked.probe_next_at == clock.now + timedelta(minutes=50)
        [forced] = await svc.check([cid], active=True, force_probe=True)  # after a top-up
        assert post.call_count == 2
        assert forced.probe_next_at is None
        # The scheduler never skips the limit: a probe 0 min ago -> it runs a passive check.
        clock.advance(hours=6)
        await svc.check([cid], scheduled=True)
        assert post.call_count == 3  # 6 h later: allowed, and active_probe is on
        clock.advance(minutes=5)
        await svc.check([cid], scheduled=True, force_probe=True)
        assert post.call_count == 3, "scheduled checks never force a probe"
    svc.close()


async def test_admin_keys_never_probe(clock: Clock) -> None:
    svc = service(clock)
    item = svc.add(fake("sk-admin-", 80))
    assert not svc.can_probe(item.credential)
    with respx.mock as router:
        router.route(host="api.openai.com").mock(
            return_value=httpx.Response(200, json=fixture("openai", "admin_api_keys_ok")["body"])
        )
        [r] = await svc.check([item.credential.id], active=True)
    assert r.result.mode == "passive"
    svc.close()


def test_probe_costs_from_the_dated_price_table() -> None:
    probes = load_probes()
    assert set(probes) == {
        ProviderId.anthropic,
        ProviderId.openai,
        ProviderId.gemini,
        ProviderId.xai,
    }
    a = probes[ProviderId.anthropic]
    assert a.usd_per_probe() == Decimal("0.0000015")  # 10 x 0.10/M + 1 x 0.50/M
    assert month_label(a.usd_per_month(6)) == "< 0.01"
    assert month_label(Decimal("0.0101")) == "0.02"  # rounded up
    assert all(p.prices_checked.isoformat() == "2026-11-06" for p in probes.values())


def test_now_is_fixed() -> None:
    assert Clock().now == datetime(2026, 11, 4, 12, 0, tzinfo=UTC)
