"""Offline tests for per-page pagination outcomes.

These tests never touch the network.  Page fetching is replaced with a
controlled fake that serves forged HTML or raises a realistic transport
exception, so the exact page-1 success / page-2 network error / page-3 empty
sequence can be exercised deterministically.
"""

import json
import unittest
from unittest.mock import patch

from xhamster_api import PageOutcome, PageStatus
from xhamster_api.api import Channel, Client, Creator, Short, Video
from xhamster_api.modules.errors import BotDetection, NetworkError, NotFound
from xhamster_api.modules import pagination as pagination_module


def _listing_html(*items: dict) -> str:
    """Build the initials-script HTML a real listing page would carry."""
    payload = {"searchResult": {"videoThumbProps": list(items)}}
    return (
        '<script id="initials-script">window.initials='
        + json.dumps(payload)
        + ";</script>"
    )


def _shorts_html(*items: dict) -> str:
    payload = {"momentsComponent": {"videoListProps": {"videoThumbProps": list(items)}}}
    return (
        '<script id="initials-script">window.initials='
        + json.dumps(payload)
        + ";</script>"
    )


# A page with no initials payload and no DOM video cards parses to zero items.
EMPTY_HTML = "<html><body><div>no results on this page</div></body></html>"

PAGE_ONE_ITEMS = [
    {
        "id": 101,
        "pageURL": "/videos/first-video-xh0001",
        "title": "First Video",
        "duration": 120,
        "imageURL": "https://img.test/first.jpg",
    },
    {
        "id": 102,
        "pageURL": "/videos/second-video-xh0002",
        "title": "Second Video",
        "duration": 240,
        "imageURL": "https://img.test/second.jpg",
    },
]
PAGE_ONE_HTML = _listing_html(*PAGE_ONE_ITEMS)


def make_fake_fetcher(html_by_url: dict[str, str], failures: dict[str, Exception]):
    """Return an async fetch_content replacement keyed by page URL."""

    async def fake_fetch_content(core, url, **kwargs):
        if url in failures:
            raise failures[url]
        if url in html_by_url:
            return html_by_url[url]
        raise AssertionError(f"unexpected URL requested by the scraper: {url}")

    return fake_fetch_content


