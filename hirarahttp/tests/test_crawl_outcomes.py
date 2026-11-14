"""pages_outcome fates and resume support for site_map/crawl — fake sites only."""

from __future__ import annotations

import functools
import inspect
import socket

import httpx
import pytest

from hirarahttp import crawl
from hirarahttp.config import HttpConfig
from hirarahttp.crawl import CrawlError, site_map
from hirarahttp.request import http_request as real_http_request


def resolver(host, port, *args, **kwargs):
    address = host if host.replace(".", "").isdigit() else "93.184.216.34"
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, port))]


def html(body: str, title: str = "") -> tuple[int, str, str]:
    return 200, "text/html; charset=utf-8", f"<html><head><title>{title}</title></head><body>{body}</body></html>"


class Site:
    """Serves pages keyed by (host, path); records every request."""

    def __init__(self, pages: dict) -> None:
        self.pages = pages
        self.requests: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        key = (request.headers["host"], request.url.path)
        status, ctype, body = self.pages.get(key, (404, "text/plain", "missing"))
        if request.method == "HEAD":
            body = ""
        return httpx.Response(status, headers={"content-type": ctype}, text=body)

    def patch(self, monkeypatch, *modules):
        fn = functools.partial(real_http_request, resolver=resolver,
                               transport=httpx.MockTransport(self.handler))
        for module in modules:
            monkeypatch.setattr(module, "http_request", fn)


SITE = {
    ("example.com", "/robots.txt"): (200, "text/plain", "User-agent: *\nDisallow: /private\n"),
    ("example.com", "/"): html('<a href="/about">About</a> <a href="/blog/">Blog</a> '
                               '<a href="/private/x">P</a> <img src="/logo.png"> '
                               '<a href="https://other.org/gone">Gone</a> '
                               '<a href="mailto:a@b.c">mail</a>', "Home"),
    ("example.com", "/about"): html('<a href="/">Home</a> <a href="/missing">Broken</a>', "About"),
    ("example.com", "/blog/"): html('<a href="post-1">Post</a>', "Blog"),
    ("example.com", "/blog/post-1"): html("hello", "Post 1"),
    ("example.com", "/logo.png"): (200, "image/png", "png"),
    ("other.org", "/gone"): (410, "text/plain", "gone"),
}

CONFIG = HttpConfig()


def by_url(result: dict) -> dict:
    return {item["url"]: item for item in result["pages_outcome"]}


# --- pages_outcome shape and fates --------------------------------------------

async def test_every_candidate_has_one_outcome_sorted(monkeypatch):
    Site(SITE).patch(monkeypatch, crawl)
    r = await site_map("https://example.com/", config=CONFIG)
    outcome = r["pages_outcome"]
    # One entry per unique same-site candidate, sorted by (depth, url).
    urls = [item["url"] for item in outcome]
    assert urls == sorted(urls, key=lambda u: (by_url(r)[u]["depth"], u))
    assert len(urls) == len(set(urls))
    entries = by_url(r)
    assert set(entries) == {
        "https://example.com/",
        "https://example.com/about",
        "https://example.com/blog/",
        "https://example.com/blog/post-1",
        "https://example.com/missing",
        "https://example.com/private/x",
    }
    # Exact field set per element.
    assert set(outcome[0]) == {"url", "depth", "outcome", "status", "error", "found_on"}
    fetched = {u for u, item in entries.items() if item["outcome"] == "fetched"}
    assert fetched == {
        "https://example.com/",
        "https://example.com/about",
        "https://example.com/blog/",
        "https://example.com/blog/post-1",
        "https://example.com/missing",
    }
    assert entries["https://example.com/"]["depth"] == 0
    assert entries["https://example.com/"]["found_on"] is None
    assert entries["https://example.com/about"]["found_on"] == "https://example.com/"
    assert entries["https://example.com/blog/post-1"]["found_on"] == "https://example.com/blog/"


