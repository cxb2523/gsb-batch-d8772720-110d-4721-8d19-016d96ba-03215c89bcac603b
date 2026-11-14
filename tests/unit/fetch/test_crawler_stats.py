"""Offline tests for the crawl outcome/stats channel.

These tests never touch the network:

* the async backend is exercised against respx-stubbed httpx responses,
  including a stubbed ``/robots.txt``;
* the JS backend is exercised with ``PersistentRenderer`` replaced by a
  fake context manager that serves the same canned HTML map, so no
  Playwright/Chromium install is required.

The contract under test (identical field names on both backends):

* ``CrawlStats`` exposes pages_fetched / articles_found /
  robots_blocked / errors / stop_reason / truncated / unfetched_urls;
* unfetched_urls are *normalized*, de-duplicated, discovery-ordered, and
  come solely from URLs really enqueued but never processed;
* robots-blocked and failed URLs are processed and counted, never mixed
  into the unfetched list;
* the default call still returns a bare article list.
"""

import httpx
import respx

from open_news.fetch import crawler as crawler_mod
from open_news.fetch.crawler import (
    AsyncCrawler,
    CrawlResult,
    CrawlStats,
    JSCrawler,
    crawl_site,
)
from open_news.processing.dedupe import normalize_url

BASE = "http://example.test"

# ----------------------------------------------------------------------
# Canned site
# ----------------------------------------------------------------------

# A paragraph comfortably above min_text_length=0 anyway; kept realistic
# so the extractor has body text to work with when thresholds are raised.
_BODY = "<p>" + "word " * 80 + "</p>"


def _page(links, title="Page"):
    anchors = "".join(f'<a href="{href}">{i}</a>' for i, href in enumerate(links))
    return (
        "<!doctype html><html><head>"
        f"<title>{title}</title>"
        '<meta property="og:site_name" content="Example Test">'
        f"</head><body><article><h1>{title}</h1>{_BODY}</article>"
        f"<nav>{anchors}</nav></body></html>"
    )


# Link graph:
#   /        -> /p1, /p2, /p3, /p4, /p5
#   /p1..p5  -> leaf pages /l1..l3 (discovered at depth 2)
LEAF_LINKS = ["/l1.html", "/l2.html", "/l3.html"]
PAGES = {
    "/": _page([f"/p{i}.html" for i in range(1, 6)], "Index"),
    **{f"/p{i}.html": _page(LEAF_LINKS, f"Page {i}") for i in range(1, 6)},
    **{f"/l{i}.html": _page([], f"Leaf {i}") for i in range(1, 2 + 1)},
    "/l3.html": _page([], "Leaf 3"),
}

# Equivalent-URL variants that normalize to the same key are built
# inline in the dedupe test below.


def _route_all(router, pages=PAGES, robots_text=None):
    """Point every example.test URL at the canned page map."""

    if robots_text is None:
        # No disallow rules -> everything allowed.
        robots_text = "User-agent: *\nAllow: /\n"

    @router.route(host="example.test", path="/robots.txt")
    def _robots(request):  # noqa: ARG001
        return httpx.Response(200, text=robots_text)

    @router.route(host="example.test")
    def _pages(request):
        path = request.url.raw_path.decode().split("?", 1)[0]
        body = pages.get(path)
        if body is None:
            return httpx.Response(404, text="not found")
        return httpx.Response(200, headers={"content-type": "text/html"}, text=body)


def _norm(path):
    return normalize_url(BASE + path)


# ----------------------------------------------------------------------
# Async backend
# ----------------------------------------------------------------------


@respx.mock
async def _async_crawl(**kwargs):
    _route_all(respx.mock)
    crawler = AsyncCrawler(
        max_pages=kwargs.pop("max_pages", 40),
        max_depth=kwargs.pop("max_depth", 2),
        concurrency=kwargs.pop("concurrency", 2),
        min_text_length=kwargs.pop("min_text_length", 0),
        obey_robots=kwargs.pop("obey_robots", True),
    )
    return await crawler.crawl(BASE + "/", **kwargs)


