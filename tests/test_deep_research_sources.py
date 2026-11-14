"""Offline acceptance tests for per-source outcomes in deep_research.

No network is used: search backends are faked, and directory pages are served
from a local HTTP server that links to (fictional) gateway domains.
"""
import http.server
import threading
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

import app.core as core
import app.research as research


@pytest.fixture()
def isolated_db(tmp_path, monkeypatch):
    """Keep each test on its own SQLite file so 'already known' is predictable."""
    db = tmp_path / "providers.db"
    monkeypatch.setattr(core, "DB_PATH", db)
    core.init_db()
    return db


@pytest.fixture()
def local_directory():
    """Serve one small HTML page of directory links over loopback."""
    html = b"""
    <html><body>
      <a href="https://brand-new-gateway.ai/register">\xe6\xb3\xa8\xe5\x86\x8c</a>
      <a href="https://second-fresh-relay.ai/" rel="nofollow">free api</a>
      <a href="https://unrelated-blog.example/post">read more</a>
    </body></html>
    """

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(html)))
            self.end_headers()
            self.wfile.write(html)

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}/dir"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def _sources_by_name(result):
    return {s["name"]: s for s in result["sources"]}


def _scan_urls(m_scan):
    return [u for c in m_scan.await_args_list for u in (c.args[0] if c.args else [])]


async def _run(queries=("q",), directories=(), max_context_pages=0, max_scan=50):
    async def fake_scan(urls, source="seed"):
        return [core.Finding(url=u, domain=core.canonical_domain(u), alive=True, source=source)
                for u in urls]

    with patch.object(research, "QUERIES", list(queries)), \
         patch.object(research, "DIRECTORIES", list(directories)), \
         patch.object(core, "scan_many", new_callable=AsyncMock) as m_scan:
        m_scan.side_effect = fake_scan
        res = await research.deep_research(max_context_pages=max_context_pages, max_scan=max_scan)
    return res, m_scan


@pytest.mark.asyncio
async def test_error_empty_and_ok_backends_are_distinguished(isolated_db):
    async def boom(client, q):
        raise RuntimeError("backend exploded")

    async def empty(client, q):
        return []

    async def fresh(client, q):
        return ["https://brand-new-gateway.ai/", "https://brand-new-gateway.ai/"]

    async def timeout(client, q):
        raise TimeoutError("timed out")

    async def skipped(client, q):
        raise research.SourceSkipped("BRAVE_SEARCH_API_KEY not set")

    with patch.object(research, "bing_search", boom), \
         patch.object(research, "ddg_search", empty), \
         patch.object(research, "searxng_search", fresh), \
         patch.object(research, "mojeek_search", timeout), \
         patch.object(research, "brave_search", skipped), \
         patch.object(research, "github_feed", AsyncMock(return_value=[])), \
         patch.object(research, "linuxdo_feed", AsyncMock(return_value=[])):
        res, m_scan = await _run()

    src = _sources_by_name(res)

    assert src["bing"]["status"] == research.STATUS_ERROR
    assert "backend exploded" in src["bing"]["error"]
    assert src["duckduckgo"]["status"] == research.STATUS_EMPTY
    assert src["duckduckgo"]["error"] == ""
    assert src["searxng"]["status"] == research.STATUS_OK
    assert src["searxng"]["candidates"] == 1          # URL deduped within the source
    assert src["mojeek"]["status"] == research.STATUS_ERROR
    assert "TimeoutError" in src["mojeek"]["error"]
    assert src["brave"]["status"] == research.STATUS_SKIPPED
    assert src["brave"]["error"]

    # The healthy backend's domain still got scanned — one failure did not abort the pass.
    scanned = _scan_urls(m_scan)
    assert any("brand-new-gateway.ai" in u for u in scanned)
    assert res["scanned"] == 1
    assert res["alive"] == 1
    assert "brand-new-gateway.ai" in res["new_domains"]

    # Existing top-level fields keep their meaning.
    assert res["raw_hits"] == 2
    assert res["gateway_candidates"] == 1
    assert res["new_candidates"] == 1
    assert res["search_backends_with_results"] == 1

    assert res["source_summary"]["error"] >= 2
    assert res["source_summary"]["ok"] >= 1
    assert res["source_summary"]["skipped"] == 1
    assert res["source_summary"]["attempted"] == len(res["sources"])