class PageOutcomeSequenceTests(unittest.IsolatedAsyncioTestCase):
    """The required page-1 ok / page-2 error / page-3 empty sequence."""

    def setUp(self) -> None:
        self.creator = Creator(
            url="https://xhamster.com/creators/some-creator",
            core=object(),  # never used: fetch_content is patched out
        )
        self.page_urls = [
            "https://xhamster.com/creators/some-creator",
            "https://xhamster.com/creators/some-creator/2",
            "https://xhamster.com/creators/some-creator/3",
        ]
        self.network_error = NetworkError(
            "simulated connection reset",
            url=self.page_urls[1],
        )
        self.fake_fetcher = make_fake_fetcher(
            html_by_url={
                self.page_urls[0]: PAGE_ONE_HTML,
                self.page_urls[2]: EMPTY_HTML,
            },
            failures={self.page_urls[1]: self.network_error},
        )

    async def _collect(self, stream):
        # Materialize eagerly so the test observes the complete iteration.
        return [outcome async for outcome in stream]

    async def test_creator_videos_page_outcome_count_and_order(self):
        with patch.object(
            pagination_module, "fetch_content", self.fake_fetcher
        ):
            outcomes = await self._collect(
                self.creator.videos_page_results(pages=3)
            )

        # Exactly one outcome per requested page, in page order.
        self.assertEqual(len(outcomes), 3)
        self.assertTrue(all(isinstance(o, PageOutcome) for o in outcomes))
        self.assertEqual([o.page for o in outcomes], [1, 2, 3])
        self.assertEqual(
            [o.url for o in outcomes], self.page_urls
        )
        self.assertEqual(
            [o.status for o in outcomes],
            [PageStatus.SUCCESS, PageStatus.FAILED, PageStatus.EMPTY],
        )

    async def test_failed_page_carries_readable_reason_and_original_error(self):
        with patch.object(
            pagination_module, "fetch_content", self.fake_fetcher
        ):
            outcomes = await self._collect(
                self.creator.videos_page_results(pages=3)
            )

        failed = outcomes[1]
        self.assertTrue(failed.failed)
        self.assertFalse(failed.succeeded)
        self.assertIs(failed.error, self.network_error)
        self.assertEqual(failed.items, ())
        reason = failed.reason
        self.assertIsInstance(reason, str)
        # The reason must be human-readable and identify both the error type
        # and the underlying message rather than an empty/opaque string.
        self.assertIn("NetworkError", reason)
        self.assertIn("simulated connection reset", reason)

        # Non-failed pages expose no failure reason.
        self.assertIsNone(outcomes[0].reason)
        self.assertIsNone(outcomes[2].reason)

    async def test_successful_page_items_remain_available_after_later_failure(self):
        with patch.object(
            pagination_module, "fetch_content", self.fake_fetcher
        ):
            outcomes = await self._collect(
                self.creator.videos_page_results(pages=3)
            )

        success = outcomes[0]
        self.assertTrue(success.succeeded)
        self.assertEqual(len(success.items), 2)
        self.assertTrue(all(isinstance(v, Video) for v in success.items))
        self.assertEqual(
            [v.url for v in success.items],
            [
                "https://xhamster.com/videos/first-video-xh0001",
                "https://xhamster.com/videos/second-video-xh0002",
            ],
        )
        self.assertEqual(success.items[0].title, "First Video")
        # The extractor passes ids through as strings; Video keeps the raw
        # mapping value until its lazy html loader runs.
        self.assertEqual(success.items[0].video_id, "101")

        empty = outcomes[2]
        self.assertTrue(empty.is_empty)
        self.assertEqual(empty.items, ())
        self.assertIsNone(empty.error)

    async def test_iteration_does_not_stop_after_page_failure(self):
        requested_urls: list[str] = []

        async def recording_fetcher(core, url, **kwargs):
            requested_urls.append(url)
            return await self.fake_fetcher(core, url, **kwargs)

        with patch.object(pagination_module, "fetch_content", recording_fetcher):
            outcomes = await self._collect(
                self.creator.videos_page_results(pages=3)
            )

        # The failure on page 2 must not prevent page 3 from being requested.
        self.assertEqual(requested_urls, self.page_urls)
        # All three pages are observed even though page 2 raised.
        self.assertEqual(len(outcomes), 3)
        self.assertEqual(outcomes[-1].status, PageStatus.EMPTY)


