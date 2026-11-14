"""
Unit tests for the batch homepage collection entry point.
"""

from collections.abc import Iterable
from dataclasses import FrozenInstanceError
from unittest.mock import MagicMock, patch
from urllib.robotparser import RobotFileParser

import pytest

from courlan import UrlStore
from courlan.batch import (
    BatchResult,
    FetchError,
    SiteOutcome,
    SiteStatus,
    collect_homepages,
    fetch_page,
)

HOMEPAGE = (
    "<html><body>"
    '<a href="/article/one">one</a>'
    '<a href="/article/two">two</a>'
    '<a href="https://elsewhere.example/x">external</a>'
    '<a href="/login">login</a>'
    "</body></html>"
)


def _fetcher(pages):
    "Return a fetch function serving {site: html}, raising FetchError otherwise."
    requested = []

    def fetch(url):
        requested.append(url)
        if url not in pages:
            raise FetchError("HTTP status 500")
        return pages[url]

    fetch.requested = requested  # type: ignore[attr-defined]
    return fetch


def test_collect_homepages_success():
    "Successful sites add their links and report the number of new links."
    store = UrlStore()
    fetch = _fetcher(
        {
            "https://site-a.org": HOMEPAGE,
            "https://site-b.org": '<a href="/b/one">b1</a>',
        }
    )
    result = collect_homepages(
        ["https://site-a.org", "https://site-b.org"], store, fetch=fetch
    )

    assert isinstance(result, BatchResult)
    assert [o.status for o in result.outcomes] == [
        SiteStatus.SUCCESS,
        SiteStatus.SUCCESS,
    ]
    assert [o.url for o in result.outcomes] == [
        "https://site-a.org",
        "https://site-b.org",
    ]
    # `site` is an alias of `url`
    assert result.outcomes[0].site == "https://site-a.org"
    assert result.outcomes[0].added_links == 2
    assert result.outcomes[1].added_links == 1
    assert "2 new links" in result.outcomes[0].reason
    assert result.total_added == 3
    assert result.success_count == 2
    assert result.failure_count == 0
    assert result.rejected_count == 0
    assert result.total_count == 2
    # external and non-crawlable links are dropped by add_from_html
    assert set(store.dump_urls()) == {
        "https://site-a.org/article/one",
        "https://site-a.org/article/two",
        "https://site-b.org/b/one",
    }
    assert fetch.requested == ["https://site-a.org", "https://site-b.org"]


def test_collect_homepages_request_failure():
    "Transport errors and non-2xx responses fail the site without aborting the batch."
    store = UrlStore()
    fetch = _fetcher({"https://ok.org": HOMEPAGE})
    result = collect_homepages(
        ["https://missing.org", "https://ok.org", "https://also-missing.org"],
        store,
        fetch=fetch,
    )

    assert [o.status for o in result.outcomes] == [
        SiteStatus.FAILURE,
        SiteStatus.SUCCESS,
        SiteStatus.FAILURE,
    ]
    assert result.outcomes[0].url == "https://missing.org"
    assert "HTTP status 500" in result.outcomes[0].reason
    assert result.outcomes[1].added_links == 2
    assert result.failure_count == 2
    assert result.success_count == 1
    # the sites after the first failure were still requested
    assert fetch.requested == [
        "https://missing.org",
        "https://ok.org",
        "https://also-missing.org",
    ]


