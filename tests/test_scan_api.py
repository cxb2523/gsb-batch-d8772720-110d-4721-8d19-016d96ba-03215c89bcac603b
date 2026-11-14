"""mecha scan from the dashboard: background scan, Stop, report kept 30 minutes, locations.

Same rules as tests/test_scan.py: temporary trees with made-up keys, any read outside the
tree fails, and so does any network access.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from mecha.api import routes
from mecha.api.routes import ApiContext
from mecha.cli import app as cli_app
from mecha.core.demo import DEMO_HOME, DemoService
from mecha.core.paths import db_path
from mecha.core.service import MechaService
from mecha.scan import fsio, walk
from mecha.scan.places import Env
from mecha.server import create_app
from mecha.store.db import open_store
from tests.fakes import body
from tests.test_scan import ant, no_network, only_inside_tmp, tree  # noqa: F401 - fixtures

pytestmark = pytest.mark.usefixtures("only_inside_tmp", "no_network")

PORT = 7879
TOKEN = "scan-api-test-token"  # session token for the test app, not a credential
AUTH = {"Authorization": f"Bearer {TOKEN}"}
CANARY = "sk-proj-CANARYDASH" + body(140)


class Recorder:
    """Every event the bus publishes, with the thread it was published from."""

    def __init__(self, ctx: ApiContext) -> None:
        self.events: list[dict[str, Any]] = []
        self.threads: set[int] = set()
        original = ctx.bus.publish

        def publish(event: dict[str, Any]) -> None:
            self.threads.add(threading.get_ident())
            self.events.append(event)
            original(event)

        ctx.bus.publish = publish  # type: ignore[method-assign]

    def types(self) -> list[str]:
        return [e["type"] for e in self.events]


def make_client(ctx: ApiContext) -> Iterator[TestClient]:
    app = create_app(token=TOKEN, port=PORT, api=ctx)
    with TestClient(app, base_url=f"http://127.0.0.1:{PORT}", headers=AUTH) as client:
        yield client


@pytest.fixture
def home(tree: Path) -> Path:  # noqa: F811
    return tree / "home"


@pytest.fixture
def api(home: Path) -> Iterator[tuple[TestClient, ApiContext]]:
    service = MechaService(lambda: open_store(db_path(), None))
    service.scan_env = Env(home=home, platform="linux")
    ctx = ApiContext(service=service)
    yield from ((c, ctx) for c in make_client(ctx))
    service.close()


def wait_done(client: TestClient, timeout: float = 20.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = client.get("/api/scan").json()
        if not state["running"]:
            return state  # type: ignore[no-any-return]
        time.sleep(0.02)
    raise AssertionError("the scan did not finish")


def by_path(report: dict[str, Any], name: str) -> list[dict[str, Any]]:
    return [f for f in report["findings"] if Path(f["path"]).name == name]


def test_scan_finds_imports_and_never_returns_a_secret(
    api: tuple[TestClient, ApiContext], home: Path, caplog: pytest.LogCaptureFixture
) -> None:
    client, ctx = api
    caplog.set_level(logging.DEBUG)
    stored = ant()
    r = client.post("/api/credentials", json={"secret": stored})
    cid = r.json()["credential"]["id"]
    (home / ".zsh_history").write_text(f": 1:0;export ANTHROPIC_API_KEY={stored}\n")
    (home / "proj").mkdir()
    (home / "proj" / ".env").write_text(f"OPENAI_API_KEY={CANARY}  # do not share\n")
    events = Recorder(ctx)
    bodies: list[str] = []

    r = client.post("/api/scan", json={})
    assert r.status_code == 202
    state = wait_done(client)
    bodies.append(json.dumps(state))
    report = state["report"]
    assert report["home"] == str(home)
    assert report["store_checked"] is True
    history = by_path(report, ".zsh_history")[0]
    assert history["stored_id"] == cid
    assert history["severity"] == "amber"
    assert history["not_importable"] == "duplicate"
    found = by_path(report, ".env")[0]
    assert found["importable"] is True
    assert found["stored_id"] is None
    assert events.types()[0] == "scan_started"
    assert "scan_done" in events.types()
    assert "credentials_changed" in events.types()

    # The stored key's card turns amber and its sheet can say where.
    listing = client.get("/api/credentials").json()
    bodies.append(json.dumps(listing))
    item = next(c for c in listing["credentials"] if c["credential"]["id"] == cid)
    assert "exposed_in_plaintext" in [x["code"] for x in item["result"]["reasons"]]
    where = client.get(f"/api/credentials/{cid}/exposures").json()
    bodies.append(json.dumps(where))
    assert [Path(e["path"]).name for e in where["exposures"]] == [".zsh_history"]
    assert where["exposures"][0]["risks"] == ["shell_history"]

    r = client.post("/api/scan/import", json={"ids": [found["id"], history["id"]]})
    bodies.append(r.text)
    results = r.json()["results"]
    assert results[0]["ok"] is True
    assert results[1] == {"id": history["id"], "ok": False, "code": "duplicate"}
    after = client.get("/api/scan").json()
    bodies.append(json.dumps(after))
    assert by_path(after["report"], ".env")[0]["stored_id"] == results[0]["credential_id"]

    for text in [*bodies, json.dumps(events.events), caplog.text]:
        assert CANARY not in text
        assert CANARY[12:40] not in text
        assert stored not in text
    for event in events.events:  # events say what changed, never where
        assert str(home) not in json.dumps(event)


def test_progress_is_published_on_the_loop_and_throttled(
    api: tuple[TestClient, ApiContext], home: Path
) -> None:
    client, ctx = api
    for i in range(400):
        (home / f"f{i}.txt").write_text("nothing here\n")
    real = fsio.prefilter

    def slow(path: Path) -> tuple[bool, bool]:
        time.sleep(0.003)  # ~1.2 s in all: several progress windows
        return real(path)

    events = Recorder(ctx)
    loop_thread: list[int] = []
    original_create = routes.asyncio.create_task

    def create_task(coro: Any) -> Any:
        loop_thread.append(threading.get_ident())
        return original_create(coro)

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(fsio, "prefilter", slow)
        mp.setattr(routes.asyncio, "create_task", create_task)
        started = time.monotonic()
        client.post("/api/scan", json={})
        wait_done(client)
        took = time.monotonic() - started
    progress = [e for e in events.events if e["type"] == "scan_progress"]
    assert progress, "progress was published"
    assert len(progress) <= took / routes.SCAN_PROGRESS_SECONDS + 1
    assert [e["files"] for e in progress] == sorted(e["files"] for e in progress)
    assert events.threads == set(loop_thread), "the bus is only touched from the event loop"


class Gate:
    """Holds the scan on its first file until the test lets it go."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.reached = threading.Event()
        self.release = threading.Event()
        real = fsio.prefilter

        def held(path: Path) -> tuple[bool, bool]:
            self.reached.set()
            assert self.release.wait(10)
            return real(path)

        monkeypatch.setattr(fsio, "prefilter", held)


