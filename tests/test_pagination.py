"""Offline tests for resumable, per-page classified listing collection.

These tests never touch the network: every page is served from in-memory fake
HTML and the provider's ``get_html_content`` fetch seam is stubbed. They cover
the four page outcomes (success/empty/parse-failed/blocked/network-error),
resume boundaries, callback isolation and the search/profile URL rules for
both ``PornstarHelper.videos`` and ``Client.search``.
"""

import unittest
from unittest.mock import AsyncMock, patch

from base_api import BaseCore
from base_api.modules import errors as base_errors
from base_api.modules.config import RuntimeConfig, IteratorConfig

from spankbang_api import api as api
from spankbang_api.api import Client, Pornstar
from spankbang_api.modules import errors as provider_errors
from spankbang_api.modules.pagination import (
    PageOutcome,
    PageResult,
    classify_page_html,
    paginate,
)


PROFILE_URL = "https://spankbang.com/pornstar/demo"


def video_page(*titles):
    """Build fake listing HTML containing one video item per title."""
    items = "".join(
        f'<div class="js-video-item"><a href="/id{i}/video/{t}" title="{t}"></a></div>'
        for i, t in enumerate(titles)
    )
    return f'<div x-data="videoList">{items}</div>'


# A list container that parses but holds no video items -> "empty page".
EMPTY_PAGE_HTML = '<div x-data="videoList" data-testid="video-list"></div>'

# HTML that returns fine but has neither the list container nor video items.
BROKEN_PAGE_HTML = "<html><body><h1>redesigned markup</h1><p>no listing here</p></body></html>"


def item_only_config():
    """Construct video models without lazy-loading their (network) HTML."""
    return IteratorConfig(max_page_concurrency=1, max_item_concurrency=1)


class ClassifyPageHtmlTests(unittest.TestCase):
    def test_success_when_items_present(self):
        outcome, count = classify_page_html(video_page("a", "b", "c"))
        self.assertIs(outcome, PageOutcome.SUCCESS)
        self.assertEqual(count, 3)

    def test_empty_when_container_present_but_no_items(self):
        outcome, count = classify_page_html(EMPTY_PAGE_HTML)
        self.assertIs(outcome, PageOutcome.EMPTY)
        self.assertEqual(count, 0)

    def test_parse_failed_when_container_and_items_missing(self):
        outcome, count = classify_page_html(BROKEN_PAGE_HTML)
        self.assertIs(outcome, PageOutcome.PARSE_FAILED)
        self.assertEqual(count, 0)

    def test_loose_items_without_container_are_success(self):
        # A bare video item outside a videoList container must still parse.
        html = '<div data-testid="video-item"><a href="/x/video/y" title="y"></a></div>'
        outcome, count = classify_page_html(html)
        self.assertIs(outcome, PageOutcome.SUCCESS)
        self.assertEqual(count, 1)


class PaginateRangeTests(unittest.TestCase):
    def test_full_range_from_page_one(self):
        numbers, urls = paginate(
            pages=3, resume_from=1, build_url=lambda p: f"https://host/p/{p}"
        )
        self.assertEqual(numbers, [1, 2, 3])
        self.assertEqual(
            urls,
            ["https://host/p/1", "https://host/p/2", "https://host/p/3"],
        )

    def test_resume_skips_earlier_pages(self):
        numbers, urls = paginate(
            pages=5, resume_from=3, build_url=lambda p: f"https://host/p/{p}"
        )
        self.assertEqual(numbers, [3, 4, 5])
        self.assertEqual(
            urls,
            ["https://host/p/3", "https://host/p/4", "https://host/p/5"],
        )

    def test_resume_beyond_pages_yields_nothing(self):
        numbers, urls = paginate(
            pages=2, resume_from=9, build_url=lambda p: f"https://host/p/{p}"
        )
        self.assertEqual(numbers, [])
        self.assertEqual(urls, [])

    def test_resume_equal_to_pages_requests_single_page(self):
        numbers, urls = paginate(
            pages=4, resume_from=4, build_url=lambda p: f"https://host/p/{p}"
        )
        self.assertEqual(numbers, [4])
        self.assertEqual(urls, ["https://host/p/4"])

    def test_resume_below_one_is_rejected(self):
        with self.assertRaises(ValueError):
            paginate(pages=3, resume_from=0, build_url=lambda p: str(p))


