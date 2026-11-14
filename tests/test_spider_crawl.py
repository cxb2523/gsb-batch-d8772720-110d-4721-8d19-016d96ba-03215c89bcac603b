"""Acceptance tests for spider_crawl collection accounting (crawl_status)
and the resume entry point, backed by a local self-made HTTP server."""
from __future__ import annotations

import asyncio
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from the_big_brother.modules.spider_crawl import spider_crawl, spider_crawl_resume


def run(coro):
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()
        asyncio.set_event_loop(asyncio.new_event_loop())


class _Site:
    """A throwaway local HTTP site built from a {path: (status, body)} map."""

    def __init__(self, routes):
        self.routes = routes
        self.requests = []  # every GET path the server saw, in order
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                outer.requests.append(self.path)
                status, body = outer.routes.get(self.path, (404, "not found"))
                payload = body.encode()
                self.send_response(status)
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def get_count(self, path):
        return sum(1 for p in self.requests if p == path)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


@pytest.fixture
def site():
    made = []

    def make(routes):
        s = _Site(routes)
        made.append(s)
        return s

    yield make
    for s in made:
        s.close()


def make_linked_site(num_links, bad_paths=(), with_backlink=False):
    """Index page linking to num_links subpages; some subpages return 500."""
    routes = {}
    links = "".join(f'<a href="/p/{i}">p{i}</a>' for i in range(num_links))
    routes["/"] = (200, f"<html><body>{links}</body></html>")
    for i in range(num_links):
        path = f"/p/{i}"
        if path in bad_paths:
            routes[path] = (500, "boom")
        else:
            back = '<a href="/">home</a>' if with_backlink else ""
            routes[path] = (200, f"<html><body>page {i}{back}</body></html>")
    return routes


# ---------------------------------------------------------------- budget cap

def test_budget_exhausted_reports_unvisited_in_queue_order(site):
    s = site(make_linked_site(30))
    result = run(spider_crawl(s.base_url, max_depth=2, max_pages=5))

    cs = result["crawl_status"]
    assert result["pages_crawled"] == 5
    assert cs["visited_count"] == 5
    assert cs["completed"] is False
    assert cs["queued_remaining"] == 26
    assert cs["unvisited_total"] == 26
    assert cs["truncated"] is False
    assert len(cs["unvisited"]) == 26

    # Queue order preserved, every entry flagged budget_exhausted, no dupes.
    urls = [e["url"] for e in cs["unvisited"]]
    assert urls == [f"{s.base_url}/p/{i}" for i in range(4, 30)]
    assert len(set(urls)) == len(urls)
    assert all(e["reason"] == "budget_exhausted" for e in cs["unvisited"])
    assert all(e["depth"] == 1 for e in cs["unvisited"])


def test_unvisited_list_truncated_over_fifty(site):
    s = site(make_linked_site(70))
    result = run(spider_crawl(s.base_url, max_depth=2, max_pages=2))

    cs = result["crawl_status"]
    assert cs["completed"] is False
    assert cs["queued_remaining"] == 69
    assert cs["unvisited_total"] == 69
    assert cs["truncated"] is True
    assert len(cs["unvisited"]) == 50
    assert cs["unvisited"][0]["url"] == f"{s.base_url}/p/1"


def test_complete_crawl_has_empty_unvisited(site):
    s = site(make_linked_site(5))
    result = run(spider_crawl(s.base_url, max_depth=2, max_pages=20))

    cs = result["crawl_status"]
    assert cs["completed"] is True
    assert cs["visited_count"] == 6
    assert cs["queued_remaining"] == 0
    assert cs["unvisited"] == []
    assert cs["unvisited_total"] == 0
    assert cs["truncated"] is False


# ------------------------------------------------------------- fetch failures