def test_stop_cancels_and_keeps_nothing(
    api: tuple[TestClient, ApiContext], home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, ctx = api
    stored = ant()
    cid = client.post("/api/credentials", json={"secret": stored}).json()["credential"]["id"]
    for i in range(5):
        (home / f"k{i}.env").write_text(f"ANTHROPIC_API_KEY={stored}\n")
    gate = Gate(monkeypatch)
    events = Recorder(ctx)
    client.post("/api/scan", json={})
    assert gate.reached.wait(10)
    assert client.get("/api/scan").json() == {
        "running": True,
        "protected_option": False,
        "report": None,
    }
    assert client.post("/api/scan", json={}).status_code == 409
    assert client.post(f"/api/credentials/{cid}/exposures/rescan").status_code == 409
    assert client.post("/api/scan/stop").json() == {"stopping": True}
    gate.release.set()
    state = wait_done(client)
    assert state["running"] is False
    assert state["report"] is None
    assert events.events[-1]["type"] == "scan_done"
    assert events.events[-1]["cancelled"] is True
    # A partial scan must not rewrite the stored locations.
    assert client.get(f"/api/credentials/{cid}/exposures").json()["exposures"] == []
    assert client.post("/api/scan/stop").json() == {"stopping": False}


def test_report_is_dropped_after_30_minutes(api: tuple[TestClient, ApiContext], home: Path) -> None:
    client, ctx = api
    (home / ".env").write_text(f"OPENAI_API_KEY={CANARY}\n")
    client.post("/api/scan", json={})
    report = wait_done(client)["report"]
    assert report is not None
    assert ctx.scan_timer is not None, "dropped on time even if nobody asks again"
    assert ctx.scan_timer.when() - ctx.scan_timer._loop.time() > routes.SCAN_TTL_SECONDS - 60  # type: ignore[attr-defined]
    ctx.scan_expires = time.monotonic() - 1  # 30 minutes later
    assert client.get("/api/scan").json()["report"] is None
    assert ctx.scan_report is None
    assert ctx.scan_timer is None
    r = client.post("/api/scan/import", json={"ids": [report["findings"][0]["id"]]})
    assert r.status_code == 404


def test_rescan_reads_only_the_stored_locations(
    api: tuple[TestClient, ApiContext], home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, _ = api
    stored = ant()
    cid = client.post("/api/credentials", json={"secret": stored}).json()["credential"]["id"]
    (home / "a").mkdir()
    (home / "a" / ".env").write_text(f"ANTHROPIC_API_KEY={stored}\n")
    (home / ".zsh_history").write_text(f": 1:0;export ANTHROPIC_API_KEY={stored}\n")
    (home / "untouched.txt").write_text("nothing\n")
    client.post("/api/scan", json={})
    wait_done(client)
    before = client.get(f"/api/credentials/{cid}/exposures").json()["exposures"]
    assert len(before) == 2

    (home / ".zsh_history").write_text(": 1:0;ls\n")  # cleaned up
    opened: list[Path] = []
    real = fsio.open_binary

    def spy(path: Path):  # type: ignore[no-untyped-def]
        opened.append(Path(path).resolve())
        return real(path)

    monkeypatch.setattr(fsio, "open_binary", spy)
    r = client.post(f"/api/credentials/{cid}/exposures/rescan", json={"paths": ["/etc"]})
    assert r.status_code == 200
    after = r.json()["exposures"]
    assert [Path(e["path"]).name for e in after] == [".env"]
    assert set(opened) <= {Path(e["path"]).resolve() for e in before}
    listing = client.get("/api/credentials").json()["credentials"][0]
    assert "exposed_in_plaintext" not in [x["code"] for x in listing["result"]["reasons"]]


def test_no_route_takes_a_path_in_its_url() -> None:
    """URLs reach the access log: only credential ids and small flags travel in them."""
    from mecha.api import health

    api_routes = [r for r in [*routes.router.routes, *health.router.routes]]
    assert all(isinstance(r, APIRoute) for r in api_routes)
    for route in api_routes:
        assert isinstance(route, APIRoute)
        params = {p.name for p in route.dependant.path_params}
        query = {p.name for p in route.dependant.query_params}
        assert params <= {"cred_id"}, route.path
        assert query <= {"force", "limit", "mode"}, route.path
    paths = {r.path for r in api_routes if isinstance(r, APIRoute)}
    assert paths >= {
        "/scan",
        "/scan/stop",
        "/scan/import",
        "/credentials/{cred_id}/exposures",
        "/credentials/{cred_id}/exposures/rescan",
    }


def test_demo_scan_never_touches_the_disk(monkeypatch: pytest.MonkeyPatch) -> None:
    """mecha serve --demo: someone recording a video would show their own folders."""

    def forbidden(*_a: object, **_k: object) -> None:
        raise AssertionError("the demo read this machine's disk")

    monkeypatch.setattr(walk.Scanner, "run", forbidden)
    monkeypatch.setattr(walk, "read_token", forbidden)
    monkeypatch.setattr(fsio, "open_binary", forbidden)
    service = DemoService()
    service.scan_seconds = 0
    ctx = ApiContext(service=service, demo=True)
    for client in make_client(ctx):
        client.post("/api/scan", json={"include_protected": True})
        report = wait_done(client)["report"]
        assert report["home"] == str(DEMO_HOME)
        assert {Path(f["path"]).is_relative_to(DEMO_HOME) for f in report["findings"]} == {True}
        importable = [f for f in report["findings"] if f["importable"]]
        assert importable
        r = client.post("/api/scan/import", json={"ids": [importable[0]["id"]]})
        assert r.json()["results"][0]["ok"] is True
        stored = next(f for f in report["findings"] if f["stored_id"])
        where = client.get(f"/api/credentials/{stored['stored_id']}/exposures").json()
        assert where["home"] == str(DEMO_HOME)
        assert len(where["exposures"]) == 2
        r = client.post(f"/api/credentials/{stored['stored_id']}/exposures/rescan")
        assert len(r.json()["exposures"]) == 2


def test_cli_where(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    stored = ant()
    runner = CliRunner()
    service = MechaService(lambda: open_store(db_path(), None))
    try:
        cid = service.add(stored).credential.id
    finally:
        service.close()
    r = runner.invoke(cli_app, ["where", cid[:8]])
    assert r.exit_code == 0
    assert "not found in plaintext" in r.output
    (home / ".zsh_history").write_text(f": 1:0;export ANTHROPIC_API_KEY={stored}\n")
    assert runner.invoke(cli_app, ["scan", str(home), "--json"]).exit_code == 1
    r = runner.invoke(cli_app, ["where", cid, "--json"])
    data = json.loads(r.output)
    assert [Path(e["path"]).name for e in data["exposures"]] == [".zsh_history"]
    assert stored not in r.output
    r = runner.invoke(cli_app, ["where", cid])
    assert "~" in r.output
    assert "shell history" in r.output
    (home / ".zsh_history").write_text(": 1:0;ls\n")
    r = runner.invoke(cli_app, ["where", cid, "--rescan", "--json"])
    assert json.loads(r.output)["exposures"] == []


def test_same_key_in_two_files_imports_once_with_both_locations(
    api: tuple[TestClient, ApiContext], home: Path
) -> None:
    client, _ = api
    key = ant()
    (home / "proj").mkdir()
    (home / "proj" / ".env").write_text(f"ANTHROPIC_API_KEY={key}\n")
    (home / ".zsh_history").write_text(f": 1:0;export ANTHROPIC_API_KEY={key}\n")
    client.post("/api/scan", json={})
    report = wait_done(client)["report"]
    ids = [f["id"] for f in report["findings"]]
    assert len(ids) == 2
    results = client.post("/api/scan/import", json={"ids": ids}).json()["results"]
    assert [r["ok"] for r in results] == [True, True]
    cid = results[0]["credential_id"]
    assert results[1]["credential_id"] == cid
    after = client.get("/api/scan").json()["report"]
    assert {f["stored_id"] for f in after["findings"]} == {cid}
    where = client.get(f"/api/credentials/{cid}/exposures").json()
    assert sorted(Path(e["path"]).name for e in where["exposures"]) == [".env", ".zsh_history"]
    assert {e["seen_at"] for e in where["exposures"]} == {after["finished_at"]}
    listing = client.get("/api/credentials").json()["credentials"]
    assert len(listing) == 1
    assert "exposed_in_plaintext" in [x["code"] for x in listing[0]["result"]["reasons"]]


def test_one_chosen_row_marks_every_row_with_that_key(
    api: tuple[TestClient, ApiContext], home: Path
) -> None:
    client, _ = api
    key = ant()
    (home / "a.env").write_text(f"ANTHROPIC_API_KEY={key}\n")
    (home / ".zsh_history").write_text(f": 1:0;export ANTHROPIC_API_KEY={key}\n")
    client.post("/api/scan", json={})
    report = wait_done(client)["report"]
    env_row = next(f for f in report["findings"] if Path(f["path"]).name == "a.env")
    cid = client.post("/api/scan/import", json={"ids": [env_row["id"]]}).json()["results"][0][
        "credential_id"
    ]
    after = client.get("/api/scan").json()["report"]
    assert {f["stored_id"] for f in after["findings"]} == {cid}
    assert {f["not_importable"] for f in after["findings"]} == {"duplicate"}
    where = client.get(f"/api/credentials/{cid}/exposures").json()["exposures"]
    assert len(where) == 2


def test_sqlite_only_on_the_loop_and_files_only_in_a_worker(
    api: tuple[TestClient, ApiContext], home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The connection is opened with check_same_thread=False: a query from the worker
    thread would not fail by itself, so every statement records the thread it ran on."""
    client, ctx = api
    key = ant()
    cid = client.post("/api/credentials", json={"secret": key}).json()["credential"]["id"]
    (home / ".zsh_history").write_text(f": 1:0;export ANTHROPIC_API_KEY={key}\n")
    (home / "new.env").write_text(f"OPENAI_API_KEY={CANARY}\n")
    loop_thread = client.portal.call(threading.get_ident)  # type: ignore[union-attr]
    sql_threads: set[int] = set()
    ctx.service.store.conn.set_trace_callback(lambda _q: sql_threads.add(threading.get_ident()))
    file_threads: set[int] = set()
    real_open = fsio.open_binary

    def spy(path: Path):  # type: ignore[no-untyped-def]
        file_threads.add(threading.get_ident())
        return real_open(path)

    monkeypatch.setattr(fsio, "open_binary", spy)

    client.post("/api/scan", json={})
    report = wait_done(client)["report"]
    new = next(f for f in report["findings"] if Path(f["path"]).name == "new.env")
    assert client.post("/api/scan/import", json={"ids": [new["id"]]}).json()["results"][0]["ok"]
    assert client.post(f"/api/credentials/{cid}/exposures/rescan").status_code == 200
    ctx.service.store.conn.set_trace_callback(None)
    assert sql_threads == {loop_thread}
    assert file_threads, "files were read"
    assert loop_thread not in file_threads, "never on the event loop"
