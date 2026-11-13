"""Offline tests for the per-file sitemap discovery audit trail.

Every test serves its sitemaps through respx (no network) and asserts both the per-file
outcomes/counters in ``CrawlResult.sitemap`` and that no sitemap problem stops the crawl:
the normal link-driven crawl still ends with its usual ``stopped_because`` reason.
"""

from __future__ import annotations

import gzip
from dataclasses import replace

import httpx
import pytest

import jevcrawl.crawl.sitemap as sitemap_module
from jevcrawl.crawl import crawl, map_site
from jevcrawl.crawl.sitemap import (
    DECOMPRESS_FAILED,
    EMPTY,
    PARSED,
    REQUEST_FAILED,
)
from tests.fixtures.fake_site import BASE, mount_site
from tests.fixtures.jev_fake import FakeJev

GOAL = "How do I file a warranty claim?"
WARRANTY_PAGE = "/support/2023/warranty-claim-form"
DEFAULTS = ("/sitemap.xml", "/sitemap_index.xml", "/wp-sitemap.xml")

URLSET = (
    b'<?xml version="1.0"?><urlset>'
    b"<url><loc>https://help.example.com/jobs</loc></url>"
    b"<url><loc>https://help.example.com/support/2023/warranty-claim-form</loc></url>"
    b"<url><loc>https://other.example.org/warranty-claim</loc></url>"
    b"</urlset>"
)


@pytest.fixture
def world(respx_mock):
    """The fixture help-center plus a fake Jev, both behind respx."""
    return mount_site(respx_mock), FakeJev().install(respx_mock)


def warranty_page(respx_mock):
    """Mount the deep page the sitemap points at; returns the route for call-count asserts."""
    page = (
        "<html><body><h1>Warranty claims</h1><p>To file a warranty claim, send the claim "
        "form within 60 days of delivery.</p></body></html>"
    )
    return respx_mock.get(BASE + WARRANTY_PAGE).mock(
        return_value=httpx.Response(200, text=page, headers={"content-type": "text/html"})
    )


def mount_defaults(respx_mock, *, main: httpx.Response, other: httpx.Response | None = None):
    """Mount the three default sitemap locations; the two fallbacks 404 unless overridden."""
    other = other or httpx.Response(404)
    respx_mock.get(BASE + "/sitemap.xml").mock(return_value=main)
    for path in DEFAULTS[1:]:
        respx_mock.get(BASE + path).mock(return_value=other)


def by_url(result) -> dict[str, dict]:
    return {f["url"]: f for f in result.sitemap.to_dict()["files"]}


async def _async(value):
    """A coroutine returning ``value``, for monkeypatching async helpers."""
    return value


# --------------------------------------------------------------------------- disabled


async def test_sitemap_disabled_is_marked_explicitly(world, config):
    result = await crawl(GOAL, BASE + "/", config)  # the config fixture disables sitemap
    report = result.sitemap.to_dict()
    assert report["enabled"] is False
    assert report["files"] == []
    assert (
        report["files_attempted"],
        report["files_succeeded"],
        report["files_failed"],
        report["files_remaining"],
        report["candidate_links"],
    ) == (0, 0, 0, 0, 0)
    # blocks/pages/stats keep their shape next to the new field
    assert set(result.to_dict()) == {"blocks", "uncertain", "pages", "stats", "sitemap"}
    assert result.stats.stopped_because == "frontier_empty"  # the link-driven crawl still ends


# ------------------------------------------------------------- 1. a normal urlset


async def test_normal_urlset_records_every_file_and_candidates(world, config, respx_mock):
    deep = warranty_page(respx_mock)
    mount_defaults(respx_mock, main=httpx.Response(200, content=URLSET))

    result = await crawl(GOAL, BASE + "/", replace(config, use_sitemap=True), max_pages=3)

    assert deep.call_count == 1 and result.stats.stopped_because == "answered"
    report = result.sitemap.to_dict()
    assert report["enabled"] is True
    assert report["files_attempted"] == 3
    assert report["files_succeeded"] == 1
    assert report["files_failed"] == 2
    assert report["files_remaining"] == 0
    # Only the in-scope warranty URL shares enough goal words to reach the decision model.
    assert report["candidate_links"] == 1

    files = by_url(result)
    main = files[BASE + "/sitemap.xml"]
    assert main["outcome"] == PARSED and main["reason"] is None
    assert main["urls_found"] == 3 and main["truncated"] is False
    for path in DEFAULTS[1:]:
        record = files[BASE + path]
        assert record["outcome"] == REQUEST_FAILED
        assert record["reason"] == "http_404" and record["urls_found"] == 0


# ------------------------------------------------- 2. index followed into a gzip child


