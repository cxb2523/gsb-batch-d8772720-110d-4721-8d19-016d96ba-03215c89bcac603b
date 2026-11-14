"""
Unit tests for Cuyahoga County Emergency Services Advisory Board.
"""

from pathlib import Path
from unittest.mock import patch

import pytest
from playwright.async_api import TimeoutError, async_playwright

from harambe_scrapers.cuya_emergency_services_advisory import (
    CuyaEmergencyServicesOrchestrator,
    DetailSDK,
    ListingSDK,
)
from harambe_scrapers.extractor.cuya_emergency_services_advisory.detail import (
    REASON_MISSING_DATE,
    REASON_MISSING_TITLE,
    REASON_SHELL_NO_LINK,
    STATUS_INVALID,
    STATUS_VALID,
    scrape as detail_scrape,
)
from harambe_scrapers.extractor.cuya_emergency_services_advisory.listing import (
    scrape as listing_scrape,
)

FIXTURE_DIR = Path(__file__).parent / "files"

# Short selector timeout so the shell-page tests do not wait the full
# production timeout. No real network is used in any test.
TEST_WAIT_TIMEOUT = 500


def _read_fixture(name):
    with open(FIXTURE_DIR / name, "r", encoding="utf-8") as f:
        return f.read()


@pytest.fixture
def fixture_html():
    return _read_fixture("cuya_emergency_services_advisory.html")


@pytest.fixture
def fixture_detail_html():
    return _read_fixture("cuya_emergency_services_advisory_detail.html")


@pytest.fixture
def fixture_missing_title_html():
    return _read_fixture("cuya_emergency_services_advisory_detail_missing_title.html")


@pytest.fixture
def fixture_missing_date_html():
    return _read_fixture("cuya_emergency_services_advisory_detail_missing_date.html")


@pytest.fixture
def fixture_shell_no_link_html():
    return _read_fixture("cuya_emergency_services_advisory_detail_shell_no_link.html")


@pytest.mark.asyncio
async def test_listing_scraper_extracts_event_urls_from_calendar(fixture_html):
    """Test that listing scraper correctly extracts event URLs from calendar HTML"""
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        await page.set_content(fixture_html)

        event_urls = []
        sdk = ListingSDK(page, event_urls)

        await listing_scrape(
            sdk,
            (
                "https://cuyahogacounty.gov/boards-and-commissions/"
                "board-details/other/emergency-services-advisory-board"
                "?year=2024"
            ),
            {},
        )

        assert len(event_urls) > 0

        expected_urls = [
            (
                "/boards-and-commissions/bc-event-detail//"
                "2024/12/12/ccesab-calendar/12-12-24---ccesab-main"
            ),
            (
                "/boards-and-commissions/bc-event-detail//"
                "2024/11/13/ccesab-calendar/"
                "11-13-24---fire-committee-meeting"
            ),
            (
                "/boards-and-commissions/bc-event-detail//"
                "2024/10/10/ccesab-calendar/10-10-24---ccesab-main"
            ),
        ]

        for expected_url in expected_urls:
            assert expected_url in event_urls

        await browser.close()


@pytest.mark.asyncio
async def test_orchestrator_converts_relative_urls_to_absolute():
    """Test that orchestrator correctly converts relative URLs to absolute URLs"""
    orchestrator = CuyaEmergencyServicesOrchestrator(headless=True)
    orchestrator.year_urls = ["emergency-services-advisory-board?year=2024"]

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()

        with patch(
            "harambe_scrapers.cuya_emergency_services_advisory." "listing_scrape"
        ) as mock_listing:
            mock_listing.return_value = None

            await orchestrator.run_listing_stage(page)

            assert orchestrator.year_urls[0].startswith("https://")
            assert "emergency-services-advisory-board?year=2024" in (
                orchestrator.year_urls[0]
            )

        await browser.close()


DETAIL_URL = (
    "https://cuyahogacounty.gov/boards-and-commissions/"
    "bc-event-detail/2024/01/09/ccesab-calendar/"
    "01-09-24---ccesab-emergency-management-committee"
)


