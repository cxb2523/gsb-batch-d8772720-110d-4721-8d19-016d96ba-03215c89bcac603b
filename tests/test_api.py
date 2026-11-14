"""REST API over the service: CRUD, errors, providers, events and the no-secrets contract."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from mecha.api.routes import ApiContext
from mecha.core.config import parse_config
from mecha.core.events import EventBus
from mecha.core.paths import db_path
from mecha.core.service import MechaService
from mecha.server import create_app
from mecha.store.db import open_store
from tests.fakes import body, fake
from tests.test_error_map import fixture

PORT = 7878
TOKEN = "api-test-token"  # session token for the test app, not a credential
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def api() -> Iterator[tuple[TestClient, ApiContext]]:
    config = parse_config("[http]\nretries = 0\nbackoff_seconds = 0\n")
    service = MechaService(lambda: open_store(db_path(), None), config=config)
    ctx = ApiContext(service=service)
    app = create_app(token=TOKEN, port=PORT, api=ctx)
    with TestClient(app, base_url=f"http://127.0.0.1:{PORT}", headers=AUTH) as client:
        yield client, ctx
    service.close()


def add(client: TestClient, secret: str, **extra: Any) -> dict[str, Any]:
    r = client.post("/api/credentials", json={"secret": secret, **extra})
    assert r.status_code == 201, r.text
    return r.json()  # type: ignore[no-any-return]


def test_crud(api: tuple[TestClient, ApiContext]) -> None:
    client, _ = api
    item = add(client, fake("sk-ant-api03-"), label="prod", tags=["a"])
    cid = item["credential"]["id"]
    assert item["result"]["overall"] == "grey"

    listing = client.get("/api/credentials").json()
    assert listing["schema_version"] == 1
    assert listing["generated_at"]
    assert listing["demo"] is False
    assert [c["credential"]["id"] for c in listing["credentials"]] == [cid]

    r = client.patch(f"/api/credentials/{cid}", json={"label": "staging", "notes": "n"})
    assert r.status_code == 200
    assert r.json()["credential"]["label"] == "staging"
    assert r.json()["credential"]["notes"] == "n"
    r = client.patch(
        f"/api/credentials/{cid}", json={"notes": None, "manual_expires_at": "2027-01-01T00:00:00Z"}
    )
    assert r.json()["credential"]["notes"] is None
    assert r.json()["credential"]["manual_expires_at"].startswith("2027-01-01")
    assert r.json()["credential"]["label"] == "staging", "unsent fields are untouched"

    assert client.delete(f"/api/credentials/{cid}").status_code == 204
    assert client.get("/api/credentials").json()["credentials"] == []
    assert client.delete(f"/api/credentials/{cid}").status_code == 404


def test_patch_never_accepts_the_secret(api: tuple[TestClient, ApiContext]) -> None:
    client, ctx = api
    secret = fake("xai-")
    cid = add(client, secret)["credential"]["id"]
    new = fake("xai-")
    r = client.patch(f"/api/credentials/{cid}", json={"secret": new})
    assert r.status_code == 422
    assert new not in r.text
    assert ctx.service.store.secret(cid) == secret


def test_errors_are_code_and_message(api: tuple[TestClient, ApiContext]) -> None:
    client, _ = api
    secret = fake("sk-proj-", 100)
    existing = add(client, secret)["credential"]["id"]
    r = client.post("/api/credentials", json={"secret": secret})
    assert r.status_code == 409
    assert r.json()["code"] == "duplicate"
    assert r.json()["existing_id"] == existing

    r = client.post("/api/credentials", json={"secret": fake("sk-", 48)})
    assert r.status_code == 422
    assert r.json()["code"] == "ambiguous_provider"
    assert r.json()["candidates"] == ["openai"]

    r = client.post("/api/credentials", json={"secret": fake("sk-ant-ort01-", 95)})
    assert r.status_code == 422
    assert "refresh token" in r.json()["message"]

    r = client.get("/api/credentials/NOPE1234/history")
    assert r.status_code == 404
    assert set(r.json()) == {"code", "message"}


def test_detect_stores_nothing(api: tuple[TestClient, ApiContext]) -> None:
    client, ctx = api
    r = client.post("/api/detect", json={"secret": fake("AIza", 35)})
    assert r.status_code == 200
    assert r.json()["retiring"] is True
    assert ctx.service.store.all() == []


def test_check_and_history(api: tuple[TestClient, ApiContext]) -> None:
    client, _ = api
    cid = add(client, fake("xai-"))["credential"]["id"]
    fx = fixture("xai", "api_key_ok")
    with respx.mock(assert_all_called=False) as router:
        router.route(host="api.x.ai").mock(return_value=httpx.Response(200, json=fx["body"]))
        router.route(host="testserver").pass_through()
        r = client.post(f"/api/credentials/{cid}/check")
    assert r.status_code == 200
    assert r.json()["result"]["overall"] == "green"
    hist = client.get(f"/api/credentials/{cid}/history?limit=5").json()["history"]
    assert len(hist) == 1
    assert hist[0]["overall"] == "green"


def test_providers_only_promise_what_is_implemented(api: tuple[TestClient, ApiContext]) -> None:
    client, _ = api
    providers = {p["id"]: p for p in client.get("/api/providers").json()["providers"]}
    assert set(providers) == {"anthropic", "openai", "gemini", "xai", "openrouter"}
    assert providers["anthropic"]["expiry"] == "admin_key"
    assert providers["xai"]["funds"] == "management_key"
    assert providers["openrouter"]["funds"] == "yes"
    assert providers["gemini"]["expiry"] == "no"


async def test_event_stream_ends_when_bus_closes() -> None:
    bus = EventBus()
    received: list[dict[str, Any] | None] = []

    async def reader() -> None:
        async for event in bus.subscribe(keepalive=0.05):
            received.append(event)

    task = asyncio.create_task(reader())
    await asyncio.sleep(0.01)
    bus.publish({"type": "credentials_changed", "id": "x"})
    await asyncio.sleep(0.12)  # at least one keepalive
    bus.close()
    await asyncio.wait_for(task, 1)
    assert received[0] == {"type": "hello", "boot": bus.boot, "seq": 0}
    assert {"type": "credentials_changed", "id": "x", "seq": 1} in received
    assert None in received
    assert bus.subscribers == 0


test_event_stream_ends_when_bus_closes = pytest.mark.anyio(test_event_stream_ends_when_bus_closes)


async def test_events_carry_a_sequence_and_hello_says_where_the_bus_is() -> None:
    bus = EventBus()
    assert bus.boot != EventBus().boot  # a restart never matches by chance
    bus.publish({"type": "credentials_changed"})  # before anyone listens: only counted
    bus.publish({"type": "credentials_changed"})
    assert bus.position() == {"boot": bus.boot, "seq": 2}
    stream = bus.subscribe(keepalive=5)
    assert await anext(stream) == {"type": "hello", "boot": bus.boot, "seq": 2}
    bus.publish({"type": "check_all_done"})
    assert await anext(stream) == {"type": "check_all_done", "seq": 3}
    await stream.aclose()
    assert bus.subscribers == 0  # leaving right after hello does not leak the queue


test_events_carry_a_sequence_and_hello_says_where_the_bus_is = pytest.mark.anyio(
    test_events_carry_a_sequence_and_hello_says_where_the_bus_is
)


async def test_events_endpoint_streams_and_closes() -> None:
    service = MechaService(lambda: open_store(db_path(), None))
    ctx = ApiContext(service=service)
    app = create_app(token=TOKEN, port=PORT, api=ctx)
    transport = httpx.ASGITransport(app=app)
    lines: list[str] = []
    async with httpx.AsyncClient(
        transport=transport, base_url=f"http://127.0.0.1:{PORT}", headers=AUTH
    ) as client:

        async def read() -> None:
            async with client.stream("GET", "/api/events") as r:
                assert r.headers["content-type"].startswith("text/event-stream")
                async for line in r.aiter_lines():
                    lines.append(line)

        task = asyncio.create_task(read())
        await asyncio.sleep(0.05)
        ctx.bus.publish({"type": "check_all_done"})
        await asyncio.sleep(0.05)
        ctx.bus.close()  # what shutdown does: the stream ends instead of hanging
        await asyncio.wait_for(task, 2)
    service.close()
    assert "event: check_all_done" in lines
    assert any(line.startswith("data: ") for line in lines)
    # The first event says where the bus was when the stream opened.
    first = next(i for i, line in enumerate(lines) if line.startswith("event: "))
    assert lines[first] == "event: hello"
    assert json.loads(lines[first + 1].removeprefix("data: ")) == {
        "type": "hello",
        "boot": ctx.bus.boot,
        "seq": 0,
    }


test_events_endpoint_streams_and_closes = pytest.mark.anyio(test_events_endpoint_streams_and_closes)


def test_listing_says_which_event_position_it_was_computed_at(
    api: tuple[TestClient, ApiContext],
) -> None:
    client, ctx = api
    assert client.get("/api/credentials").json()["events"] == {"boot": ctx.bus.boot, "seq": 0}
    ctx.bus.publish({"type": "credentials_changed"})
    assert client.get("/api/credentials").json()["events"]["seq"] == 1


def test_events_require_the_token(api: tuple[TestClient, ApiContext]) -> None:
    client, _ = api
    assert client.get("/api/events", headers={"Authorization": ""}).status_code == 401


# --- canary: the API never returns, logs or echoes a secret -----------------------------


def test_canary_never_leaves_through_the_api(
    api: tuple[TestClient, ApiContext], caplog: pytest.LogCaptureFixture
) -> None:
    client, _ = api
    caplog.set_level(logging.DEBUG)
    secret = "sk-ant-api03-CANARY" + body(80)
    unknown = "CANARYunknown" + body(40)
    seen: list[str] = []

    def call(method: str, url: str, **kw: Any) -> httpx.Response:
        r = client.request(method, url, **kw)
        seen.append(r.text)
        return r

    cid = call("POST", "/api/credentials", json={"secret": secret}).json()["credential"]["id"]
    call("POST", "/api/credentials", json={"secret": unknown, "provider": "xai"})
    call("GET", "/api/credentials")
    call("POST", "/api/detect", json={"secret": secret})
    call("GET", f"/api/credentials/{cid}/history")
    call("PATCH", f"/api/credentials/{cid}", json={"label": "x"})
    # malformed requests: none of them may echo the input
    call("POST", "/api/credentials", json={"secret": secret, "unexpected": secret})  # extra field
    call("POST", "/api/credentials", json={"secret": secret, "tags": secret})  # wrong type
    call("POST", "/api/credentials", json={"label": secret})  # missing required field
    call("POST", "/api/credentials", json={"secret": secret + "A" * 9000})  # too long
    call("POST", "/api/credentials", json={secret: 1})  # the secret as a JSON key
    call(
        "POST",
        "/api/detect",
        content=f'{{"secret": "{secret}"',
        headers={"content-type": "application/json"},
    )
    call("POST", "/api/credentials", json={"secret": secret})  # duplicate -> 409
    for text in seen:
        for s in (secret, unknown):
            assert s not in text
            assert s[20:44] not in text
    assert secret not in caplog.text
    assert unknown not in caplog.text
    for r_text in seen[6:12]:
        assert json.loads(r_text).keys() <= {"code", "message"}


def test_active_probe_hourly_limit_and_force(api: tuple[TestClient, ApiContext]) -> None:
    client, _ = api
    cid = add(client, fake("xai-"))["credential"]["id"]
    ok = httpx.Response(200, json={"id": "c", "choices": []})
    with respx.mock(assert_all_called=False) as router:
        router.get("https://api.x.ai/v1/models").mock(
            return_value=httpx.Response(
                200, json={"data": [{"id": "grok-4.20-0309-non-reasoning"}]}
            )
        )
        post = router.post("https://api.x.ai/v1/chat/completions").mock(return_value=ok)
        router.route(host="testserver").pass_through()
        assert client.post(f"/api/credentials/{cid}/check?mode=active").status_code == 200
        r = client.post(f"/api/credentials/{cid}/check?mode=active")
        assert r.status_code == 409
        assert r.json()["code"] == "probe_too_soon"
        assert r.json()["next_allowed_at"]
        assert post.call_count == 1
        r = client.post(f"/api/credentials/{cid}/check?mode=active&force=true")  # confirmed
        assert r.status_code == 200
        assert post.call_count == 2


def test_patch_probe_and_budget(api: tuple[TestClient, ApiContext]) -> None:
    client, _ = api
    cid = add(client, fake("sk-proj-", 100))["credential"]["id"]
    r = client.patch(f"/api/credentials/{cid}", json={"active_probe": True})
    assert r.json()["credential"]["active_probe"] is True
    admin = add(client, fake("sk-admin-", 80))["credential"]["id"]
    assert client.patch(f"/api/credentials/{admin}", json={"active_probe": True}).status_code == 422
    budget = {"amount": "50", "currency": "usd", "purchased_at": "2026-11-01T00:00:00Z"}
    r = client.patch(f"/api/credentials/{admin}", json={"manual_budget": budget})
    assert r.json()["credential"]["manual_budget"]["currency"] == "USD"
    r = client.patch(f"/api/credentials/{admin}", json={"manual_budget": None})
    assert r.json()["credential"]["manual_budget"] is None


def test_providers_report_probe_cost(api: tuple[TestClient, ApiContext]) -> None:
    client, _ = api
    providers = {p["id"]: p for p in client.get("/api/providers").json()["providers"]}
    probe = providers["anthropic"]["probe"]
    assert probe["model"] == "claude-haiku-5-5"
    assert probe["usd_per_month_label"] == "< 0.01"
    assert probe["prices_checked"] == "2026-11-06"
    assert providers["openrouter"]["probe"] is None


def test_env_preview_and_import(api: tuple[TestClient, ApiContext]) -> None:
    client, _ = api
    a, x = fake("sk-ant-api03-"), fake("xai-")
    existing = fake("sk-proj-", 100)
    add(client, existing)
    content = "\n".join(
        [
            "# my app",
            f"ANTHROPIC_API_KEY={a}",
            f'export XAI_API_KEY="{x}"  ',
            f"OPENAI_API_KEY={existing}",
            "DATABASE_URL=postgres://x",
            "GOOGLE_API_KEY=",
            f"SOMETHING_ELSE=sk-ant-ort01-{body(90)}",
        ]
    )
    r = client.post("/api/import/env/preview", json={"content": content})
    entries = r.json()["entries"]
    assert [e["name"] for e in entries] == [
        "ANTHROPIC_API_KEY",
        "XAI_API_KEY",
        "OPENAI_API_KEY",
        "SOMETHING_ELSE",
    ]
    assert entries[2]["duplicate_of"] is not None
    assert not entries[2]["importable"]
    assert not entries[3]["importable"]  # refresh token: never stored
    for secret in (a, x, existing):
        assert secret not in r.text
    r = client.post("/api/import/env", json={"content": content, "select": [0, 2]})
    results = {res["index"]: res for res in r.json()["results"]}
    assert results[0]["ok"] is True
    assert results[2]["ok"] is False
    assert results[2]["code"] == "duplicate"
    assert a not in r.text
    labels = {
        c["credential"]["label"] for c in client.get("/api/credentials").json()["credentials"]
    }
    assert "ANTHROPIC_API_KEY" in labels
    assert "XAI_API_KEY" not in labels  # not selected


def test_link_endpoint(api: tuple[TestClient, ApiContext], tmp_path) -> None:  # type: ignore[no-untyped-def]
    client, _ = api
    gemini = tmp_path / "oauth_creds.json"
    gemini.write_text(json.dumps({"refresh_token": "1//x", "expiry_date": 1, "scope": "s"}))
    r = client.post("/api/linked", json={"tool": "gemini-cli", "path": str(gemini)})
    assert r.status_code == 201
    assert r.json()["credential"]["kind"] == "oauth_file"
    r = client.post(
        "/api/linked", json={"tool": "gemini-cli", "path": str(tmp_path / "missing.json")}
    )
    assert r.status_code == 422
    assert r.json()["code"] == "linked_file"
    cands = client.get("/api/linked/candidates").json()["candidates"]
    assert {c["tool"] for c in cands} == {"codex", "claude-code", "gemini-cli"}