@pytest.mark.asyncio
async def test_dedup_counts_known_domains_and_in_round_duplicates(isolated_db):
    core.save_finding(core.Finding(url="https://already-known.ai", domain="already-known.ai",
                                   source="seed", alive=True))

    async def with_known(client, q):
        return ["https://already-known.ai/register?x=1",
                "https://already-known.ai/register?x=1",
                "https://fresh-one.ai",
                "https://not-a-gateway-blog.example/post"]

    async def overlapping(client, q):
        return ["https://fresh-one.ai/login", "https://fresh-two.ai"]

    with patch.object(research, "bing_search", with_known), \
         patch.object(research, "ddg_search", overlapping), \
         patch.object(research, "searxng_search", AsyncMock(return_value=[])), \
         patch.object(research, "mojeek_search", AsyncMock(return_value=[])), \
         patch.object(research, "brave_search", AsyncMock(return_value=[])), \
         patch.object(research, "github_feed", AsyncMock(return_value=[])), \
         patch.object(research, "linuxdo_feed", AsyncMock(return_value=[])):
        res, _ = await _run()

    dedup = res["dedup"]
    # already-known.ai is a pre-existing DB domain; fresh-one.ai repeats across sources.
    assert dedup["already_known_domain_skipped"] == 1
    assert dedup["duplicate_in_round"] >= 1
    assert dedup["invalid_or_non_gateway"] >= 1          # the .example blog link
    assert dedup["new_candidates_total"] == res["new_candidates"]
    assert dedup["new_candidates_total"] >= 2
    # Per-source rows also show the known-domain gap.
    src = _sources_by_name(res)
    assert src["bing"]["candidates"] == 2                 # already-known + fresh-one
    assert src["bing"]["new_candidates"] == 1             # already-known.ai was skipped
    assert src["duckduckgo"]["new_candidates"] == 2       # fresh-one.ai/login + fresh-two.ai
    # raw_hits == everything each source returned (duplicates included).
    assert dedup["raw_hits"] == res["raw_hits"] == 6


@pytest.mark.asyncio
async def test_directories_report_ok_and_error_independently(isolated_db, local_directory):
    dead_dir = "http://127.0.0.1:9/unreachable"

    async def empty_backend(client, q):
        return []

    with patch.object(research, "bing_search", empty_backend), \
         patch.object(research, "ddg_search", empty_backend), \
         patch.object(research, "searxng_search", empty_backend), \
         patch.object(research, "mojeek_search", empty_backend), \
         patch.object(research, "brave_search", empty_backend), \
         patch.object(research, "github_feed", AsyncMock(return_value=[])), \
         patch.object(research, "linuxdo_feed", AsyncMock(return_value=[])):
        res, m_scan = await _run(directories=(local_directory, dead_dir))

    dir_sources = [s for s in res["sources"] if s["kind"] == "directory"]
    assert len(dir_sources) == 2
    good = next(s for s in dir_sources if s["url"] == local_directory)
    bad = next(s for s in dir_sources if s["url"] == dead_dir)

    assert good["status"] == research.STATUS_OK
    assert good["candidates"] == 2
    assert bad["status"] == research.STATUS_ERROR
    assert bad["error"]

    # The reachable directory's gateways still reached the scanner.
    scanned = _scan_urls(m_scan)
    assert any("brand-new-gateway.ai" in u for u in scanned)
    assert any("second-fresh-relay.ai" in u for u in scanned)
    assert "brand-new-gateway.ai" in res["new_domains"]