async def test_fetched_carries_status_and_error(monkeypatch):
    Site(SITE).patch(monkeypatch, crawl)
    r = await site_map("https://example.com/", config=CONFIG)
    entries = by_url(r)
    assert entries["https://example.com/"]["status"] == 200
    assert entries["https://example.com/"]["error"] is None
    missing = entries["https://example.com/missing"]
    assert missing["outcome"] == "fetched" and missing["status"] == 404
    # Non-fetched fates never carry a status.
    blocked = entries["https://example.com/private/x"]
    assert blocked["outcome"] == "robots" and blocked["status"] is None
    assert blocked["error"] is None


async def test_fetch_error_is_still_fetched_outcome(monkeypatch):
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(crawl, "http_request",
                        functools.partial(real_http_request, resolver=resolver,
                                          transport=httpx.MockTransport(boom)))
    r = await site_map("https://example.com/", config=CONFIG, respect_robots=False)
    only = by_url(r)["https://example.com/"]
    assert only["outcome"] == "fetched"
    assert only["status"] is None
    assert "connection refused" in (only["error"] or "")


async def test_robots_outcome_never_requested(monkeypatch):
    site = Site(SITE)
    site.patch(monkeypatch, crawl)
    r = await site_map("https://example.com/", config=CONFIG)
    entries = by_url(r)
    assert entries["https://example.com/private/x"]["outcome"] == "robots"
    assert not any(req.url.path.startswith("/private") for req in site.requests)
    # Assets, off-site links and non-http schemes never become candidates.
    assert all("logo.png" not in u for u in entries)
    assert all("other.org" not in u for u in entries)
    assert r["skipped_by_robots"] == ["https://example.com/private/x"]


async def test_budget_outcome_when_max_pages_hit(monkeypatch):
    site = Site(SITE)
    site.patch(monkeypatch, crawl)
    r = await site_map("https://example.com/", config=CONFIG, max_pages=2)
    entries = by_url(r)
    assert r["count"] == 2 and r["truncated"] is True
    budget = {u for u, item in entries.items() if item["outcome"] == "budget"}
    # Root + about fetched; the remaining queued same-site links wait. The
    # robots-blocked URL never joins the budget queue.
    assert budget == {"https://example.com/blog/", "https://example.com/missing"}
    assert entries["https://example.com/private/x"]["outcome"] == "robots"
    # Nothing from the budget queue was actually requested.
    assert sum(1 for req in site.requests if req.url.path == "/blog/") == 0
    assert sum(1 for req in site.requests if req.url.path == "/missing") == 0
    assert r["unvisited"] == 2


async def test_depth_outcome_for_links_beyond_max_depth(monkeypatch):
    Site(SITE).patch(monkeypatch, crawl)
    r = await site_map("https://example.com/", config=CONFIG, max_depth=0)
    entries = by_url(r)
    assert entries["https://example.com/"]["outcome"] == "fetched"
    depth_links = {u for u, item in entries.items() if item["outcome"] == "depth"}
    assert depth_links == {
        "https://example.com/about",
        "https://example.com/blog/",
    }
    assert entries["https://example.com/about"]["depth"] == 1
    assert entries["https://example.com/about"]["found_on"] == "https://example.com/"
    assert r["truncated"] is False and r["unvisited"] == 0


async def test_robots_wins_over_depth_at_the_boundary(monkeypatch):
    Site(SITE).patch(monkeypatch, crawl)
    r = await site_map("https://example.com/", config=CONFIG, max_depth=0)
    # /private/x is past depth 0 but robots.txt is the absolute policy.
    assert by_url(r)["https://example.com/private/x"]["outcome"] == "robots"


# --- resume -------------------------------------------------------------------

async def test_resume_continues_budget_run_without_refetching(monkeypatch):
    site = Site(SITE)
    site.patch(monkeypatch, crawl)
    first = await site_map("https://example.com/", config=CONFIG, max_pages=2)
    assert first["truncated"] is True
    first_run_paths = [req.url.path for req in site.requests]
    assert "/" in first_run_paths and "/about" in first_run_paths

    second = await site_map("https://example.com/", config=CONFIG, max_pages=50,
                            resume=first["pages_outcome"])
    second_run_paths = [req.url.path for req in site.requests[len(first_run_paths):]]
    entries = by_url(second)
    # Nothing stays on the budget/depth pile; the reachable site is exhausted.
    assert not any(item["outcome"] in ("budget", "depth") for item in second["pages_outcome"])
    assert entries["https://example.com/blog/post-1"]["outcome"] == "fetched"
    assert entries["https://example.com/private/x"]["outcome"] == "robots"
    # Already-fetched URLs are not fetched again in the resumed run.
    assert second_run_paths.count("/") == 0
    assert second_run_paths.count("/about") == 0