class SearchAndChannelPageOutcomeTests(unittest.IsolatedAsyncioTestCase):
    """The same contract applies to search and channel/creator entry points."""

    async def test_search_videos_page_results_follow_the_contract(self):
        client = Client.__new__(Client)  # avoid real session/network setup
        client.core = object()

        # Derive the exact URLs the client builds (filters become query params).
        page_urls = client._build_search_page_urls(
            "cats",
            minimum_quality="720p",
            sort_by=None,
            category=None,
            vr=False,
            full_length_only=False,
            min_duration=None,
            date=None,
            production=None,
            fps=None,
            pages=3,
        )
        bot_error = BotDetection("cloudflare challenge presented", url=page_urls[1])
        fake_fetcher = make_fake_fetcher(
            html_by_url={page_urls[0]: PAGE_ONE_HTML, page_urls[2]: EMPTY_HTML},
            failures={page_urls[1]: bot_error},
        )

        with patch.object(pagination_module, "fetch_content", fake_fetcher):
            outcomes = [
                o
                async for o in client.search_videos_page_results(
                    query="cats", pages=3
                )
            ]

        self.assertEqual(len(outcomes), 3)
        self.assertEqual([o.page for o in outcomes], [1, 2, 3])
        self.assertEqual(
            [o.status for o in outcomes],
            [PageStatus.SUCCESS, PageStatus.FAILED, PageStatus.EMPTY],
        )
        self.assertEqual([o.url for o in outcomes], page_urls)
        self.assertIn("BotDetection", outcomes[1].reason)
        self.assertEqual(len(outcomes[0].items), 2)
        self.assertIsInstance(outcomes[0].items[0], Video)

    async def test_channel_videos_and_shorts_share_page_result_behavior(self):
        channel = Channel(
            url="https://xhamster.com/channels/some-channel", core=object()
        )
        video_pages = [
            "https://xhamster.com/channels/some-channel",
            "https://xhamster.com/channels/some-channel/2",
        ]
        not_found = NotFound("page gone", url=video_pages[1])
        fake_fetcher = make_fake_fetcher(
            html_by_url={video_pages[0]: PAGE_ONE_HTML},
            failures={video_pages[1]: not_found},
        )

        with patch.object(pagination_module, "fetch_content", fake_fetcher):
            video_outcomes = [
                o async for o in channel.videos_page_results(pages=2)
            ]

        self.assertEqual([o.status for o in video_outcomes],
                         [PageStatus.SUCCESS, PageStatus.FAILED])
        self.assertIn("NotFound", video_outcomes[1].reason)
        self.assertIn("page gone", video_outcomes[1].reason)
        self.assertEqual(len(video_outcomes[0].items), 2)

        # Shorts listing uses the same pagination machinery with Short objects.
        short_item = {
            "id": 900,
            "pageURL": "/shorts/short-moment-xh9",
            "title": "A Short",
            "imageURL": "https://img.test/short.jpg",
            "views": 3,
        }
        shorts_pages = [
            "https://xhamster.com/channels/some-channel/shorts",
            "https://xhamster.com/channels/some-channel/shorts/2",
        ]
        shorts_fetcher = make_fake_fetcher(
            html_by_url={
                shorts_pages[0]: _shorts_html(short_item),
                shorts_pages[1]: EMPTY_HTML,
            },
            failures={},
        )
        with patch.object(pagination_module, "fetch_content", shorts_fetcher):
            short_outcomes = [
                o async for o in channel.shorts_page_results(pages=2)
            ]

        self.assertEqual(
            [o.status for o in short_outcomes],
            [PageStatus.SUCCESS, PageStatus.EMPTY],
        )
        self.assertEqual(len(short_outcomes[0].items), 1)
        self.assertIsInstance(short_outcomes[0].items[0], Short)
        self.assertEqual(
            short_outcomes[0].items[0].url,
            "https://xhamster.com/shorts/short-moment-xh9",
        )

    async def test_pages_argument_still_controls_iteration_length(self):
        client = Client.__new__(Client)
        client.core = object()
        requested: list[str] = []

        async def recording_fetcher(core, url, **kwargs):
            requested.append(url)
            return PAGE_ONE_HTML

        with patch.object(pagination_module, "fetch_content", recording_fetcher):
            outcomes = [
                o
                async for o in client.search_videos_page_results(
                    query="cats", pages=1
                )
            ]

        self.assertEqual(len(outcomes), 1)
        self.assertEqual(len(requested), 1)
        self.assertTrue(all(o.status is PageStatus.SUCCESS for o in outcomes))


class PageOutcomeDataclassTests(unittest.TestCase):
    def test_status_helpers_and_defaults(self):
        ok = PageOutcome(page=1, url="u", status=PageStatus.SUCCESS,
                         items=(object(),))
        empty = PageOutcome(page=2, url="u", status=PageStatus.EMPTY)
        failed = PageOutcome(
            page=3,
            url="u",
            status=PageStatus.FAILED,
            error=NetworkError("boom", url="u"),
        )

        self.assertTrue(ok.succeeded and not ok.failed and not ok.is_empty)
        self.assertTrue(empty.is_empty and empty.items == () and empty.error is None)
        self.assertTrue(failed.failed and failed.items == ())
        self.assertEqual(failed.reason, "NetworkError: boom")

        # Failure without an exception still yields a readable reason.
        mystery = PageOutcome(page=4, url="u", status=PageStatus.FAILED)
        self.assertEqual(mystery.reason, "Unknown page fetch failure")

        # The outcome type is immutable.
        with self.assertRaises(Exception):
            ok.page = 9  # type: ignore[misc]


if __name__ == "__main__":
    unittest.main()