def test_collect_homepages_rejected():
    "robots, language and strict settings reject sites with a readable reason."
    # robots rules stored in the store
    store = UrlStore()
    rules = RobotFileParser()
    rules.parse(["User-agent: *", "Disallow: /"])
    store.store_rules("https://robots.org", rules)
    result = collect_homepages(
        ["https://robots.org"], store, fetch=_fetcher({"https://robots.org": HOMEPAGE})
    )
    assert result.outcomes[0].status is SiteStatus.REJECTED
    assert result.outcomes[0].added_links == 0
    assert "robots" in result.outcomes[0].reason
    assert store.total_url_number() == 0
    assert result.rejected_count == 1

    # language filter
    store = UrlStore(language="de")
    result = collect_homepages(
        ["https://lang.org"],
        store,
        fetch=_fetcher(
            {"https://lang.org": '<a href="/en/one">a</a><a href="/en/two">b</a>'}
        ),
    )
    assert result.outcomes[0].status is SiteStatus.REJECTED
    assert "language" in result.outcomes[0].reason
    assert result.rejected_count == 1

    # strict mode
    store = UrlStore(strict=True)
    result = collect_homepages(
        ["https://strict.org"],
        store,
        fetch=_fetcher(
            {"https://strict.org": '<a href="/video.mp4">a</a><a href="/home">b</a>'}
        ),
    )
    assert result.outcomes[0].status is SiteStatus.REJECTED
    assert "strict" in result.outcomes[0].reason
    assert result.rejected_count == 1

    # page without any usable internal link
    store = UrlStore()
    result = collect_homepages(
        ["https://empty.org"],
        store,
        fetch=_fetcher({"https://empty.org": "<html><body>no links</body></html>"}),
    )
    assert result.outcomes[0].status is SiteStatus.REJECTED
    assert "no usable internal links" in result.outcomes[0].reason


def test_collect_homepages_rejected_known_links():
    "A page yielding only already known links is rejected, not a failure."
    store = UrlStore()
    page = '<a href="/only/one">x</a>'
    fetch = _fetcher({"https://dup.org": page})
    first = collect_homepages(["https://dup.org"], store, fetch=fetch)
    second = collect_homepages(["https://dup.org"], store, fetch=fetch)

    assert first.outcomes[0].status is SiteStatus.SUCCESS
    assert first.outcomes[0].added_links == 1
    assert second.outcomes[0].status is SiteStatus.REJECTED
    assert "already known" in second.outcomes[0].reason
    assert second.success_count == 0
    assert second.rejected_count == 1


def test_collect_homepages_empty_input():
    "Empty or absent input yields a complete, empty result."
    empty_inputs: list[Iterable[str] | None] = [[], (), None]
    for sites in empty_inputs:
        result = collect_homepages(sites, UrlStore())
        assert isinstance(result, BatchResult)
        assert result.outcomes == []
        assert result.success_count == 0
        assert result.failure_count == 0
        assert result.rejected_count == 0
        assert result.total_count == 0


def test_collect_homepages_all_invalid():
    "Invalid URLs fail without any request and do not raise."
    fetch = _fetcher({})
    sites = ["not-a-url", "ftp://example.org", "", "http://ab"]
    result = collect_homepages(sites, UrlStore(), fetch=fetch)

    assert result.total_count == 4
    assert all(o.status is SiteStatus.FAILURE for o in result.outcomes)
    assert all("invalid URL" in o.reason for o in result.outcomes)
    assert all(o.added_links == 0 for o in result.outcomes)
    assert result.failure_count == 4
    assert result.success_count == 0
    assert result.rejected_count == 0
    assert fetch.requested == []


def test_collect_homepages_isolates_exceptions(monkeypatch):
    "An exception on one site does not stop the batch, and counts stay correct."
    store = UrlStore()
    original = UrlStore.add_from_html

    def add_from_html(self, htmlstring, url, *args, **kwargs):
        if url == "https://boom-store.org":
            raise RuntimeError("store failure")
        return original(self, htmlstring, url, *args, **kwargs)

    monkeypatch.setattr(UrlStore, "add_from_html", add_from_html)

    def fetch(url):
        if url == "https://boom.org":
            raise RuntimeError("unexpected failure")
        return HOMEPAGE

    result = collect_homepages(
        [
            "https://first.org",
            "https://boom.org",
            "https://boom-store.org",
            "https://last.org",
        ],
        store,
        fetch=fetch,
    )

    assert [o.url for o in result.outcomes] == [
        "https://first.org",
        "https://boom.org",
        "https://boom-store.org",
        "https://last.org",
    ]
    assert [o.status for o in result.outcomes] == [
        SiteStatus.SUCCESS,
        SiteStatus.FAILURE,
        SiteStatus.FAILURE,
        SiteStatus.SUCCESS,
    ]
    assert "unexpected failure" in result.outcomes[1].reason
    assert "error while adding links" in result.outcomes[2].reason
    assert result.success_count == 2
    assert result.failure_count == 2
    assert result.rejected_count == 0
    # both successful sites are in the store
    assert set(store.get_known_domains()) == {
        "https://first.org",
        "https://last.org",
    }