async def test_resume_seed_depth_is_remembered(monkeypatch):
    Site(SITE).patch(monkeypatch, crawl)
    first = await site_map("https://example.com/", config=CONFIG, max_pages=2)
    seed = by_url(first)["https://example.com/blog/"]
    assert seed["outcome"] == "budget" and seed["depth"] == 1
    second = await site_map("https://example.com/", config=CONFIG, max_pages=50,
                            resume=first["pages_outcome"])
    blog = by_url(second)["https://example.com/blog/"]
    assert blog["outcome"] == "fetched" and blog["depth"] == 1
    assert by_url(second)["https://example.com/blog/post-1"]["depth"] == 2


async def test_resume_depth_seed_over_new_max_depth_becomes_depth(monkeypatch):
    Site(SITE).patch(monkeypatch, crawl)
    first = await site_map("https://example.com/", config=CONFIG, max_depth=3, max_pages=50)
    # Force a depth-seed entry by hand: post-1 was fetched at depth 2.
    resume = [dict(item) for item in first["pages_outcome"]
              if item["url"] != "https://example.com/blog/post-1"]
    resume.append({"url": "https://example.com/blog/post-1", "depth": 2,
                   "outcome": "depth", "status": None, "error": None,
                   "found_on": "https://example.com/blog/"})
    second = await site_map("https://example.com/", config=CONFIG, max_depth=1,
                            resume=resume)
    assert by_url(second)["https://example.com/blog/post-1"]["outcome"] == "depth"


async def test_resume_fetched_and_robots_entries_are_skipped(monkeypatch):
    site = Site(SITE)
    site.patch(monkeypatch, crawl)
    full = await site_map("https://example.com/", config=CONFIG)
    before = len(site.requests)
    again = await site_map("https://example.com/", config=CONFIG, resume=full["pages_outcome"])
    # Every URL already had a terminal outcome: only robots.txt is re-read.
    after_paths = [req.url.path for req in site.requests[before:]]
    assert after_paths == ["/robots.txt"]
    assert by_url(again)["https://example.com/"]["outcome"] == "fetched"
    assert by_url(again)["https://example.com/private/x"]["outcome"] == "robots"
    assert again["count"] == 0


async def test_resume_rechecks_robots_when_policy_now_blocks(monkeypatch):
    pages = dict(SITE)
    site = Site(pages)
    site.patch(monkeypatch, crawl)
    first = await site_map("https://example.com/", config=CONFIG, max_pages=2)
    assert by_url(first)["https://example.com/blog/"]["outcome"] == "budget"
    # robots.txt now forbids everything (local copy: don't mutate the shared SITE).
    pages[("example.com", "/robots.txt")] = (
        200, "text/plain", "User-agent: *\nDisallow: /\n")
    second = await site_map("https://example.com/", config=CONFIG,
                            resume=first["pages_outcome"])
    entries = by_url(second)
    assert entries["https://example.com/blog/"]["outcome"] == "robots"
    assert not any(req.url.path == "/blog/" for req in site.requests)


async def test_resume_with_robots_disabled_fetches_seed(monkeypatch):
    Site(SITE).patch(monkeypatch, crawl)
    first = await site_map("https://example.com/", config=CONFIG, max_pages=2)
    seed = by_url(first)["https://example.com/blog/"]
    assert seed["outcome"] == "budget"
    second = await site_map("https://example.com/", config=CONFIG, respect_robots=False,
                            resume=first["pages_outcome"])
    # The budget seed is retried under this run's (disabled) robots policy.
    assert by_url(second)["https://example.com/blog/"]["outcome"] == "fetched"
    # A terminal robots outcome stays skipped per the resume contract.
    assert by_url(second)["https://example.com/private/x"]["outcome"] == "robots"


