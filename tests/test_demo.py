"""Demo mode: deterministic fake data, adding/deleting in memory, never a secret, no network."""

from __future__ import annotations

from collections import Counter

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from mecha.api.routes import ApiContext
from mecha.core.demo import DEMO_NOW, DemoService
from mecha.core.models import CredentialKind, Overall
from mecha.server import create_app
from tests.fakes import body

pytestmark = pytest.mark.anyio
TOKEN = "demo-test-token"  # session token for the test app, not a credential


def test_demo_covers_every_state_and_kind_deterministically() -> None:
    first = DemoService().list()
    second = DemoService().list()
    assert len(first) == 20
    assert [i.result.model_dump() for i in first] == [i.result.model_dump() for i in second]
    assert set(Counter(i.result.overall for i in first)) == set(Overall)
    assert {i.credential.kind for i in first} == set(CredentialKind)
    assert all(i.result.checked_at <= DEMO_NOW for i in first)


def test_demo_holds_no_secrets() -> None:
    service = DemoService()
    rows = service.store.conn.execute("SELECT secret_ct FROM credentials").fetchall()
    assert all(r["secret_ct"] is None for r in rows)


async def test_demo_add_check_delete_in_memory_without_network() -> None:
    service = DemoService()
    secret = "sk-ant-api03-DEMOCANARY" + body(80)
    item = service.add(secret, label="Shown in the video")
    assert item.credential.redacted.startswith("sk-ant-api03-")
    row = service.store.conn.execute(
        "SELECT secret_ct FROM credentials WHERE id = ?", (item.credential.id,)
    ).fetchone()
    assert row["secret_ct"] is None, "the secret is never stored, not even in memory"
    dump = "\n".join(service.store.conn.iterdump())
    assert secret not in dump
    assert secret[20:44] not in dump

    with respx.mock(assert_all_called=False) as router:
        route = router.route().mock(return_value=httpx.Response(500))
        [checked] = await service.check([item.credential.id])
    assert not route.called, "demo checks never touch the network"
    assert checked.result.overall is Overall.green
    assert checked.result.http is not None
    assert checked.result.http.endpoint == "GET /v1/models"

    service.remove(item.credential.id)
    assert len(service.list()) == 20


def test_demo_api_add_and_delete() -> None:
    ctx = ApiContext(service=DemoService(), demo=True)
    app = create_app(token=TOKEN, port=7878, api=ctx)
    with TestClient(
        app, base_url="http://127.0.0.1:7878", headers={"Authorization": f"Bearer {TOKEN}"}
    ) as client:
        secret = "xai-DEMOCANARY" + body(60)
        r = client.post("/api/credentials", json={"secret": secret, "label": "video"})
        assert r.status_code == 201
        assert secret not in r.text
        cid = r.json()["credential"]["id"]
        listing = client.get("/api/credentials").json()
        assert listing["demo"] is True
        assert listing["settings"] == {"soon_days": 14, "fuse_horizon_days": 90}
        assert len(listing["credentials"]) == 21
        assert client.delete(f"/api/credentials/{cid}").status_code == 204
        assert client.delete("/api/credentials/01DEMO00000000000000000000").status_code == 204
        assert len(client.get("/api/credentials").json()["credentials"]) == 19
