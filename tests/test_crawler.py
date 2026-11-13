"""Offline tests for the crawler outcome-accounting redesign.

No network access is involved: every test builds local HTML snippets and
injects a replacement ``fetcher`` (a plain ``url -> raw html`` callable)
into :func:`intelliscrape.crawler.crawl`.
"""

from __future__ import annotations

import pytest

from intelliscrape.crawler import (
    ERROR_EMPTY_CONTENT,
    ERROR_FETCH,
    OUTCOME_FAILED,
    OUTCOME_NOT_ATTEMPTED,
    OUTCOME_SUCCESS,
    PageOutcome,
    crawl,
    normalize_url,
)


BASE = "https://example.test"


def _page(body: str = "", links=()):
    """Build a small HTML document with a body and anchors."""
    anchors = "".join(f'<a href="{href}">x</a>' for href in links)
    return f"<html><body><p>{body}</p>{anchors}</body></html>"


def make_fetcher(pages):
    """Return a fetcher backed by ``pages`` plus the calls it received."""
    calls: list[str] = []

    def fetcher(url: str) -> str:
        calls.append(url)
        if url not in pages:
            raise KeyError(f"no canned response for {url}")
        response = pages[url]
        if isinstance(response, Exception):
            raise response
        return response

    fetcher.calls = calls
    return fetcher


def outcome_map(result) -> dict:
    return {o.url: o for o in result.outcomes}


# ---------------------------------------------------------------------------
# Boundary conditions
# ---------------------------------------------------------------------------

def test_empty_start_url_raises_value_error():
    with pytest.raises(ValueError):
        crawl("", max_pages=5, delay=0, fetcher=make_fetcher({}))


def test_normalize_url_strips_fragment_but_keeps_query():
    assert normalize_url(f"{BASE}/a#section") == f"{BASE}/a"
    assert normalize_url(f"{BASE}/a?x=1#frag") == f"{BASE}/a?x=1"


# ---------------------------------------------------------------------------
# Success path
# ---------------------------------------------------------------------------

def test_success_page_records_outcome_chars_and_new_links():
    pages = {
        f"{BASE}/": _page("hello world from the home page",
                          ["/about", "/contact", "https://other.test/x"]),
        f"{BASE}/about": _page("about page with real content"),
        f"{BASE}/contact": _page("contact page with real content"),
    }
    fetcher = make_fetcher(pages)

    result = crawl(f"{BASE}/", max_pages=10, delay=0, fetcher=fetcher)

    # Every known same-domain URL has an outcome record.
    assert result.total_pages == 3
    assert result.total_failed == 0
    assert all(isinstance(o, PageOutcome) for o in result.outcomes)

    home = outcome_map(result)[f"{BASE}/"]
    assert home.status == OUTCOME_SUCCESS
    assert home.reason is None
    assert home.error_type is None
    assert home.chars > 0
    # Two same-domain links; the cross-domain link must not be queued.
    assert home.new_links == 2

    # Cross-domain URL never produced an outcome and was never requested.
    assert "https://other.test/x" not in outcome_map(result)
    assert "https://other.test/x" not in fetcher.calls

    # Existing surfaces keep working unchanged.
    assert {p.url for p in result.pages} == {
        f"{BASE}/", f"{BASE}/about", f"{BASE}/contact",
    }
    text = result.to_text()
    assert f"URL: {BASE}/" in text
    assert "hello world" in text


# ---------------------------------------------------------------------------
# Fetch exception vs. empty content
# ---------------------------------------------------------------------------

def test_fetch_exception_is_failure_with_reason_and_no_retry():
    pages = {
        f"{BASE}/": _page("start page with enough text", ["/boom", "/ok"]),
        f"{BASE}/boom": ConnectionError("connection refused"),
        f"{BASE}/ok": _page("fine page with enough text"),
    }
    fetcher = make_fetcher(pages)

    result = crawl(f"{BASE}/", max_pages=10, delay=0, fetcher=fetcher)

    boom = outcome_map(result)[f"{BASE}/boom"]
    assert boom.status == OUTCOME_FAILED
    assert boom.error_type == ERROR_FETCH
    assert "connection refused" in boom.reason
    assert boom.chars == 0
    assert boom.new_links == 0

    # The failing page still appears in failed with the old-style status.
    failed_page = next(p for p in result.failed if p.url == f"{BASE}/boom")
    assert failed_page.content == ""
    assert "connection refused" in failed_page.status

    # Exactly one attempt per URL: no extra request to mine links.
    assert fetcher.calls.count(f"{BASE}/boom") == 1
    # Crawl continues on the healthy branch.
    assert outcome_map(result)[f"{BASE}/ok"].status == OUTCOME_SUCCESS