async def test_resume_still_bounded_by_this_runs_max_pages(monkeypatch):
    Site(SITE).patch(monkeypatch, crawl)
    first = await site_map("https://example.com/", config=CONFIG, max_pages=2)
    second = await site_map("https://example.com/", config=CONFIG, max_pages=1,
                            resume=first["pages_outcome"])
    # Two budget seeds, but this run's cap only lets one through; the other
    # keeps its budget fate.
    budget = [u for u, item in by_url(second).items() if item["outcome"] == "budget"]
    assert len(budget) == 2
    assert second["count"] == 1
    assert second["truncated"] is True


async def test_resume_invalid_url_raises_before_any_request(monkeypatch):
    site = Site(SITE)
    site.patch(monkeypatch, crawl)
    bad = [{"url": "not a url", "depth": 1, "outcome": "budget",
            "status": None, "error": None, "found_on": "https://example.com/"}]
    with pytest.raises(CrawlError, match="invalid url"):
        await site_map("https://example.com/", config=CONFIG, resume=bad)
    assert site.requests == []
    with pytest.raises(CrawlError, match="invalid url"):
        await site_map("https://example.com/", config=CONFIG,
                       resume=[{"url": "ftp://example.com/x", "outcome": "budget"}])


async def test_resume_unknown_outcome_raises_before_any_request(monkeypatch):
    site = Site(SITE)
    site.patch(monkeypatch, crawl)
    bad = [{"url": "https://example.com/x", "depth": 0, "outcome": "exploded"}]
    with pytest.raises(CrawlError, match="unknown outcome"):
        await site_map("https://example.com/", config=CONFIG, resume=bad)
    assert site.requests == []


async def test_resume_malformed_shapes_raise(monkeypatch):
    site = Site(SITE)
    site.patch(monkeypatch, crawl)
    with pytest.raises(CrawlError):
        await site_map("https://example.com/", config=CONFIG, resume="nope")
    with pytest.raises(CrawlError):
        await site_map("https://example.com/", config=CONFIG, resume=[("https://example.com/",)])
    with pytest.raises(CrawlError):
        await site_map("https://example.com/", config=CONFIG,
                       resume=[{"url": "https://example.com/x", "outcome": "budget",
                                "depth": -1}])
    with pytest.raises(CrawlError):
        await site_map("https://example.com/", config=CONFIG,
                       resume=[{"url": "https://example.com/x", "outcome": "budget",
                                "depth": True}])
    assert site.requests == []


async def test_resume_rejects_off_host_url_before_any_request(monkeypatch):
    site = Site(SITE)
    site.patch(monkeypatch, crawl)
    bad = [{"url": "https://other.org/gone", "depth": 0, "outcome": "budget",
            "status": None, "error": None, "found_on": None}]
    with pytest.raises(CrawlError, match="off the start host"):
        await site_map("https://example.com/", config=CONFIG, resume=bad)
    # Not even robots.txt may be fetched for an invalid resume.
    assert site.requests == []


async def test_resume_with_start_url_seed_queues_it_once(monkeypatch):
    site = Site(SITE)
    site.patch(monkeypatch, crawl)
    seed = [{"url": "https://example.com/", "depth": 0, "outcome": "budget",
             "status": None, "error": None, "found_on": None}]
    r = await site_map("https://example.com/", config=CONFIG, max_pages=10, resume=seed)
    # Root is fetched exactly once despite being both a seed and the start URL.
    assert sum(1 for req in site.requests if req.url.path == "/") == 1
    assert by_url(r)["https://example.com/"]["outcome"] == "fetched"
    assert r["count"] >= 2


# --- link_check must be unaffected --------------------------------------------

async def test_link_check_still_works_and_has_no_resume(monkeypatch):
    Site(SITE).patch(monkeypatch, crawl)
    r = await crawl.link_check("https://example.com/", config=CONFIG)
    assert r["error"] is None
    assert {b["url"] for b in r["broken"]} == {"https://other.org/gone"}
    assert r["skipped_by_robots"] == ["https://example.com/private/x"]
    params = inspect.signature(crawl.link_check).parameters
    assert "resume" not in params