class _OfflineListingTestCase(unittest.IsolatedAsyncioTestCase):
    """Shared setup: a real core (never used for network) and fetch stubbing."""

    def setUp(self):
        self.core = BaseCore(RuntimeConfig())
        self.config = item_only_config()
        self.requested_urls = []

    def stub_fetch(self, mapping=None, side_effect=None):
        """Replace the provider fetch seam and record every requested URL."""
        mapping = mapping or {}

        async def fake_fetch(core, url, *, logger=None, owner=None, error_types=None):
            self.requested_urls.append(url)
            if side_effect is not None:
                error = side_effect(url)
                if error is not None:
                    raise error
            if url in mapping:
                return mapping[url]
            raise AssertionError(f"unexpected real fetch for {url}")

        return patch.object(
            api, "get_html_content", AsyncMock(side_effect=fake_fetch)
        )


class ProfileVideosTests(_OfflineListingTestCase):
    def _helper(self):
        return Pornstar(url=f"{PROFILE_URL}/", core=self.core)

    async def test_normal_pages_yield_videos_and_report_success(self):
        html1 = video_page("one", "two")
        html2 = video_page("three")
        records = []
        helper = self._helper()
        with self.stub_fetch(
            {
                PROFILE_URL: html1,
                f"{PROFILE_URL}/2": html2,
            }
        ):
            results = [
                r
                async for r in helper.videos(
                    pages=2,
                    iterator_config=self.config,
                    on_page_result=records.append,
                )
            ]

        self.assertEqual(len(results), 3)
        self.assertTrue(all(r.succeeded for r in results))
        self.assertEqual(
            [r.page for r in records], [1, 2]
        )  # callback page order matches request order
        self.assertEqual(
            [(r.outcome, r.video_count) for r in records],
            [(PageOutcome.SUCCESS, 2), (PageOutcome.SUCCESS, 1)],
        )
        self.assertTrue(all(r.reason is None for r in records))
        self.assertEqual(
            self.requested_urls, [PROFILE_URL, f"{PROFILE_URL}/2"]
        )
        # The callback receives the exact requested URL for each page.
        self.assertEqual([r.url for r in records], self.requested_urls)

    async def test_empty_page_does_not_raise_and_continues(self):
        records = []
        helper = self._helper()
        with self.stub_fetch(
            {
                PROFILE_URL: EMPTY_PAGE_HTML,
                f"{PROFILE_URL}/2": video_page("later"),
            }
        ):
            results = [
                r
                async for r in helper.videos(
                    pages=2,
                    iterator_config=self.config,
                    on_page_result=records.append,
                )
            ]

        self.assertEqual(len(results), 1)  # only the second page produced a video
        self.assertEqual(records[0].outcome, PageOutcome.EMPTY)
        self.assertEqual(records[0].video_count, 0)
        self.assertEqual(records[1].outcome, PageOutcome.SUCCESS)
        # Iteration reached the second page -> the empty page did not abort it.
        self.assertEqual(self.requested_urls, [PROFILE_URL, f"{PROFILE_URL}/2"])

    async def test_parse_failure_does_not_raise_and_continues(self):
        records = []
        helper = self._helper()
        with self.stub_fetch(
            {
                PROFILE_URL: BROKEN_PAGE_HTML,
                f"{PROFILE_URL}/2": video_page("later"),
            }
        ):
            results = [
                r
                async for r in helper.videos(
                    pages=2,
                    iterator_config=self.config,
                    on_page_result=records.append,
                )
            ]

        self.assertEqual(len(results), 1)
        self.assertEqual(records[0].outcome, PageOutcome.PARSE_FAILED)
        self.assertEqual(records[0].video_count, 0)
        self.assertIsNone(records[0].reason)
        self.assertEqual(records[1].outcome, PageOutcome.SUCCESS)

    async def test_blocked_page_is_reported_and_skipped(self):
        records = []

        def effect(url):
            if url == PROFILE_URL:
                return provider_errors.BotDetection("cloudflare challenge")
            return None

        helper = self._helper()
        with self.stub_fetch(
            {f"{PROFILE_URL}/2": video_page("later")}, side_effect=effect
        ):
            results = [
                r
                async for r in helper.videos(
                    pages=2,
                    iterator_config=self.config,
                    on_page_result=records.append,
                )
            ]

        self.assertEqual(len(results), 1)
        self.assertEqual(records[0].outcome, PageOutcome.BLOCKED)
        self.assertEqual(records[0].video_count, 0)
        self.assertIn("BotDetection", records[0].reason)
        self.assertEqual(records[1].outcome, PageOutcome.SUCCESS)

    async def test_network_error_page_is_reported_and_skipped(self):
        records = []

        def effect(url):
            if url == f"{PROFILE_URL}/2":
                return provider_errors.NetworkError("connection reset")
            return None

        helper = self._helper()
        with self.stub_fetch(
            {PROFILE_URL: video_page("first"), f"{PROFILE_URL}/2": ""},
            side_effect=effect,
        ):
            results = [
                r
                async for r in helper.videos(
                    pages=2,
                    iterator_config=self.config,
                    on_page_result=records.append,
                )
            ]

        self.assertEqual(len(results), 1)
        self.assertEqual(records[0].outcome, PageOutcome.SUCCESS)
        self.assertEqual(records[1].outcome, PageOutcome.NETWORK_ERROR)
        self.assertEqual(records[1].video_count, 0)
        self.assertIn("connection reset", records[1].reason)

    async def test_base_bot_protection_error_is_classified_as_blocked(self):
        records = []

        def effect(url):
            if url == PROFILE_URL:
                return base_errors.BotProtectionDetected()
            return None

        helper = self._helper()
        with self.stub_fetch(
            {f"{PROFILE_URL}/2": video_page("later")}, side_effect=effect
        ):
            async for _ in helper.videos(
                pages=2,
                iterator_config=self.config,
                on_page_result=records.append,
            ):
                pass

        self.assertEqual(records[0].outcome, PageOutcome.BLOCKED)
        self.assertEqual(records[1].outcome, PageOutcome.SUCCESS)

    async def test_resume_from_only_requests_requested_range(self):
        records = []
        helper = self._helper()
        with self.stub_fetch(
            {
                f"{PROFILE_URL}/3": video_page("p3"),
                f"{PROFILE_URL}/4": video_page("p4a", "p4b"),
                f"{PROFILE_URL}/5": video_page("p5"),
            }
        ):
            results = [
                r
                async for r in helper.videos(
                    pages=5,
                    resume_from=3,
                    iterator_config=self.config,
                    on_page_result=records.append,
                )
            ]

        # No requests for pages 1 and 2.
        self.assertEqual(
            self.requested_urls,
            [
                f"{PROFILE_URL}/3",
                f"{PROFILE_URL}/4",
                f"{PROFILE_URL}/5",
            ],
        )
        self.assertEqual([r.page for r in records], [3, 4, 5])
        self.assertEqual([r.video_count for r in records], [1, 2, 1])
        self.assertEqual(len(results), 4)

    async def test_resume_beyond_pages_makes_no_request_and_no_callback(self):
        records = []
        helper = self._helper()
        with self.stub_fetch({}):
            results = [
                r
                async for r in helper.videos(
                    pages=3,
                    resume_from=9,
                    iterator_config=self.config,
                    on_page_result=records.append,
                )
            ]

        self.assertEqual(results, [])
        self.assertEqual(records, [])
        self.assertEqual(self.requested_urls, [])

    async def test_callback_exception_does_not_stop_iteration(self):
        helper = self._helper()

        def exploding_callback(result):
            if result.page == 1:
                raise RuntimeError("observer blew up")

        records = []

        def collecting(result):
            records.append(result.page)

        def combined(result):
            exploding_callback(result)
            collecting(result)  # still reached for pages that do not raise

        with self.stub_fetch(
            {
                PROFILE_URL: video_page("a"),
                f"{PROFILE_URL}/2": video_page("b"),
            }
        ):
            results = [
                r
                async for r in helper.videos(
                    pages=2,
                    iterator_config=self.config,
                    on_page_result=combined,
                )
            ]

        # Both pages were fetched and yielded despite the page-1 callback error.
        self.assertEqual(self.requested_urls, [PROFILE_URL, f"{PROFILE_URL}/2"])
        self.assertEqual(records, [2])
        self.assertEqual(len(results), 2)

    async def test_async_callback_exception_is_isolated(self):
        helper = self._helper()

        async def exploding(result):
            if result.page == 1:
                raise ValueError("async observer blew up")

        with self.stub_fetch(
            {
                PROFILE_URL: video_page("a"),
                f"{PROFILE_URL}/2": video_page("b"),
            }
        ):
            results = [
                r
                async for r in helper.videos(
                    pages=2,
                    iterator_config=self.config,
                    on_page_result=exploding,
                )
            ]

        self.assertEqual(self.requested_urls, [PROFILE_URL, f"{PROFILE_URL}/2"])
        self.assertEqual(len(results), 2)

    async def test_no_callback_is_supported(self):
        helper = self._helper()
        with self.stub_fetch(
            {PROFILE_URL: video_page("a"), f"{PROFILE_URL}/2": video_page("b")}
        ):
            results = [
                r
                async for r in helper.videos(
                    pages=2, iterator_config=self.config
                )
            ]
        self.assertEqual(len(results), 2)


