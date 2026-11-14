"""Tests for the resumable uncrawled-link manifest in SiteCrawlOrchestrator.

These tests use fully local, in-memory fakes for both the fetch callable and
the link extractor, so no network access or Playwright browser is required.
"""

import pytest

from acon import CrawlConfig, SiteCrawlOrchestrator


SEED_URL = "https://example.com/"

# Seed page links: four same-origin pages plus one external page.
SEED_LINKS = [
    {"href": "/a", "text": "A", "in_nav": False, "in_header_footer": False},
    {"href": "/b", "text": "B", "in_nav": False, "in_header_footer": False},
    {"href": "/c", "text": "C", "in_nav": False, "in_header_footer": False},
    {"href": "/d", "text": "D", "in_nav": False, "in_header_footer": False},
    {"href": "https://other.example.org/x", "text": "External", "in_nav": False, "in_header_footer": False},
]

# Each discovered page links onward to one deeper same-origin page.
PAGE_LINKS = {
    "https://example.com/a": [{"href": "/a1", "text": "A1", "in_nav": False, "in_header_footer": False}],
    "https://example.com/b": [{"href": "/b1", "text": "B1", "in_nav": False, "in_header_footer": False}],
    "https://example.com/c": [{"href": "/c1", "text": "C1", "in_nav": False, "in_header_footer": False}],
    "https://example.com/d": [{"href": "/d1", "text": "D1", "in_nav": False, "in_header_footer": False}],
}

# URLs whose fetch should fail, mapped to a raw failure reason.
FAILING_PAGES: dict[str, str] = {}


class FakeLinkExtractor:
    """Minimal stand-in for LiveDOMLinkExtractor (no browser, no network)."""

    async def start(self, stealth: bool = False) -> None:
        return None

    async def close(self) -> None:
        return None

    async def extract_links(self, fetch_url: str, timeout_s: int):
        from urllib.parse import urljoin

        rows = PAGE_LINKS.get(fetch_url, SEED_LINKS if fetch_url.rstrip("/") == SEED_URL.rstrip("/") else [])
        absolute = []
        for row in rows:
            absolute.append(
                {
                    "href": urljoin(fetch_url, row["href"]),
                    "text": row["text"],
                    "in_nav": row["in_nav"],
                    "in_header_footer": row["in_header_footer"],
                }
            )
        return absolute, "<html></html>"


async def fake_fetch(**kwargs):
    url = kwargs.get("url")
    if url in FAILING_PAGES:
        return {"fetch_status": "error", "failure_reason": FAILING_PAGES[url], "data": []}
    return {"fetch_status": "success", "data": [{"type": "signal", "selector": f"sig:{url}"}]}


def _make_orchestrator() -> SiteCrawlOrchestrator:
    return SiteCrawlOrchestrator(
        fetch_callable=fake_fetch,
        link_extractor=FakeLinkExtractor(),
    )


def _crawled_urls(result: dict) -> set[str]:
    return {page["url"] for page in result["page_summaries"]}


def _uncrawled_urls(result: dict) -> set[str]:
    return {item["url"] for item in result["crawl_meta"]["uncrawled_links"]}


# ---------------------------------------------------------------------------
# 1. Budget exhaustion produces a non-empty, well-formed uncrawled manifest
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_budget_exhaustion_records_uncrawled_manifest():
    brain = _make_orchestrator()
    config = CrawlConfig(max_pages=2, max_depth=3, scan_mode="fast", disable_sampling=True)
    result = await brain.crawl_site(SEED_URL, config)

    assert result["pages_crawled"] == 2
    uncrawled = result["crawl_meta"]["uncrawled_links"]
    assert uncrawled, "expected a non-empty uncrawled manifest after budget exhaustion"

    # Unfetched discovered pages keep the original partial-crawl status.
    assert result["crawl_status"] == "partial"
    # The existing topology/counter fields keep their meaning and shape.
    assert "topology" in result
    assert result["pages_failed"] == 0

    crawled = _crawled_urls(result)
    manifest_urls = _uncrawled_urls(result)

    # The manifest must not contain anything already fetched.
    assert manifest_urls.isdisjoint(crawled)

    # Every entry carries the required fields with correct types.
    for item in uncrawled:
        assert set(item.keys()) == {"url", "parent_url", "depth", "page_type"}
        assert isinstance(item["url"], str) and item["url"]
        assert isinstance(item["depth"], int) and item["depth"] >= 0
        assert isinstance(item["page_type"], str) and item["page_type"]
        assert item["parent_url"] is None or isinstance(item["parent_url"], str)

    # External links never make it into the same-origin manifest.
    assert all("other.example.org" not in item["url"] for item in uncrawled)

    # Seed links discovered but not fetched within the 2-page budget are recorded.
    assert "https://example.com/b" in manifest_urls
    assert "https://example.com/c" in manifest_urls
    assert "https://example.com/d" in manifest_urls

    # Manifest entries are deduplicated.
    assert len(manifest_urls) == len(uncrawled)