@pytest.mark.asyncio
async def test_feeds_are_isolated_from_backend_failures(isolated_db):
    async def boom(client, q):
        raise RuntimeError("search down")

    async def feed(client):
        return ["https://feed-found-gateway.ai"]

    with patch.object(research, "bing_search", boom), \
         patch.object(research, "ddg_search", boom), \
         patch.object(research, "searxng_search", boom), \
         patch.object(research, "mojeek_search", boom), \
         patch.object(research, "brave_search", boom), \
         patch.object(research, "github_feed", feed), \
         patch.object(research, "linuxdo_feed", AsyncMock(return_value=[])):
        res, m_scan = await _run()

    src = _sources_by_name(res)
    assert src["bing"]["status"] == research.STATUS_ERROR
    assert src["github"]["status"] == research.STATUS_OK
    assert src["github"]["candidates"] == 1
    assert src["linux.do"]["status"] == research.STATUS_EMPTY
    scanned = _scan_urls(m_scan)
    assert any("feed-found-gateway.ai" in u for u in scanned)
    assert res["source_summary"]["error"] >= 1


@pytest.mark.asyncio
async def test_unexpected_exception_in_one_backend_does_not_abort_pass(isolated_db):
    """A backend raising something exotic (not just httpx errors) is contained."""
    class Weird(Exception):
        pass

    async def weird(client, q):
        raise Weird("kaboom")

    async def ok(client, q):
        return ["https://survivor-gateway.ai"]

    with patch.object(research, "bing_search", weird), \
         patch.object(research, "ddg_search", ok), \
         patch.object(research, "searxng_search", AsyncMock(return_value=[])), \
         patch.object(research, "mojeek_search", AsyncMock(return_value=[])), \
         patch.object(research, "brave_search", AsyncMock(return_value=[])), \
         patch.object(research, "github_feed", AsyncMock(return_value=[])), \
         patch.object(research, "linuxdo_feed", AsyncMock(return_value=[])):
        res, m_scan = await _run(queries=("q1", "q2"))

    src = _sources_by_name(res)
    assert src["bing"]["status"] == research.STATUS_ERROR
    assert src["bing"]["attempts"] == 2 and src["bing"]["failed_attempts"] == 2
    assert "kaboom" in src["bing"]["error"]
    assert src["duckduckgo"]["status"] == research.STATUS_OK
    assert src["duckduckgo"]["attempts"] == 2
    assert "survivor-gateway.ai" in res["new_domains"]


def test_api_returns_per_source_detail(isolated_db):
    """The HTTP endpoint must expose the same per-source breakdown."""
    from fastapi.testclient import TestClient
    from app.main import app

    payload = {
        "raw_hits": 3, "gateway_candidates": 2, "new_candidates": 1, "scanned": 1, "alive": 1,
        "sources": [
            {"kind": "search_backend", "name": "bing", "status": "ok",
             "candidates": 1, "new_candidates": 1, "raw_results": 2,
             "attempts": 1, "failed_attempts": 0, "error": ""},
            {"kind": "search_backend", "name": "mojeek", "status": "error",
             "candidates": 0, "new_candidates": 0, "raw_results": 0,
             "attempts": 1, "failed_attempts": 1, "error": "TimeoutError: timed out"},
        ],
        "source_summary": {"attempted": 2, "ok": 1, "empty": 0, "error": 1, "skipped": 0},
        "dedup": {"duplicate_in_round": 1, "already_known_domain_skipped": 1},
    }
    with patch("app.main.deep_research", new_callable=AsyncMock) as m:
        m.return_value = payload
        r = TestClient(app).post("/api/deep-research")

    assert r.status_code == 200
    body = r.json()
    assert body["source_summary"]["error"] == 1
    assert {s["name"] for s in body["sources"]} == {"bing", "mojeek"}
    assert body["dedup"]["already_known_domain_skipped"] == 1
