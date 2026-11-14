"""Offline tests for ChannelModelHelper.videos pagination reporting and resume."""

import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from base_api import ScrapeResult, ScrapeStage
from base_api.modules.urls import update_url_query

from porntrex_api import api as api


PROFILE_URL = "https://www.porntrex.com/models/Example/?sort_by=views&from=09#videos"


class FakeStream:
    """Minimal async stream standing in for scrape_stream's page/item results."""

    def __init__(self, results):
        self._results = list(results)

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self._results:
            raise StopAsyncIteration
        return self._results.pop(0)


def page_failure(result_index, error, page_url="https://example.test/page"):
    return ScrapeResult(
        stage=ScrapeStage.PAGE,
        url=page_url,
        page_index=result_index,
        item_index=None,
        attempts=1,
        error=error,
    )


def item_success(result_index, item_index):
    return ScrapeResult(
        stage=ScrapeStage.ITEM,
        url=f"https://example.test/video/{result_index}-{item_index}",
        page_index=result_index,
        item_index=item_index,
        attempts=1,
        item=api.Video(url=f"https://example.test/video/{result_index}-{item_index}", core=object()),
    )


def profile():
    return api.Model(url=PROFILE_URL, core=object())


class PageOutcomeTests(unittest.IsolatedAsyncioTestCase):
    async def test_normal_multi_page_reports_each_page_in_order(self):
        calls = []

        def on_page(page, succeeded, item_count, error):
            calls.append((page, succeeded, item_count, error))

        with patch.object(
            api,
            "scrape_stream",
            return_value=FakeStream(
                [
                    item_success(0, 0),
                    item_success(0, 1),
                    item_success(1, 0),
                    item_success(1, 1),
                    item_success(1, 2),
                    item_success(2, 0),
                ]
            ),
        ):
            yielded = [result async for result in profile().videos(pages=3, on_page=on_page)]

        self.assertEqual([call[0] for call in calls], [1, 2, 3])
        self.assertEqual([call[1] for call in calls], [True, True, True])
        self.assertEqual([call[2] for call in calls], [2, 3, 1])
        self.assertEqual([call[3] for call in calls], [None, None, None])
        self.assertEqual(len(yielded), 6)

    async def test_middle_page_failure_is_reported_and_collection_continues(self):
        calls = []
        failure = RuntimeError("page 2 exploded")

        def on_page(page, succeeded, item_count, error):
            calls.append((page, succeeded, item_count, error))

        with patch.object(
            api,
            "scrape_stream",
            return_value=FakeStream(
                [
                    item_success(0, 0),
                    page_failure(1, failure),
                    item_success(2, 0),
                    item_success(2, 1),
                ]
            ),
        ):
            yielded = [result async for result in profile().videos(pages=3, on_page=on_page)]

        self.assertEqual([call[0] for call in calls], [1, 2, 3])
        self.assertEqual([call[1] for call in calls], [True, False, True])
        self.assertIs(calls[1][3], failure)
        self.assertEqual(calls[0][2], 1)
        self.assertEqual(calls[2][2], 2)
        # A failed page is never reported as a successful zero-item page.
        self.assertFalse(calls[1][1])
        self.assertIsNotNone(calls[1][3])
        self.assertEqual(len(yielded), 3)

    async def test_start_page_resumes_without_requesting_earlier_pages(self):
        calls = []

        def on_page(page, succeeded, item_count, error):
            calls.append((page, succeeded, item_count, error))

        with patch.object(
            api,
            "scrape_stream",
            return_value=FakeStream([item_success(0, 0), item_success(1, 0)]),
        ) as stream:
            yielded = [
                result
                async for result in profile().videos(pages=3, start_page=2, on_page=on_page)
            ]

        urls = stream.call_args.kwargs["target_page_urls"]
        self.assertEqual(
            [parse_qs(urlsplit(url).query)["from"] for url in urls], [["02"], ["03"]]
        )
        self.assertTrue(
            all(parse_qs(urlsplit(url).query)["sort_by"] == ["views"] for url in urls)
        )
        self.assertEqual([call[0] for call in calls], [2, 3])
        self.assertEqual([call[1] for call in calls], [True, True])
        self.assertEqual([call[2] for call in calls], [1, 1])
        self.assertEqual(len(yielded), 2)

    async def test_async_callback_failure_does_not_stop_later_pages(self):
        calls = []

        async def on_page(page, succeeded, item_count, error):
            calls.append((page, succeeded, item_count, error))
            if page == 1:
                raise RuntimeError("callback failure")

        with patch.object(
            api,
            "scrape_stream",
            return_value=FakeStream([item_success(0, 0), item_success(1, 0), item_success(2, 0)]),
        ):
            yielded = [result async for result in profile().videos(pages=3, on_page=on_page)]

        self.assertEqual([call[0] for call in calls], [1, 2, 3])
        self.assertTrue(all(call[1] for call in calls))
        self.assertEqual(len(yielded), 3)

    async def test_start_page_without_callback_only_requests_remaining_pages(self):
        with patch.object(api, "scrape_stream", return_value=FakeStream([])) as stream:
            _ = [result async for result in profile().videos(pages=4, start_page=3)]

        urls = stream.call_args.kwargs["target_page_urls"]
        self.assertEqual(
            [parse_qs(urlsplit(url).query)["from"] for url in urls], [["03"], ["04"]]
        )
        self.assertTrue(
            all(parse_qs(urlsplit(url).query)["sort_by"] == ["views"] for url in urls)
        )

    async def test_default_call_keeps_page_urls_and_stream_configuration(self):
        with patch.object(api, "scrape_stream", return_value=FakeStream([])) as stream:
            _ = [result async for result in profile().videos(pages=2)]

        kwargs = stream.call_args.kwargs
        expected = [
            update_url_query(
                PROFILE_URL.replace("#videos", ""),
                mode="async",
                function="get_block",
                block_id="list_videos_common_videos_list_norm",
                sort_by="views",
                **{"from": f"{page:02d}", "_": None},
            )
            for page in (1, 2)
        ]
        self.assertEqual(kwargs["target_page_urls"], expected)
        self.assertIsNone(kwargs["iterator_config"])
        self.assertEqual(
            [parse_qs(urlsplit(url).query)["from"] for url in kwargs["target_page_urls"]],
            [["01"], ["02"]],
        )
        self.assertTrue(all(not urlsplit(url).fragment for url in kwargs["target_page_urls"]))


if __name__ == "__main__":
    unittest.main()