# ---------------------------------------------------------------------------
# 2. Feeding the manifest back in resumes the crawl
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_resume_manifest_is_crawled_on_second_run():
    brain = _make_orchestrator()
    first_config = CrawlConfig(max_pages=2, max_depth=3, scan_mode="fast", disable_sampling=True)
    first_result = await brain.crawl_site(SEED_URL, first_config)

    manifest = first_result["crawl_meta"]["uncrawled_links"]
    assert manifest
    first_crawled = _crawled_urls(first_result)

    # Second run: seed plus the previous uncrawled manifest.
    resume_config = CrawlConfig(
        max_pages=4,
        max_depth=3,
        scan_mode="fast",
        disable_sampling=True,
        uncrawled_links=manifest,
    )
    second_result = await brain.crawl_site(SEED_URL, resume_config)
    second_crawled = _crawled_urls(second_result)

    # The seed is always re-crawled, but at least one previously uncrawled
    # same-origin link is now fetched.
    resumed = second_crawled - first_crawled
    assert resumed, "second run should fetch at least one link from the manifest"
    assert any(url.startswith("https://example.com/") for url in resumed)


# ---------------------------------------------------------------------------
# 3. Duplicate manifest entries are never enqueued twice
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_resume_deduplicates_repeated_links():
    brain = _make_orchestrator()
    first_config = CrawlConfig(max_pages=2, max_depth=3, scan_mode="fast", disable_sampling=True)
    first_result = await brain.crawl_site(SEED_URL, first_config)
    manifest = first_result["crawl_meta"]["uncrawled_links"]

    # Deliberately duplicate every entry (plus a normalized-URL duplicate).
    duplicated = list(manifest) + list(manifest)
    for item in manifest:
        duplicated.append({**item, "url": item["url"] + "/"})

    resume_config = CrawlConfig(
        max_pages=10,
        max_depth=3,
        scan_mode="fast",
        disable_sampling=True,
        uncrawled_links=duplicated,
    )
    result = await brain.crawl_site(SEED_URL, resume_config)

    crawled = _crawled_urls(result)
    # Each URL appears at most once in the fetched pages.
    assert len(crawled) == len(result["page_summaries"])

    # A specific duplicated URL is fetched at most once.
    target = manifest[0]["url"].rstrip("/")
    target_hits = [url for url in crawled if url.rstrip("/") == target]
    assert len(target_hits) <= 1


# ---------------------------------------------------------------------------
# 4. Resume entries cannot bypass max_depth
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_resume_respects_max_depth():
    brain = _make_orchestrator()
    manifest = [
        {"url": "https://example.com/deep", "parent_url": SEED_URL, "depth": 5, "page_type": "standard"},
        {"url": "https://example.com/shallow", "parent_url": SEED_URL, "depth": 1, "page_type": "standard"},
    ]
    config = CrawlConfig(
        max_pages=5,
        max_depth=1,
        scan_mode="fast",
        disable_sampling=True,
        uncrawled_links=manifest,
    )
    result = await brain.crawl_site(SEED_URL, config)
    crawled = _crawled_urls(result)

    assert "https://example.com/deep" not in crawled
    assert "https://example.com/shallow" in crawled


# ---------------------------------------------------------------------------
# 5. Failed pages keep normalized failure_reason and adaptive_action
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_failed_pages_are_recorded_with_normalized_reason():
    FAILING_PAGES.clear()
    # Legacy alias that normalize_failure maps onto the canonical extraction_failed reason.
    FAILING_PAGES["https://example.com/a"] = "dom_parse_error"
    try:
        brain = _make_orchestrator()
        config = CrawlConfig(max_pages=2, max_depth=3, scan_mode="fast", disable_sampling=True)
        result = await brain.crawl_site(SEED_URL, config)

        failed_pages = result["crawl_meta"]["failed_pages"]
        assert len(failed_pages) == 1
        record = failed_pages[0]
        assert record["url"] == "https://example.com/a"
        assert record["fetch_status"] != "success"
        # normalize_failure maps the legacy alias onto the canonical reason.
        assert record["failure_reason"] == "extraction_failed"
        assert record["adaptive_action"] in {"slow_down", "continue", "stop", "static_only"}

        # Successful pages are absent from the failure manifest and keep
        # failure_reason=None in their page summary (adaptive_action remains
        # "continue" at the page-result level).
        failed_urls = {item["url"] for item in failed_pages}
        for page in result["page_summaries"]:
            if page["url"] not in failed_urls:
                assert page["fetch_status"] == "success"
                assert page["failure_reason"] is None
        assert SEED_URL.rstrip("/") not in {u.rstrip("/") for u in failed_urls}
        assert result["pages_failed"] == 1
    finally:
        FAILING_PAGES.clear()


# ---------------------------------------------------------------------------
# 6. Empty manifest input preserves the default behavior
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_empty_manifest_matches_default_behavior():
    brain = _make_orchestrator()
    config_default = CrawlConfig(max_pages=2, max_depth=3, scan_mode="fast", disable_sampling=True)
    config_empty = CrawlConfig(
        max_pages=2,
        max_depth=3,
        scan_mode="fast",
        disable_sampling=True,
        uncrawled_links=[],
    )

    result_default = await brain.crawl_site(SEED_URL, config_default)
    result_empty = await brain.crawl_site(SEED_URL, config_empty)

    assert _crawled_urls(result_default) == _crawled_urls(result_empty)
    assert _uncrawled_urls(result_default) == _uncrawled_urls(result_empty)
    assert result_default["crawl_meta"]["failed_pages"] == result_empty["crawl_meta"]["failed_pages"]