@pytest.mark.asyncio
async def test_detail_scraper_extracts_meeting_data_from_html(fixture_detail_html):
    """Test detail scraper extracts title, time, location, and links from HTML"""
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        await page.set_content(fixture_detail_html)

        sdk = DetailSDK(page)
        result = await detail_scrape(sdk, DETAIL_URL, {})

        assert sdk.data is not None
        assert result["status"] == STATUS_VALID

        assert sdk.data["title"] == "01/09/24 - CCESAB Emergency Management Committee"
        assert "2024-01-09" in sdk.data["start_time"]
        assert "09:00" in sdk.data["start_time"]
        assert "10:00" in sdk.data["end_time"]

        location = sdk.data["location"]
        assert location is not None
        assert "4747 East 49th Street" in location["address"]
        assert "Cleveland" in location["address"]

        links = sdk.data["links"]
        assert len(links) >= 1
        assert any("agenda" in link["title"].lower() for link in links)
        assert any("010924-emagenda.pdf" in link["url"] for link in links)

        assert sdk.data["classification"] == "COMMITTEE"
        assert sdk.data["is_cancelled"] is False

        # The valid payload is returned unchanged from the saved data.
        assert result["title"] == sdk.data["title"]
        assert result["start_time"] == sdk.data["start_time"]
        assert result["end_time"] == sdk.data["end_time"]
        assert result["location"] == sdk.data["location"]
        assert result["links"] == sdk.data["links"]
        assert result["classification"] == sdk.data["classification"]
        assert result["is_cancelled"] == sdk.data["is_cancelled"]

        await browser.close()


@pytest.mark.asyncio
async def test_detail_scraper_missing_title_returns_invalid_record(
    fixture_missing_title_html,
):
    """A detail page without a usable title yields an invalid record, not saved."""
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        await page.set_content(fixture_missing_title_html)

        sdk = DetailSDK(page)
        result = await detail_scrape(
            sdk, DETAIL_URL, {"wait_timeout": TEST_WAIT_TIMEOUT}
        )

        assert result["status"] == STATUS_INVALID
        assert result["url"] == DETAIL_URL
        assert result["reason"] == REASON_MISSING_TITLE
        # Invalid records must never enter the save flow.
        assert sdk.data is None

        await browser.close()


@pytest.mark.asyncio
async def test_detail_scraper_missing_date_returns_invalid_record(
    fixture_missing_date_html,
):
    """A detail page without date elements yields an invalid record, not saved."""
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        await page.set_content(fixture_missing_date_html)

        sdk = DetailSDK(page)
        result = await detail_scrape(
            sdk, DETAIL_URL, {"wait_timeout": TEST_WAIT_TIMEOUT}
        )

        assert result["status"] == STATUS_INVALID
        assert result["url"] == DETAIL_URL
        assert result["reason"] == REASON_MISSING_DATE
        # Invalid records must never enter the save flow.
        assert sdk.data is None

        await browser.close()


@pytest.mark.asyncio
async def test_detail_scraper_shell_page_without_link_returns_invalid_record(
    fixture_shell_no_link_html,
):
    """A redirect shell page without a followable link yields an invalid record."""
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        await page.set_content(fixture_shell_no_link_html)

        sdk = DetailSDK(page)
        result = await detail_scrape(
            sdk, DETAIL_URL, {"wait_timeout": TEST_WAIT_TIMEOUT}
        )

        assert result["status"] == STATUS_INVALID
        assert result["url"] == DETAIL_URL
        # Shell-page failures use a reason distinct from missing fields.
        assert result["reason"] == REASON_SHELL_NO_LINK
        assert result["reason"] not in (REASON_MISSING_TITLE, REASON_MISSING_DATE)
        # Invalid records must never enter the save flow.
        assert sdk.data is None

        await browser.close()


def _valid_meeting():
    return {
        "status": STATUS_VALID,
        "title": "01/09/24 - CCESAB Emergency Management Committee",
        "description": "",
        "classification": "COMMITTEE",
        "start_time": "2024-01-09T09:00:00-05:00",
        "end_time": "2024-01-09T10:00:00-05:00",
        "time_notes": "",
        "is_all_day_event": False,
        "location": {
            "name": "",
            "address": "4747 East 49th Street, Cleveland, OH",
        },
        "links": [
            {
                "url": "https://example.invalid/010924-emagenda.pdf",
                "title": "Agenda",
            }
        ],
        "is_cancelled": False,
    }