def test_async_default_call_returns_bare_list():
    articles = asyncio_run(_async_crawl())
    assert isinstance(articles, list)
    assert articles and all(isinstance(a, dict) for a in articles)


def test_async_with_stats_returns_crawl_result():
    result = asyncio_run(_async_crawl(with_stats=True))
    assert isinstance(result, CrawlResult)
    assert isinstance(result.stats, CrawlStats)
    assert isinstance(result.articles, list)
    # Same articles the bare-list path returns.
    bare = asyncio_run(_async_crawl())
    assert result.articles == bare


def test_async_completed_crawl_has_empty_unfetched():
    # Budget large enough for every page (1 index + 5 hubs + 3 leaves = 9).
    result = asyncio_run(_async_crawl(max_pages=40, max_depth=2, with_stats=True))
    stats = result.stats
    assert stats.pages_fetched == 9
    assert stats.articles_found == len(result.articles)
    assert stats.robots_blocked == 0
    assert stats.errors == 0
    assert stats.unfetched_urls == []
    assert stats.truncated is False
    assert stats.stop_reason == "completed"


def test_async_max_pages_lists_remaining_frontier():
    # Only the index fits; everything it linked to stays unprocessed.
    result = asyncio_run(
        _async_crawl(max_pages=1, max_depth=2, concurrency=1, with_stats=True)
    )
    stats = result.stats
    assert stats.pages_fetched == 1
    assert stats.truncated is True
    assert stats.stop_reason == "max_pages"

    expected = [_norm(f"/p{i}.html") for i in range(1, 6)]
    assert stats.unfetched_urls == expected
    # No visited URL leaks into the leftover list.
    assert _norm("/") not in stats.unfetched_urls
    # All entries are normalized forms (no scheme/host prefix).
    assert all(not u.startswith("http") for u in stats.unfetched_urls)


def test_async_max_depth_records_beyond_depth_links():
    # max_depth=0: index is fetched, its links are enqueued at depth 1
    # and never expanded -> reported as a depth truncation.
    result = asyncio_run(
        _async_crawl(max_pages=40, max_depth=0, with_stats=True)
    )
    stats = result.stats
    assert stats.pages_fetched == 1
    assert stats.truncated is True
    assert stats.stop_reason == "max_depth"
    assert stats.unfetched_urls == [_norm(f"/p{i}.html") for i in range(1, 6)]


def test_async_unfetched_dedupes_by_normalized_form():
    pages = {
        "/": _page(["/p1.html", "/p1.html?utm_source=x", "/p2.html"]),
        "/p1.html": _page([], "P1"),
        "/p2.html": _page([], "P2"),
    }
    with respx.mock:
        _route_all(respx.mock, pages=pages)
        crawler = AsyncCrawler(
            max_pages=1, max_depth=2, concurrency=1, min_text_length=0
        )
        result = asyncio_run(crawler.crawl(BASE + "/", with_stats=True))

    # The two /p1 variants collapse to one normalized key.
    assert result.stats.unfetched_urls == [_norm("/p1.html"), _norm("/p2.html")]


def test_async_robots_blocked_not_in_unfetched():
    robots = "User-agent: *\nDisallow: /p2.html\n"
    with respx.mock:
        _route_all(respx.mock, robots_text=robots)
        crawler = AsyncCrawler(
            max_pages=40, max_depth=2, concurrency=1, min_text_length=0
        )
        result = asyncio_run(crawler.crawl(BASE + "/", with_stats=True))

    stats = result.stats
    assert stats.robots_blocked >= 1
    # Blocked URL was processed, not left on the frontier.
    assert _norm("/p2.html") not in stats.unfetched_urls
    # Full site otherwise exhausted -> nothing else left behind.
    assert stats.unfetched_urls == []
    assert stats.stop_reason == "completed"