def test_collect_homepages_invalid_host():
    "Hosts rejected by the domain filter fail without a request."
    fetch = _fetcher({})
    result = collect_homepages(
        ["https://example.org:99999", "https://localhost"], UrlStore(), fetch=fetch
    )
    assert result.failure_count == 2
    assert all("invalid URL" in o.reason for o in result.outcomes)
    assert fetch.requested == []


def test_collect_homepages_fallback_reason(monkeypatch):
    "A failing reason diagnosis does not turn a rejection into an error."
    store = UrlStore()

    def broken_filter_links(*args, **kwargs):
        raise RuntimeError("filter failure")

    monkeypatch.setattr("courlan.batch.filter_links", broken_filter_links)
    result = collect_homepages(
        ["https://x.org"], store, fetch=lambda url: "<html>no links</html>"
    )
    assert result.outcomes[0].status is SiteStatus.REJECTED
    assert "robots, language or strict" in result.outcomes[0].reason


def test_collect_homepages_validation_error(monkeypatch):
    "Unexpected errors while validating a site are reported as failures."
    fetch = _fetcher({})

    def broken_validate(url):
        raise RuntimeError("validator failure")

    monkeypatch.setattr("courlan.batch.validate_url", broken_validate)
    result = collect_homepages(["https://x.org"], UrlStore(), fetch=fetch)
    assert result.outcomes[0].status is SiteStatus.FAILURE
    assert result.failure_count == 1
    assert fetch.requested == []


def test_fetch_page_mocked():
    "The default fetcher decodes pages and turns non-2xx responses into FetchError."
    response = MagicMock()
    response.status = 200
    response.headers = {"content-type": "text/html; charset=utf-8"}
    response.data = b'<a href="/a">a</a>'
    with patch("courlan.batch.HTTP_POOL.request", return_value=response) as request:
        assert fetch_page("https://example.org") == '<a href="/a">a</a>'
        # requested in ASCII form
        assert request.call_args.args == ("GET", "https://example.org")
        assert fetch_page("https://bücher.de") == '<a href="/a">a</a>'
        assert request.call_args.args == ("GET", "https://xn--bcher-kva.de")

        response.status = 500
        with pytest.raises(FetchError, match="HTTP status 500"):
            fetch_page("https://example.org")

        response.status = 200
        response.data = b"<p>ok</p>"
        response.headers = {}
        assert fetch_page("https://example.org") == "<p>ok</p>"

        # unknown charset label falls back to UTF-8
        response.headers = {"content-type": "text/html; charset=bogus"}
        response.data = "<p>ö</p>".encode()
        assert fetch_page("https://example.org") == "<p>ö</p>"

        request.side_effect = Exception("timeout")
        with pytest.raises(FetchError, match="network error"):
            fetch_page("https://example.org")


def test_collect_homepages_default_fetcher():
    "A batch runs end to end with the default fetcher, network mocked out."
    response = MagicMock()
    response.status = 200
    response.headers = {"content-type": "text/html"}
    response.data = HOMEPAGE.encode()
    with patch("courlan.batch.HTTP_POOL.request", return_value=response):
        result = collect_homepages(["https://a.org", "https://b.org"], UrlStore())
    assert result.success_count == 2
    assert [o.added_links for o in result.outcomes] == [2, 2]


def test_site_outcome_immutable():
    "Outcomes are frozen value objects carrying the site and a reason."
    outcome = SiteOutcome("https://x.org", SiteStatus.SUCCESS, "1 new link added", 1)
    assert outcome.url == "https://x.org"
    assert outcome.added_links == 1
    with pytest.raises(FrozenInstanceError):
        outcome.url = "https://y.org"  # type: ignore[misc]