class SearchTests(_OfflineListingTestCase):
    def _client(self):
        client = Client.__new__(Client)
        client.core = self.core
        return client

    async def test_search_uses_keyword_page_url_rule_and_reports_pages(self):
        records = []
        client = self._client()
        with self.stub_fetch(
            {
                "https://spankbang.com/s/fortnite/": video_page("a", "b"),
                "https://spankbang.com/s/fortnite/2/": video_page("c"),
            }
        ):
            results = [
                r
                async for r in client.search(
                    query="fortnite",
                    pages=2,
                    iterator_config=self.config,
                    on_page_result=records.append,
                )
            ]

        self.assertEqual(
            self.requested_urls,
            [
                "https://spankbang.com/s/fortnite/",
                "https://spankbang.com/s/fortnite/2/",
            ],
        )
        self.assertEqual(len(results), 3)
        self.assertEqual([r.page for r in records], [1, 2])
        self.assertEqual(records[0].url, "https://spankbang.com/s/fortnite/")
        self.assertEqual(records[1].url, "https://spankbang.com/s/fortnite/2/")

    async def test_search_resume_keeps_query_string_and_page_rule(self):
        records = []
        client = self._client()
        expected = [
            "https://spankbang.com/s/asian+%26+amateur+%2F+bbw/2/?q=hd&p=m&m=20&o=new",
            "https://spankbang.com/s/asian+%26+amateur+%2F+bbw/3/?q=hd&p=m&m=20&o=new",
        ]
        with self.stub_fetch(
            {
                expected[0]: video_page("a"),
                expected[1]: video_page("b", "c"),
            }
        ):
            results = [
                r
                async for r in client.search(
                    query="asian & amateur / bbw",
                    filter="new",
                    quality="hd",
                    duration="20",
                    date="m",
                    pages=3,
                    resume_from=2,
                    iterator_config=self.config,
                    on_page_result=records.append,
                )
            ]

        self.assertEqual(self.requested_urls, expected)
        self.assertEqual([r.page for r in records], [2, 3])
        self.assertEqual([r.video_count for r in records], [1, 2])
        self.assertEqual(len(results), 3)

    async def test_search_resume_beyond_pages_is_empty_silently(self):
        client = self._client()
        records = []
        with self.stub_fetch({}):
            stream = client.search(
                query="fortnite",
                pages=2,
                resume_from=5,
                iterator_config=self.config,
                on_page_result=records.append,
            )
            results = [r async for r in stream]

        self.assertEqual(results, [])
        self.assertEqual(records, [])
        self.assertEqual(self.requested_urls, [])

    async def test_search_mixed_outcomes_keep_iterating(self):
        records = []

        def effect(url):
            if url.endswith("/2/"):
                return provider_errors.BotDetection("blocked")
            if url.endswith("/3/"):
                return provider_errors.NetworkError("offline")
            return None

        client = self._client()
        with self.stub_fetch(
            {
                "https://spankbang.com/s/fortnite/": video_page("a"),
                "https://spankbang.com/s/fortnite/2/": "",
                "https://spankbang.com/s/fortnite/3/": "",
                "https://spankbang.com/s/fortnite/4/": EMPTY_PAGE_HTML,
            },
            side_effect=effect,
        ):
            results = [
                r
                async for r in client.search(
                    query="fortnite",
                    pages=4,
                    iterator_config=self.config,
                    on_page_result=records.append,
                )
            ]

        self.assertEqual(len(results), 1)  # only page 1 had a video
        self.assertEqual(
            [r.outcome for r in records],
            [
                PageOutcome.SUCCESS,
                PageOutcome.BLOCKED,
                PageOutcome.NETWORK_ERROR,
                PageOutcome.EMPTY,
            ],
        )
        self.assertEqual([r.video_count for r in records], [1, 0, 0, 0])
        self.assertEqual([r.page for r in records], [1, 2, 3, 4])


class PageResultDataclassTests(unittest.TestCase):
    def test_page_result_is_frozen_and_carries_reason(self):
        result = PageResult(
            page=2,
            url="https://host/p/2",
            outcome=PageOutcome.NETWORK_ERROR,
            video_count=0,
            reason="NetworkError: boom",
        )
        self.assertEqual(result.page, 2)
        self.assertEqual(result.outcome, PageOutcome.NETWORK_ERROR)
        with self.assertRaises(Exception):
            result.page = 3  # frozen dataclass


if __name__ == "__main__":
    unittest.main()