def test_fetch_failed_recorded_and_not_counted_as_visited(site):
    bad = {"/p/1", "/p/3"}
    s = site(make_linked_site(5, bad_paths=bad))
    result = run(spider_crawl(s.base_url, max_depth=2, max_pages=20))

    cs = result["crawl_status"]
    # index + 3 healthy pages; the two 500s must not be counted
    assert result["pages_crawled"] == 4
    assert cs["visited_count"] == 4
    assert cs["completed"] is False
    assert cs["queued_remaining"] == 0

    failed = [e for e in cs["unvisited"] if e["reason"] == "fetch_failed"]
    assert len(failed) == 2
    assert {e["url"] for e in failed} == {f"{s.base_url}/p/1", f"{s.base_url}/p/3"}
    assert all(e["http_status"] == 500 for e in failed)
    assert all(e["depth"] == 1 for e in failed)
    assert cs["unvisited_total"] == 2


def test_unreachable_host_reports_http_status_zero():
    # Port 1 on localhost is effectively never listening -> connection error.
    result = run(spider_crawl("http://127.0.0.1:1/", max_depth=1, max_pages=5))
    cs = result["crawl_status"]
    assert cs["completed"] is False
    assert cs["visited_count"] == 0
    assert cs["unvisited"][0]["reason"] == "fetch_failed"
    assert cs["unvisited"][0]["http_status"] == 0


# --------------------------------------------------------------------- resume

def test_resume_fetches_only_pending_and_completes(site):
    s = site(make_linked_site(10, with_backlink=True))

    first = run(spider_crawl(s.base_url, max_depth=2, max_pages=3))
    cs1 = first["crawl_status"]
    assert cs1["completed"] is False
    assert cs1["visited_count"] == 3  # index + /p/0 + /p/1
    assert cs1["unvisited_total"] == 8

    # Snapshot how often the already-visited pages were hit so far.
    visited_before = {p: s.get_count(p) for p in ["/", "/p/0", "/p/1"]}
    assert visited_before == {"/": 1, "/p/0": 1, "/p/1": 1}

    resumed = run(spider_crawl_resume(
        s.base_url,
        pending_urls=cs1["unvisited"],          # entries as returned by run 1
        skip_urls=cs1["visited_urls"],          # never re-fetch these
        max_depth=2,
        max_pages=20,
    ))

    cs2 = resumed["crawl_status"]
    assert cs2["completed"] is True
    assert cs2["visited_count"] == 8
    assert cs2["unvisited"] == []
    assert resumed["pages_crawled"] == 8

    # Previously successful pages were NOT requested again, even though every
    # resumed page links back to "/".
    for path, count in visited_before.items():
        assert s.get_count(path) == count, f"{path} was re-fetched"

    # Every pending page fetched exactly once across both runs.
    for i in range(10):
        assert s.get_count(f"/p/{i}") == 1


def test_resume_accepts_plain_string_urls(site):
    s = site(make_linked_site(4))
    first = run(spider_crawl(s.base_url, max_depth=2, max_pages=2))
    pending = [e["url"] for e in first["crawl_status"]["unvisited"]]
    assert pending  # sanity

    resumed = run(spider_crawl_resume(
        s.base_url,
        pending_urls=pending,
        skip_urls=first["crawl_status"]["visited_urls"],
        max_depth=2,
        max_pages=20,
    ))
    assert resumed["crawl_status"]["completed"] is True
    assert resumed["crawl_status"]["visited_count"] == 3


# ------------------------------------------------------- legacy field contract

def test_original_fields_preserved(site):
    s = site(make_linked_site(3))
    result = run(spider_crawl(s.base_url, max_depth=2, max_pages=20))
    for key in ("status", "target", "domain", "pages_crawled", "threat_score",
                "risk_level", "exposed_secrets", "security_path_audit",
                "internal_assets", "crawl_status", "crawl_log"):
        assert key in result
    assert result["status"] == "success"
    assert isinstance(result["crawl_log"], list)
    assert len(result["security_path_audit"]) == 9  # sensitive path probes