def test_async_request_error_counted_not_unfetched():
    def _handler(request):
        path = request.url.raw_path.decode().split("?", 1)[0]
        if path == "/p3.html":
            raise httpx.ConnectError("boom")
        body = PAGES.get(path)
        if body is None:
            return httpx.Response(404, text="not found")
        return httpx.Response(200, headers={"content-type": "text/html"}, text=body)

    with respx.mock:
        respx.mock.route(host="example.test", path="/robots.txt").respond(
            200, text="User-agent: *\nAllow: /\n"
        )
        respx.mock.route(host="example.test").side_effect = _handler
        crawler = AsyncCrawler(
            max_pages=40, max_depth=2, concurrency=1, min_text_length=0
        )
        result = asyncio_run(crawler.crawl(BASE + "/", with_stats=True))

    stats = result.stats
    assert stats.errors == 1
    assert _norm("/p3.html") not in stats.unfetched_urls
    assert stats.unfetched_urls == []


def test_async_crawl_site_passes_with_stats_through():
    with respx.mock:
        _route_all(respx.mock)
        result = crawl_site(
            BASE + "/", max_pages=1, max_depth=0, with_stats=True
        )
    assert isinstance(result, CrawlResult)
    assert result.stats.truncated is True

    # Default call shape unchanged.
    with respx.mock:
        _route_all(respx.mock)
        bare = crawl_site(BASE + "/", max_pages=1, max_depth=0)
    assert isinstance(bare, list)


# ----------------------------------------------------------------------
# JS backend — same stats shape, renderer stubbed
# ----------------------------------------------------------------------


class _FakeRenderer:
    """Stand-in for PersistentRenderer: no browser, serves canned HTML."""

    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def render(self, url):
        path = urlsplit_path(url)
        if path not in PAGES:
            raise RuntimeError(f"render failed for {url}")
        return PAGES[path]


def urlsplit_path(url):
    from urllib.parse import urlparse

    return urlparse(url).path


def _js_crawl(monkeypatch, **kwargs):
    # Neutralize the robots.txt fetch inside JSCrawler.crawl.
    def _fake_httpx_get(url, **kwargs):  # noqa: ARG001
        response = httpx.Response(200, text="User-agent: *\nAllow: /\n")
        return response

    monkeypatch.setattr(crawler_mod.httpx, "get", _fake_httpx_get, raising=False)
    # JSCrawler imports httpx locally as `import httpx as _httpx`, so the
    # module-level attribute patch above covers it.
    monkeypatch.setattr(
        "open_news.core.renderer.PersistentRenderer", _FakeRenderer
    )

    crawler = JSCrawler(
        max_pages=kwargs.pop("max_pages", 15),
        max_depth=kwargs.pop("max_depth", 1),
        min_text_length=kwargs.pop("min_text_length", 0),
        obey_robots=kwargs.pop("obey_robots", True),
    )
    return crawler.crawl(BASE + "/", **kwargs)


def test_js_default_call_returns_bare_list(monkeypatch):
    articles = _js_crawl(monkeypatch)
    assert isinstance(articles, list)


def test_js_stats_shape_matches_async(monkeypatch):
    result = _js_crawl(monkeypatch, with_stats=True)
    assert isinstance(result, CrawlResult)
    stats = result.stats
    # Identical field names to the async path.
    assert set(CrawlStats.__dataclass_fields__) == {
        "pages_fetched",
        "articles_found",
        "robots_blocked",
        "errors",
        "stop_reason",
        "truncated",
        "unfetched_urls",
    }
    assert isinstance(stats.unfetched_urls, list)