@pytest.mark.asyncio
async def test_orchestrator_accounts_for_every_link_and_prints_summary(capsys):
    """Saved / invalid / failed counts and per-link reasons are all reported."""
    orchestrator = CuyaEmergencyServicesOrchestrator(headless=True)
    orchestrator.event_urls = [
        "https://example.invalid/valid",
        "https://example.invalid/missing-title",
        "https://example.invalid/missing-date",
        "https://example.invalid/shell",
        "https://example.invalid/timeout",
    ]

    outcomes = {
        "https://example.invalid/valid": _valid_meeting(),
        "https://example.invalid/missing-title": {
            "status": STATUS_INVALID,
            "url": "https://example.invalid/missing-title",
            "reason": REASON_MISSING_TITLE,
        },
        "https://example.invalid/missing-date": {
            "status": STATUS_INVALID,
            "url": "https://example.invalid/missing-date",
            "reason": REASON_MISSING_DATE,
        },
        "https://example.invalid/shell": {
            "status": STATUS_INVALID,
            "url": "https://example.invalid/shell",
            "reason": REASON_SHELL_NO_LINK,
        },
    }

    async def fake_detail_scrape(sdk, url, context):
        if url == "https://example.invalid/timeout":
            raise TimeoutError("page.goto: Timeout 30000ms exceeded")
        return outcomes[url]

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()

        # No navigation happens: page.goto is stubbed and the extractor is
        # replaced entirely, so no real network access is required.
        async def fake_goto(url, **kwargs):
            return None

        page.goto = fake_goto

        with patch(
            "harambe_scrapers.cuya_emergency_services_advisory.detail_scrape",
            side_effect=fake_detail_scrape,
        ):
            await orchestrator.process_detail_results(page)
            orchestrator.print_detail_summary()

        await browser.close()

    # Three-category accounting.
    assert orchestrator.saved_count == 1
    assert len(orchestrator.invalid_records) == 3
    assert len(orchestrator.failed_records) == 1
    assert orchestrator.saved_count + len(orchestrator.invalid_records) + len(
        orchestrator.failed_records
    ) == len(orchestrator.event_urls)

    # Only the valid meeting was saved.
    assert len(orchestrator.observer.data) == 1
    assert (
        orchestrator.observer.data[0]["name"]
        == "01/09/24 - CCESAB Emergency Management Committee"
    )

    # Invalid records keep their link and reason.
    invalid_by_url = {r["url"]: r for r in orchestrator.invalid_records}
    assert (
        invalid_by_url["https://example.invalid/missing-title"]["reason"]
        == REASON_MISSING_TITLE
    )
    assert (
        invalid_by_url["https://example.invalid/missing-date"]["reason"]
        == REASON_MISSING_DATE
    )
    assert (
        invalid_by_url["https://example.invalid/shell"]["reason"]
        == REASON_SHELL_NO_LINK
    )

    # Unexpected exceptions (e.g. timeouts) are parse failures, not saves.
    failed = orchestrator.failed_records[0]
    assert failed["url"] == "https://example.invalid/timeout"
    assert "TimeoutError" in failed["reason"]

    # Summary output lists all three counts and each problematic link.
    printed = capsys.readouterr().out
    assert "成功保存 (saved): 1" in printed
    assert "无效记录 (invalid): 3" in printed
    assert "解析失败 (failed): 1" in printed
    assert "https://example.invalid/missing-title" in printed
    assert REASON_MISSING_TITLE in printed
    assert "https://example.invalid/missing-date" in printed
    assert REASON_MISSING_DATE in printed
    assert "https://example.invalid/shell" in printed
    assert REASON_SHELL_NO_LINK in printed
    assert "https://example.invalid/timeout" in printed
    assert "TimeoutError" in printed


@pytest.mark.asyncio
async def test_run_detail_stage_records_unexpected_exception_as_failure():
    """A page load timeout surfaces as a failed record, never a saved one."""
    orchestrator = CuyaEmergencyServicesOrchestrator(headless=True)

    class FailingPage:
        async def goto(self, url, **kwargs):
            raise TimeoutError("page.goto: Timeout 30000ms exceeded")

    result = await orchestrator.run_detail_stage(
        FailingPage(), "https://example.invalid/broken"
    )

    assert result["status"] == "failed"
    assert result["url"] == "https://example.invalid/broken"
    assert "TimeoutError" in result["reason"]
    assert orchestrator.saved_count == 0
    assert len(orchestrator.observer.data) == 0