async def test_index_and_gzip_child_are_traced(world, config, respx_mock):
    deep = warranty_page(respx_mock)
    index = (
        b"<sitemapindex><sitemap><loc>https://help.example.com/posts-sitemap.xml.gz</loc>"
        b"</sitemap></sitemapindex>"
    )
    mount_defaults(respx_mock, main=httpx.Response(200, content=index))
    respx_mock.get(BASE + "/posts-sitemap.xml.gz").mock(
        return_value=httpx.Response(200, content=gzip.compress(URLSET))
    )

    result = await crawl(GOAL, BASE + "/", replace(config, use_sitemap=True), max_pages=3)

    assert deep.call_count == 1 and result.stats.stopped_because == "answered"
    report = result.sitemap.to_dict()
    assert (
        report["files_attempted"],
        report["files_succeeded"],
        report["files_failed"],
        report["candidate_links"],
    ) == (4, 2, 2, 1)
    files = by_url(result)
    assert files[BASE + "/sitemap.xml"]["outcome"] == PARSED
    assert files[BASE + "/sitemap.xml"]["urls_found"] == 1
    child = files[BASE + "/posts-sitemap.xml.gz"]
    assert child["outcome"] == PARSED
    assert child["urls_found"] == 3 and child["truncated"] is False
    for path in DEFAULTS[1:]:
        assert files[BASE + path]["outcome"] == REQUEST_FAILED


# ------------------------------------------------------- 3. a child request errors


async def test_a_failing_child_is_recorded_and_the_crawl_continues(world, config, respx_mock):
    index = (
        b"<sitemapindex>"
        b"<sitemap><loc>https://help.example.com/broken-sitemap.xml</loc></sitemap>"
        b"<sitemap><loc>https://help.example.com/posts-sitemap.xml</loc></sitemap>"
        b"</sitemapindex>"
    )
    mount_defaults(respx_mock, main=httpx.Response(200, content=index))
    respx_mock.get(BASE + "/broken-sitemap.xml").mock(
        side_effect=httpx.ConnectError("connection refused")
    )
    respx_mock.get(BASE + "/posts-sitemap.xml").mock(
        return_value=httpx.Response(200, content=URLSET)
    )
    deep = warranty_page(respx_mock)

    result = await crawl(GOAL, BASE + "/", replace(config, use_sitemap=True), max_pages=3)

    assert deep.call_count == 1 and result.stats.stopped_because == "answered"
    report = result.sitemap.to_dict()
    assert (
        report["files_attempted"],
        report["files_succeeded"],
        report["files_failed"],
        report["candidate_links"],
    ) == (5, 2, 3, 1)
    broken = by_url(result)[BASE + "/broken-sitemap.xml"]
    assert broken["outcome"] == REQUEST_FAILED and broken["reason"] == "network"
    assert by_url(result)[BASE + "/posts-sitemap.xml"]["outcome"] == PARSED


# --------------------------------------- 3b. corrupt gzip and empty bodies are failures


async def test_corrupt_gzip_and_empty_body_are_distinct_failures(world, config, respx_mock):
    warranty_page(respx_mock)
    respx_mock.get(BASE + "/sitemap.xml").mock(
        return_value=httpx.Response(200, content=b"\x1f\x8bjunk-not-a-real-gzip-stream")
    )
    respx_mock.get(BASE + "/sitemap_index.xml").mock(
        return_value=httpx.Response(200, content=b"<?xml version='1.0'?><urlset></urlset>")
    )
    respx_mock.get(BASE + "/wp-sitemap.xml").mock(
        return_value=httpx.Response(200, content=b"")
    )

    result = await crawl(GOAL, BASE + "/", replace(config, use_sitemap=True), max_pages=2)

    # The crawl still ends normally even though every sitemap file failed.
    assert result.stats.stopped_because in {"frontier_empty", "max_pages"}
    report = result.sitemap.to_dict()
    assert (
        report["files_attempted"],
        report["files_succeeded"],
        report["files_failed"],
        report["candidate_links"],
    ) == (3, 0, 3, 0)
    files = by_url(result)
    corrupt = files[BASE + "/sitemap.xml"]
    assert corrupt["outcome"] == DECOMPRESS_FAILED
    assert corrupt["reason"].startswith("decompress_failed:")
    no_locs = files[BASE + "/sitemap_index.xml"]
    assert no_locs["outcome"] == EMPTY and no_locs["reason"]
    empty = files[BASE + "/wp-sitemap.xml"]
    assert empty["outcome"] == EMPTY and empty["reason"]


# --------------------------------------- 4. gzip decompression cut off by the size cap


async def test_a_gzip_body_truncated_at_the_cap_is_flagged(world, config, respx_mock, monkeypatch):
    # A tiny cap so ordinary-sized content crosses it; the leading locs still decompress.
    monkeypatch.setattr(sitemap_module, "MAX_UNZIPPED_BYTES", 128)
    many_locs = b"".join(
        b"<url><loc>https://help.example.com/support/2023/warranty-claim-form-%d</loc></url>" % i
        for i in range(40)
    )
    payload = b'<?xml version="1.0"?><urlset>' + many_locs + b"</urlset>"
    warranty_page(respx_mock)
    # The truncated locs themselves may be offered and fetched; answer them so none is unmocked.
    respx_mock.get(
        url__regex=r"https://help\.example\.com/support/2023/warranty-claim-form-\d+"
    ).mock(return_value=httpx.Response(404))
    mount_defaults(
        respx_mock,
        main=httpx.Response(200, content=gzip.compress(payload)),
    )

    result = await crawl(GOAL, BASE + "/", replace(config, use_sitemap=True), max_pages=2)

    # The crawl still ends normally despite the truncated discovery.
    assert result.stats.stopped_because in {"answered", "frontier_empty", "max_pages"}
    main = by_url(result)[BASE + "/sitemap.xml"]
    assert main["outcome"] == PARSED  # the partial body still had parseable locs
    assert main["truncated"] is True
    assert 0 < main["urls_found"] < 40  # only the locs that fit before the cap came out