def test_js_completed_crawl_has_empty_unfetched(monkeypatch):
    # depth 1 reaches index + 5 hubs; leaves are never discovered as
    # enqueue candidates? They ARE enqueued at depth 2 -> depth truncation.
    # Use depth 2 and enough pages to exhaust the whole site.
    result = _js_crawl(
        monkeypatch, max_pages=40, max_depth=2, with_stats=True
    )
    stats = result.stats
    assert stats.pages_fetched == 9
    assert stats.articles_found == len(result.articles)
    assert stats.unfetched_urls == []
    assert stats.truncated is False
    assert stats.stop_reason == "completed"


def test_js_max_pages_lists_remaining_frontier(monkeypatch):
    result = _js_crawl(
        monkeypatch, max_pages=1, max_depth=2, with_stats=True
    )
    stats = result.stats
    assert stats.pages_fetched == 1
    assert stats.truncated is True
    assert stats.stop_reason == "max_pages"
    assert stats.unfetched_urls == [_norm(f"/p{i}.html") for i in range(1, 6)]
    assert _norm("/") not in stats.unfetched_urls


def test_js_max_depth_records_beyond_depth_links(monkeypatch):
    result = _js_crawl(
        monkeypatch, max_pages=40, max_depth=0, with_stats=True
    )
    stats = result.stats
    assert stats.pages_fetched == 1
    assert stats.stop_reason == "max_depth"
    assert stats.truncated is True
    assert stats.unfetched_urls == [_norm(f"/p{i}.html") for i in range(1, 6)]


def test_js_robots_blocked_not_in_unfetched(monkeypatch):
    # A robots.txt that forbids /p2.html.
    real_get = httpx.get

    def _fake_get(url, **kwargs):
        if url.endswith("/robots.txt"):
            return httpx.Response(
                200, text="User-agent: *\nDisallow: /p2.html\n"
            )
        return real_get(url, **kwargs)

    monkeypatch.setattr(crawler_mod.httpx, "get", _fake_get, raising=False)
    monkeypatch.setattr(
        "open_news.core.renderer.PersistentRenderer", _FakeRenderer
    )

    crawler = JSCrawler(max_pages=40, max_depth=2, min_text_length=0)
    result = crawler.crawl(BASE + "/", with_stats=True)
    stats = result.stats
    assert stats.robots_blocked >= 1
    assert _norm("/p2.html") not in stats.unfetched_urls
    assert stats.unfetched_urls == []


def test_js_render_error_counted_not_unfetched(monkeypatch):
    class _BrokenRenderer(_FakeRenderer):
        def render(self, url):
            if urlsplit_path(url) == "/p3.html":
                raise RuntimeError("renderer exploded")
            return super().render(url)

    monkeypatch.setattr(
        "open_news.core.renderer.PersistentRenderer", _BrokenRenderer
    )
    monkeypatch.setattr(
        crawler_mod.httpx,
        "get",
        lambda url, **kw: httpx.Response(200, text="User-agent: *\nAllow: /\n"),
        raising=False,
    )

    crawler = JSCrawler(max_pages=40, max_depth=2, min_text_length=0)
    result = crawler.crawl(BASE + "/", with_stats=True)
    stats = result.stats
    assert stats.errors == 1
    assert _norm("/p3.html") not in stats.unfetched_urls
    assert stats.unfetched_urls == []


def test_js_crawl_site_passes_with_stats_through(monkeypatch):
    monkeypatch.setattr(
        "open_news.core.renderer.PersistentRenderer", _FakeRenderer
    )
    monkeypatch.setattr(
        crawler_mod.httpx,
        "get",
        lambda url, **kw: httpx.Response(200, text="User-agent: *\nAllow: /\n"),
        raising=False,
    )
    result = crawl_site(
        BASE + "/", js=True, max_pages=1, max_depth=0, with_stats=True
    )
    assert isinstance(result, CrawlResult)
    assert result.stats.truncated is True

    bare = crawl_site(BASE + "/", js=True, max_pages=1, max_depth=0)
    assert isinstance(bare, list)


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------


def asyncio_run(coro):
    import asyncio

    return asyncio.run(coro)
