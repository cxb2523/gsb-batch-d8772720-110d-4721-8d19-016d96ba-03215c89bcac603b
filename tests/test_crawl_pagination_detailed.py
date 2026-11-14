"""Scraper.crawl() per-page accounting — all offline.

The flat crawl() result could never say why the walk stopped, and a failed
request mid-walk lost every record already taken. These tests drive
``crawl()`` against an in-memory multi-page site served through a stubbed
``Scraper.static`` (the same seam the crawler tests use), so nothing touches
the network. They cover the four detailed outcomes — full walk, a failed
request, a missing next-page link and the `pages` truncation — plus the
default-mode contract that must stay unchanged.
"""

from __future__ import annotations

import requests

from bytecrawl import (
    CRAWL_NO_NEXT_PAGE,
    CRAWL_PAGES_LIMIT,
    CRAWL_REQUEST_FAILED,
    CRAWL_SUCCESS,
    Page,
    Scraper,
)

NEXT = '<li class="next"><a href="{href}">next</a></li>'


def listing(names, next_href=None):
    """Builds a listing page: one article.item per name, optional next link."""
    items = "".join(f'<article class="item"><h3>{name}</h3></article>' for name in names)
    link = NEXT.format(href=next_href) if next_href else ""
    return f"<html><body>{items}{link}</body></html>"


# Three pages; page 3 is the natural end (no next-page link).
SITE = {
    "https://x.test/p1": listing(["A", "B"], "/p2"),
    "https://x.test/p2": listing(["C", "D"], "/p3"),
    "https://x.test/p3": listing(["E"]),
}

ITEM = "article.item"
FIELDS = {"name": "h3::text"}
NEXT_PAGE = "li.next a::attr(href)"


def make_scraper(monkeypatch, site=None, fail=()):
    """Stubs Scraper.static to serve `site`, raising HTTPError for `fail` URLs.

    Returns (scraper, visited) — `visited` records the fetch order, which the
    "stops and never guesses the next URL" assertions rely on.
    """
    site = SITE if site is None else site
    visited: list[str] = []

    def fake_static(self, url):
        visited.append(url)
        if url in fail:
            raise requests.HTTPError(f"500 Server Error for url: {url}")
        if url not in site:
            raise requests.HTTPError(f"404 Client Error for url: {url}")
        return Page(url=url, html=site[url], method="static", status=200)

    monkeypatch.setattr(Scraper, "static", fake_static)
    return Scraper(), visited


def names(report):
    return [r["name"] for r in report["records"]]


class TestDetailedFullWalk:
    def test_walks_every_page_and_accounts_for_each(self, monkeypatch):
        bot, visited = make_scraper(monkeypatch)
        report = bot.crawl("https://x.test/p1", ITEM, FIELDS, next_page=NEXT_PAGE, detailed=True)

        assert visited == ["https://x.test/p1", "https://x.test/p2", "https://x.test/p3"]
        # Every record survives, in page order.
        assert names(report) == ["A", "B", "C", "D", "E"]

        pages = report["pages"]
        assert [p["page"] for p in pages] == [1, 2, 3]
        assert [p["url"] for p in pages] == visited
        assert [p["count"] for p in pages] == [2, 2, 1]
        assert [p["outcome"] for p in pages] == [
            CRAWL_SUCCESS,
            CRAWL_SUCCESS,
            CRAWL_NO_NEXT_PAGE,
        ]
        assert all(p["error"] is None for p in pages)

    def test_missing_next_link_is_the_normal_end_not_a_failure(self, monkeypatch):
        # A single page without any next link: the walk ends for lack of a
        # link, which is distinct from a request failure.
        bot, _ = make_scraper(monkeypatch, site={"https://x.test/only": listing(["X", "Y"])})
        report = bot.crawl("https://x.test/only", ITEM, FIELDS, next_page=NEXT_PAGE, detailed=True)
        assert names(report) == ["X", "Y"]
        assert len(report["pages"]) == 1
        assert report["pages"][0]["outcome"] == CRAWL_NO_NEXT_PAGE
        assert report["pages"][0]["count"] == 2
        assert report["pages"][0]["error"] is None