# ------------------------------------------------------- 5. more children than MAX_FILES


async def test_child_count_over_max_files_leaves_a_remaining_count(
    world, config, respx_mock, monkeypatch
):
    cap = 3
    monkeypatch.setattr(sitemap_module, "MAX_FILES", cap)
    n_children = cap + 1  # the index takes one slot, so only cap-1 children fit and two stay unread
    child_urls = [f"https://help.example.com/sitemap-{i}.xml" for i in range(n_children)]
    index = b"<sitemapindex>" + b"".join(
        f"<sitemap><loc>{u}</loc></sitemap>".encode() for u in child_urls
    ) + b"</sitemapindex>"
    respx_mock.get(BASE + "/sitemap.xml").mock(
        return_value=httpx.Response(200, content=index)
    )
    child_body = (
        b"<urlset><url><loc>https://help.example.com/support/2023/warranty-claim-form</loc>"
        b"</url></urlset>"
    )
    for url in child_urls:
        respx_mock.get(url).mock(return_value=httpx.Response(200, content=child_body))
    # The default fallbacks are still queued behind the children.
    for path in DEFAULTS[1:]:
        respx_mock.get(BASE + path).mock(return_value=httpx.Response(404))
    deep = warranty_page(respx_mock)

    result = await crawl(GOAL, BASE + "/", replace(config, use_sitemap=True), max_pages=3)

    assert deep.call_count == 1 and result.stats.stopped_because == "answered"
    report = result.sitemap.to_dict()
    assert report["files_attempted"] == cap
    assert report["files_succeeded"] == cap
    assert report["files_failed"] == 0
    # Two index children (n_children minus the cap-1 that fit) plus the two fallback locations.
    assert report["files_remaining"] == (n_children - (cap - 1)) + len(DEFAULTS[1:])
    assert report["candidate_links"] >= 1
    # Exactly cap files carry per-file records, and none of the unread ones do.
    assert len(report["files"]) == cap
    seen = {f["url"] for f in report["files"]}
    assert child_urls[-1] not in seen


# ------------------------------------------------------- 5b. more URLs than MAX_URLS


async def test_url_count_over_max_urls_stops_reading_and_counts_remaining(
    world, config, respx_mock, monkeypatch
):
    cap = 5
    monkeypatch.setattr(sitemap_module, "MAX_URLS", cap)
    # Bypass robots/default-path discovery: one huge urlset followed by another queued file.
    huge = b"<urlset>" + b"".join(
        b"<url><loc>https://help.example.com/policy/warranty-claim-%d</loc></url>" % i
        for i in range(cap + 3)
    ) + b"</urlset>"
    queued = [BASE + "/sitemap.xml", BASE + "/never-read-sitemap.xml"]
    monkeypatch.setattr(sitemap_module, "_sitemap_files", lambda *a, **k: _async(queued))
    respx_mock.get(BASE + "/sitemap.xml").mock(
        return_value=httpx.Response(200, content=huge)
    )
    respx_mock.get(BASE + "/never-read-sitemap.xml").mock(
        return_value=httpx.Response(200, content=URLSET)
    )

    result = await crawl(GOAL, BASE + "/", replace(config, use_sitemap=True), max_pages=1)

    assert result.stats.stopped_because in {"max_pages", "frontier_empty"}
    report = result.sitemap.to_dict()
    assert report["files_attempted"] == 1 and report["files_succeeded"] == 1
    assert report["files_remaining"] == 1  # the second queued file was never requested
    assert BASE + "/never-read-sitemap.xml" not in {f["url"] for f in report["files"]}


# ------------------------------------------------------------- map carries the report too


async def test_map_result_carries_the_sitemap_audit_trail(world, config, respx_mock):
    warranty_page(respx_mock)
    mount_defaults(respx_mock, main=httpx.Response(200, content=URLSET))

    data = await map_site(
        BASE + "/", GOAL, replace(config, use_sitemap=True), limit=10, max_pages=2
    )

    report = data["sitemap"]
    assert report["enabled"] is True
    assert report["files_attempted"] == 3 and report["files_succeeded"] == 1
    assert report["files_failed"] == 2 and report["candidate_links"] == 1
    files = {f["url"]: f for f in report["files"]}
    assert files[BASE + "/sitemap.xml"]["outcome"] == PARSED
    # urls/pages/stats keep their existing place alongside the new field
    assert {"urls", "pages", "stats", "sitemap"} == set(data)