def test_empty_content_is_failure_distinct_from_exception():
    pages = {
        f"{BASE}/": _page("home page with enough text", ["/blank", "/good"]),
        f"{BASE}/blank": _page(""),  # fetched fine, no body text
        f"{BASE}/good": _page("good page with enough text"),
    }
    fetcher = make_fetcher(pages)

    result = crawl(f"{BASE}/", max_pages=10, delay=0, fetcher=fetcher)

    blank = outcome_map(result)[f"{BASE}/blank"]
    assert blank.status == OUTCOME_FAILED
    assert blank.error_type == ERROR_EMPTY_CONTENT
    assert "empty" in blank.reason
    assert blank.chars == 0

    # Still only one request for the empty page.
    assert fetcher.calls.count(f"{BASE}/blank") == 1
    assert f"{BASE}/blank" in {p.url for p in result.failed}
    assert outcome_map(result)[f"{BASE}/good"].status == OUTCOME_SUCCESS


def test_whitespace_only_body_counts_as_empty():
    pages = {f"{BASE}/": "<html><body>  <br/> </body></html>"}
    result = crawl(f"{BASE}/", max_pages=5, delay=0, fetcher=make_fetcher(pages))

    assert result.total_pages == 0
    assert result.total_failed == 1
    outcome = result.outcomes[0]
    assert outcome.status == OUTCOME_FAILED
    assert outcome.error_type == ERROR_EMPTY_CONTENT


# ---------------------------------------------------------------------------
# max_pages truncation
# ---------------------------------------------------------------------------

def test_max_pages_marks_remaining_queue_as_not_attempted():
    pages = {
        f"{BASE}/": _page("home page with enough text", ["/a", "/b", "/c"]),
        f"{BASE}/a": _page("page a with enough text"),
        f"{BASE}/b": _page("page b with enough text"),
        f"{BASE}/c": _page("page c with enough text"),
    }
    fetcher = make_fetcher(pages)

    result = crawl(f"{BASE}/", max_pages=2, delay=0, fetcher=fetcher)

    # No more than max_pages requests were made.
    assert len(fetcher.calls) == 2
    assert len({u for u in fetcher.calls}) == 2

    statuses = outcome_map(result)
    not_attempted = [
        o for o in result.outcomes if o.status == OUTCOME_NOT_ATTEMPTED
    ]
    assert not_attempted, "queued URLs must be accounted for as not attempted"
    for outcome in not_attempted:
        assert outcome.reason and "max_pages" in outcome.reason
        assert outcome.error_type is None
        assert outcome.chars == 0
        assert outcome.new_links == 0
        assert outcome.url not in fetcher.calls

    # Not-attempted URLs are neither pages nor failures.
    assert result.total_failed == 0
    assert result.total_pages + result.total_failed == 2
    assert result.total_not_attempted == len(not_attempted)
    assert len(result.outcomes) == 4  # 2 fetched + 2 never fetched
    # Every record falls into exactly one known category.
    assert set(statuses) <= {
        f"{BASE}/", f"{BASE}/a", f"{BASE}/b", f"{BASE}/c",
    }


# ---------------------------------------------------------------------------
# Deduplication
# ---------------------------------------------------------------------------

def test_same_url_with_different_fragments_fetched_once():
    pages = {
        f"{BASE}/": _page(
            "home page with enough text",
            [f"{BASE}/p#top", "/p#bottom", "/p?q=1#frag"],
        ),
        f"{BASE}/p": _page("page one with enough text"),
        f"{BASE}/p?q=1": _page("page with query and enough text"),
    }
    fetcher = make_fetcher(pages)

    result = crawl(f"{BASE}/", max_pages=10, delay=0, fetcher=fetcher)

    # Fragment variants collapse; query string still distinguishes pages.
    assert fetcher.calls.count(f"{BASE}/p") == 1
    assert fetcher.calls.count(f"{BASE}/p?q=1") == 1
    urls = {o.url for o in result.outcomes}
    assert f"{BASE}/p" in urls
    assert f"{BASE}/p?q=1" in urls
    assert all("#" not in u for u in urls)
    assert all(o.status == OUTCOME_SUCCESS for o in result.outcomes)


def test_links_already_queued_are_not_counted_as_new():
    pages = {
        f"{BASE}/": _page("home page with enough text", ["/a", "/a#frag"]),
        f"{BASE}/a": _page("page a with enough text", ["/"]),
    }
    fetcher = make_fetcher(pages)

    result = crawl(f"{BASE}/", max_pages=10, delay=0, fetcher=fetcher)

    home = outcome_map(result)[f"{BASE}/"]
    # Both anchors resolve to the same normalized URL -> one new link.
    assert home.new_links == 1
    assert len(fetcher.calls) == len(set(fetcher.calls))


def test_on_page_callback_reports_progress():
    pages = {
        f"{BASE}/": _page("home page with enough text", ["/bad"]),
        f"{BASE}/bad": RuntimeError("boom"),
    }
    progress = []
    result = crawl(
        f"{BASE}/",
        max_pages=10,
        delay=0,
        fetcher=make_fetcher(pages),
        on_page=lambda done, failed: progress.append((done, failed)),
    )

    assert result.total_pages == 1
    assert result.total_failed == 1
    assert (1, 0) in progress
    assert (1, 1) in progress