class TestDetailedRequestFailure:
    def test_mid_walk_failure_keeps_earlier_records_and_stops(self, monkeypatch):
        bot, visited = make_scraper(monkeypatch, fail={"https://x.test/p2"})
        report = bot.crawl("https://x.test/p1", ITEM, FIELDS, next_page=NEXT_PAGE, detailed=True)

        # Page 1's records are preserved; the walk stops at the failed page and
        # never tries page 3 behind it.
        assert names(report) == ["A", "B"]
        assert visited == ["https://x.test/p1", "https://x.test/p2"]

        pages = report["pages"]
        assert [p["page"] for p in pages] == [1, 2]
        assert pages[0]["outcome"] == CRAWL_SUCCESS
        assert pages[0]["count"] == 2
        failed = pages[1]
        assert failed["outcome"] == CRAWL_REQUEST_FAILED
        assert failed["count"] == 0
        assert failed["url"] == "https://x.test/p2"
        assert failed["error"] is not None
        assert "HTTPError" in failed["error"]
        assert "500" in failed["error"]

    def test_first_page_failure_has_empty_records_but_readable_outcome(self, monkeypatch):
        bot, visited = make_scraper(monkeypatch, fail={"https://x.test/p1"})
        report = bot.crawl("https://x.test/p1", ITEM, FIELDS, next_page=NEXT_PAGE, detailed=True)

        assert visited == ["https://x.test/p1"]  # no guessed follow-up URL
        assert report["records"] == []
        assert len(report["pages"]) == 1
        page = report["pages"][0]
        assert page["page"] == 1
        assert page["outcome"] == CRAWL_REQUEST_FAILED
        assert page["count"] == 0
        assert page["error"] and "HTTPError" in page["error"]


class TestDetailedPagesLimit:
    def test_pages_limit_is_marked_separately_from_missing_link(self, monkeypatch):
        # All three pages expose a next link, so with pages=2 the stop can only
        # be the budget — it must not be labelled no_next_page.
        site = {
            "https://x.test/p1": listing(["A", "B"], "/p2"),
            "https://x.test/p2": listing(["C", "D"], "/p3"),
            "https://x.test/p3": listing(["E"], "/p4"),
        }
        bot, visited = make_scraper(monkeypatch, site=site)
        report = bot.crawl(
            "https://x.test/p1",
            ITEM,
            FIELDS,
            next_page=NEXT_PAGE,
            pages=2,
            detailed=True,
        )

        assert visited == ["https://x.test/p1", "https://x.test/p2"]
        assert names(report) == ["A", "B", "C", "D"]
        assert [p["outcome"] for p in report["pages"]] == [
            CRAWL_SUCCESS,
            CRAWL_PAGES_LIMIT,
        ]
        assert report["pages"][-1]["count"] == 2
        assert all(p["error"] is None for p in report["pages"])

    def test_limit_one_truncates_even_though_a_next_link_exists(self, monkeypatch):
        bot, _ = make_scraper(monkeypatch)
        report = bot.crawl(
            "https://x.test/p1",
            ITEM,
            FIELDS,
            next_page=NEXT_PAGE,
            pages=1,
            detailed=True,
        )
        assert names(report) == ["A", "B"]
        assert len(report["pages"]) == 1
        assert report["pages"][0]["outcome"] == CRAWL_PAGES_LIMIT


class TestDefaultModeUnchanged:
    def test_still_returns_the_flat_record_list(self, monkeypatch):
        bot, visited = make_scraper(monkeypatch)
        rows = bot.crawl("https://x.test/p1", ITEM, FIELDS, next_page=NEXT_PAGE)
        assert isinstance(rows, list)
        assert [r["name"] for r in rows] == ["A", "B", "C", "D", "E"]
        assert visited == ["https://x.test/p1", "https://x.test/p2", "https://x.test/p3"]

    def test_failure_still_raises_and_loses_nothing_of_the_contract(self, monkeypatch):
        bot, visited = make_scraper(monkeypatch, fail={"https://x.test/p2"})
        try:
            bot.crawl("https://x.test/p1", ITEM, FIELDS, next_page=NEXT_PAGE)
        except requests.HTTPError:
            pass
        else:  # pragma: no cover - failure path is the point of the test
            raise AssertionError("default crawl() must keep raising on a failed request")
        # It walked exactly up to the failing page, as the old implementation did.
        assert visited == ["https://x.test/p1", "https://x.test/p2"]

    def test_pages_limit_flat_matches_historical_result(self, monkeypatch):
        bot, _ = make_scraper(monkeypatch)
        rows = bot.crawl("https://x.test/p1", ITEM, FIELDS, next_page=NEXT_PAGE, pages=1)
        assert [r["name"] for r in rows] == ["A", "B"]

    def test_no_next_page_selector_single_page_stays_flat(self, monkeypatch):
        bot, _ = make_scraper(monkeypatch)
        rows = bot.crawl("https://x.test/p1", ITEM, FIELDS)
        assert [r["name"] for r in rows] == ["A", "B"]
