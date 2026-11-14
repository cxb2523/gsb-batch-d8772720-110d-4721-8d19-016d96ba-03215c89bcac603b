"""Offline tests for per-page search outcomes, ordering and early stop.

These tests never touch the network. Synthetic search and video HTML is served
through a stubbed ``fetch_text`` and the real base-api scrape scheduler drives
the stream, so URL encoding, page isolation and close semantics are exercised
end to end.

``Client.search_videos`` yields exactly one :class:`SearchPageResult` per
requested page, in target order. A page outcome carries that page's videos and
distinguishes success (including zero entries) from failure.
"""

import unittest
from unittest.mock import patch
from urllib.parse import unquote, urlsplit

from base_api import (
    ErrorMode,
    RetryPolicy,
    ScrapeOperationError,
    ScrapeStage,
    make_iterator_config,
)
from base_api.modules.config import IteratorConfig, RuntimeConfig

from xnxx_api import api

QUERY = "plain query"


def _video_html(title: str, *, m3u8: str = "https://cdn.example/master.m3u8") -> str:
    """Build a minimal video detail page for the ``html`` media loader."""
    return f"""
    <html><body>
      <div id="video-content">
        <div class="video-title"><strong>{title}</strong></div>
        <div class="video-pic"><img src="https://img.example/poster.jpg"></div>
        <a class="gold-plate">Uploader</a>
        <a class="is-keyword">tag-one</a>
      </div>
      <script>html5player.setVideoHLS('{m3u8}');</script>
    </body></html>
    """


def _search_html(*entries: tuple[str, str]) -> str:
    """Build a search results page from ``(href, title)`` pairs."""
    cards = []
    for index, (href, title) in enumerate(entries):
        cards.append(
            f"""
            <div id="video_{index}" data-eid="eid-{index}">
              <div class="thumb">
                <img src="https://img.example/{index}.jpg"
                     data-videoid="{index}" data-pvv="https://preview.example/{index}">
              </div>
              <div class="thumb-under">
                <p><a href="{href}" title="{title}">{title}</a></p>
              </div>
              <div class="metadata">
                <div class="right"><span class="superfluous">95%</span> 1.2M views</div>
                <span class="video-hd">- 1080p -</span> 10min
              </div>
            </div>
            """
        )
    return f"<html><body>{''.join(cards)}</body></html>"


class StubCore:
    """Minimal stand-in for ``BaseCore`` that returns canned page bodies."""

    def __init__(
        self,
        pages: dict[int, object],
        video_titles: dict[str, str] | None = None,
    ) -> None:
        self.pages = pages
        self.video_titles = video_titles or {}
        self.requested: list[str] = []
        self.configuration = RuntimeConfig()

    async def fetch_text(self, url: str, **_: object) -> str:
        self.requested.append(url)
        path = urlsplit(url).path
        # Video detail requests come from the Video "html" loader.
        if "/video-" in path:
            slug = path.rsplit("/", 1)[-1]
            return _video_html(self.video_titles.get(path, slug.replace("-", " ").title()))
        # Search page URLs end with /<n>; the first page has no suffix.
        marker = path.rstrip("/").rsplit("/", 1)[-1]
        page_number = int(marker) if marker.isdigit() else 0
        outcome = self.pages.get(page_number)
        if isinstance(outcome, BaseException):
            raise outcome
        if outcome is None:
            return _search_html()
        return outcome


def _build_client(core: object) -> api.Client:
    """Create a Client without opening a real session."""
    client = object.__new__(api.Client)
    client.core = core
    return client


def _page_error(url: str, page_index: int) -> Exception:
    from base_api import PageFetchError

    return PageFetchError(url, RuntimeError("blocked"), 1, page_index)


async def _collect(stream) -> list:
    results = []
    async with stream:
        async for result in stream:
            results.append(result)
    return results


class SearchPageOutcomeTests(unittest.IsolatedAsyncioTestCase):
    async def test_each_page_yields_one_outcome_in_order(self):
        core = StubCore(
            {
                0: _search_html(
                    ("/video-aaa/one", "First"),
                    ("/video-bbb/two", "Second"),
                ),
                1: _search_html(("/video-ccc/three", "Third")),
            },
            video_titles={
                "/video-aaa/one": "First",
                "/video-bbb/two": "Second",
                "/video-ccc/three": "Third",
            },
        )
        client = _build_client(core)

        results = await _collect(client.search_videos(QUERY, pages=2))

        self.assertEqual([r.page_index for r in results], [0, 1])
        self.assertTrue(all(r.stage is ScrapeStage.PAGE for r in results))

        first, second = results
        self.assertTrue(first.succeeded and second.succeeded)
        self.assertEqual(first.url, "https://www.xnxx.com/search/plain%20query")
        self.assertEqual(second.url, "https://www.xnxx.com/search/plain%20query/1")
        self.assertEqual(first.page_url, first.url)

        self.assertEqual(first.item_count, 2)
        self.assertEqual(second.item_count, 1)
        self.assertEqual([v.title for v in first.videos], ["First", "Second"])
        self.assertEqual([v.title for v in second.videos], ["Third"])
        # Page results are iterable over their videos too.
        self.assertEqual([v.title for v in first], ["First", "Second"])
        self.assertEqual(
            [v.url for v in first.videos],
            ["https://www.xnxx.com/video-aaa/one", "https://www.xnxx.com/video-bbb/two"],
        )

    async def test_empty_page_is_a_success_with_zero_items(self):
        core = StubCore({0: "<html><body>no results</body></html>"})
        client = _build_client(core)

        results = await _collect(client.search_videos(QUERY, pages=1))

        self.assertEqual(len(results), 1)
        page = results[0]
        self.assertTrue(page.succeeded)
        self.assertEqual(page.item_count, 0)
        self.assertEqual(page.videos, ())
        self.assertEqual(page.items, ())
        self.assertIsNone(page.error)
        self.assertEqual(page.url, "https://www.xnxx.com/search/plain%20query")

    async def test_failed_page_does_not_stop_later_pages(self):
        failure = RuntimeError("blocked by site")
        core = StubCore(
            {
                0: _search_html(("/video-aaa/one", "One")),
                1: failure,
                2: _search_html(("/video-ccc/three", "Three")),
            },
            video_titles={"/video-ccc/three": "Three"},
        )
        client = _build_client(core)
        # One attempt keeps this offline test fast; retry behaviour belongs to
        # base-api and is covered by its own tests.
        config = IteratorConfig(page_retry=RetryPolicy(max_attempts=1))

        results = await _collect(
            client.search_videos(QUERY, pages=3, iterator_config=config)
        )

        self.assertEqual([r.page_index for r in results], [0, 1, 2])
        first, middle, last = results

        self.assertTrue(first.succeeded)
        self.assertEqual([v.title for v in first.videos], ["One"])

        self.assertFalse(middle.succeeded)
        self.assertIsNone(middle.item)
        self.assertIsNotNone(middle.error)
        self.assertEqual(middle.url, "https://www.xnxx.com/search/plain%20query/1")
        self.assertIn(middle.url, str(middle.error))
        self.assertIn("blocked by site", str(middle.error))
        self.assertEqual(middle.error_message, str(middle.error))
        self.assertEqual(middle.item_count, 0)
        with self.assertRaises(ScrapeOperationError):
            middle.unwrap()

        # The page after the failure was still fetched and produced its video.
        self.assertTrue(last.succeeded)
        self.assertEqual([v.title for v in last.videos], ["Three"])
        self.assertIn("https://www.xnxx.com/search/plain%20query/2", core.requested)

    async def test_unparseable_page_is_reported_as_failure(self):
        # Force the extractor to fail for one page only, modelling a layout
        # change or a served error page that cannot be parsed.
        real_extractor = api.extractor_html

        def flaky_extractor(content: str, base_url: str = "https://www.xnxx.com"):
            if 'data-eid="eid-fail"' in content:
                raise ValueError("unexpected layout")
            return real_extractor(content, base_url=base_url)

        core = StubCore(
            {
                0: _search_html().replace(
                    "<body>", '<body><div id="video_9" data-eid="eid-fail">'
                ),
                1: _search_html(("/video-ccc/three", "Three")),
            },
            video_titles={"/video-ccc/three": "Three"},
        )
        client = _build_client(core)
        config = IteratorConfig(page_retry=RetryPolicy(max_attempts=1))

        with patch.object(api, "extractor_html", flaky_extractor):
            results = await _collect(
                client.search_videos(QUERY, pages=2, iterator_config=config)
            )

        self.assertEqual(len(results), 2)
        failed, last = results
        self.assertFalse(failed.succeeded)
        self.assertIn("unexpected layout", str(failed.error))
        self.assertEqual(failed.url, "https://www.xnxx.com/search/plain%20query")
        self.assertTrue(last.succeeded)
        self.assertEqual([v.title for v in last.videos], ["Three"])

    async def test_pages_semantics_are_unchanged(self):
        for pages, expected in ((0, 1), (1, 1), (3, 3)):
            core = StubCore({})
            client = _build_client(core)
            results = await _collect(client.search_videos(QUERY, pages=pages))
            self.assertEqual(len(results), expected)
            self.assertEqual(len(core.requested), expected)

    async def test_item_failure_is_visible_on_the_page(self):
        # One extracted entry points at a video whose HTML cannot be loaded;
        # the page itself succeeds but records the failed entry separately.
        core = StubCore(
            {
                0: _search_html(
                    ("/video-ok/good", "Good"), ("/video-bad/worse", "Worse")
                ),
            },
            video_titles={"/video-ok/good": "Good"},
        )
        client = _build_client(core)
        config = make_iterator_config(
            item_retry=RetryPolicy(max_attempts=1), item_error_mode=ErrorMode.YIELD
        )

        original = StubCore.fetch_text

        async def fetch(self, url, **kwargs):
            if "/video-bad/" in url:
                raise RuntimeError("video page gone")
            return await original(self, url, **kwargs)

        with patch.object(StubCore, "fetch_text", fetch):
            results = await _collect(
                client.search_videos(QUERY, pages=1, iterator_config=config)
            )

        page = results[0]
        self.assertTrue(page.succeeded)
        self.assertEqual([v.title for v in page.videos], ["Good"])
        self.assertEqual(len(page.failed_items), 1)
        self.assertIn("video-bad", str(page.failed_items[0].error))


class SearchUrlEncodingTests(unittest.IsolatedAsyncioTestCase):
    async def test_special_characters_stay_one_query_value(self):
        query = "a&b/# 日本"
        core = StubCore({})
        client = _build_client(core)

        stream = client.search_videos(query, pages=2)
        urls = list(stream.page_urls)
        await stream.aclose()

        self.assertEqual(len(urls), len(set(urls)))
        self.assertEqual(len(urls), 2)

        for url in urls:
            parts = urlsplit(url)
            self.assertEqual(parts.fragment, "", url)
            self.assertEqual(parts.query, "", url)
            self.assertNotIn("#", url)
        self.assertTrue(urls[0].endswith("/a%26b%2F%23%20%E6%97%A5%E6%9C%AC"))
        self.assertTrue(urls[1].endswith("/a%26b%2F%23%20%E6%97%A5%E6%9C%AC/1"))
        # The encoded value decodes back to the original query as one segment.
        self.assertEqual(unquote(urlsplit(urls[0]).path.rsplit("/", 1)[-1]), query)
        self.assertEqual(core.requested, [])

    async def test_special_characters_survive_a_real_scrape(self):
        query = "a&b/# 日本"
        core = StubCore({0: _search_html(), 1: _search_html()})
        client = _build_client(core)

        results = await _collect(client.search_videos(query, pages=2))

        self.assertEqual(
            [r.url for r in results],
            [
                "https://www.xnxx.com/search/a%26b%2F%23%20%E6%97%A5%E6%9C%AC",
                "https://www.xnxx.com/search/a%26b%2F%23%20%E6%97%A5%E6%9C%AC/1",
            ],
        )
        # Both query pages were requested as distinct, fragment-free URLs.
        search_requests = [u for u in core.requested if "/search/" in u]
        self.assertEqual(search_requests, [r.url for r in results])

    async def test_filtered_query_uses_one_value_and_real_pages(self):
        from xnxx_api.modules.search_filters import Length, Mode, UploadTime

        core = StubCore({})
        client = _build_client(core)
        stream = client.search_videos(
            "my query", pages=2, mode=Mode.hits,
            upload_time=UploadTime.month, length=Length.X_10min_plus,
        )
        urls = list(stream.page_urls)
        await stream.aclose()
        self.assertEqual(
            urls,
            [
                "https://www.xnxx.com/search/hits/month/10min+/my%20query",
                "https://www.xnxx.com/search/hits/month/10min+/my%20query/1",
            ],
        )


class SearchEarlyStopTests(unittest.IsolatedAsyncioTestCase):
    async def test_early_stop_closes_underlying_stream(self):
        closed = []

        def outcome(page_index: int) -> api.SearchPageResult:
            return api.SearchPageResult(
                stage=ScrapeStage.PAGE,
                url=f"url-{page_index}",
                page_index=page_index,
                item_index=None,
                attempts=1,
            )

        async def source():
            try:
                # One page failure at index 2 completes pages 0 and 1 too, so a
                # single pull buffers all three outcomes.
                yield api.ScrapeResult(
                    stage=ScrapeStage.PAGE,
                    url="url-2",
                    page_index=2,
                    item_index=None,
                    attempts=1,
                    item=None,
                    error=_page_error("url-2", 2),
                )
            finally:
                closed.append(True)

        stream = api.SearchStream(source(), ["url-0", "url-1", "url-2"])

        first = await anext(stream)
        self.assertEqual(first.page_index, 0)
        self.assertTrue(first.succeeded)

        await stream.aclose()
        await stream.aclose()  # idempotent
        self.assertEqual(closed, [True])

        # Outcomes already produced stay readable after close, then the stream
        # terminates without pulling anything else from the source.
        second = await anext(stream)
        third = await anext(stream)
        self.assertEqual([second.page_index, third.page_index], [1, 2])
        self.assertFalse(third.succeeded)
        with self.assertRaises(StopAsyncIteration):
            await anext(stream)

    async def test_early_stop_cancels_real_scheduler(self):
        core = StubCore(
            {
                0: _search_html(("/video-aaa/one", "One")),
                1: _search_html(("/video-bbb/two", "Two")),
            },
            video_titles={"/video-aaa/one": "One", "/video-bbb/two": "Two"},
        )
        client = _build_client(core)
        stream = client.search_videos(QUERY, pages=2)

        first = await anext(stream)
        self.assertEqual(first.page_index, 0)
        self.assertTrue(first.succeeded)
        self.assertEqual([v.title for v in first.videos], ["One"])
        await stream.aclose()

        with self.assertRaises(StopAsyncIteration):
            await anext(stream)
        for url in core.requested:
            self.assertTrue(
                url.startswith("https://www.xnxx.com/search/plain%20query")
                or "/video-" in url
            )

    async def test_textbook_loop_break_after_enough_results(self):
        core = StubCore(
            {
                0: _search_html(
                    ("/video-aaa/one", "One"),
                    ("/video-bbb/two", "Two"),
                ),
                1: _search_html(("/video-ccc/three", "Three")),
            },
            video_titles={
                "/video-aaa/one": "One",
                "/video-bbb/two": "Two",
                "/video-ccc/three": "Three",
            },
        )
        client = _build_client(core)

        page_indexes: list[int] = []
        videos: list[str] = []
        async with client.search_videos(QUERY, pages=2) as stream:
            async for page in stream:
                page_indexes.append(page.page_index)
                videos.extend(v.title for v in page.videos)
                if len(videos) >= 2:
                    break

        # The caller stopped after the first page's two videos.
        self.assertEqual(page_indexes, [0])
        self.assertEqual(videos, ["One", "Two"])


class SearchStreamSourceStubTests(unittest.IsolatedAsyncioTestCase):
    """Drive SearchStream with a hand-written source for precise scenarios."""

    @staticmethod
    def _item(page_index: int, item_index: int, url: str) -> api.ScrapeResult:
        return api.ScrapeResult(
            stage=ScrapeStage.ITEM,
            url=url,
            page_index=page_index,
            item_index=item_index,
            attempts=1,
            item=object(),
            error=None,
        )

    @staticmethod
    def _failed_item(page_index: int, url: str) -> api.ScrapeResult:
        from base_api import ItemFetchError

        return api.ScrapeResult(
            stage=ScrapeStage.ITEM,
            url=url,
            page_index=page_index,
            item_index=0,
            attempts=1,
            item=None,
            error=ItemFetchError(url, RuntimeError("nope"), 1, page_index, 0),
        )

    @staticmethod
    def _page_failure(page_index: int, url: str) -> api.ScrapeResult:
        from base_api import PageFetchError

        return api.ScrapeResult(
            stage=ScrapeStage.PAGE,
            url=url,
            page_index=page_index,
            item_index=None,
            attempts=2,
            item=None,
            error=PageFetchError(url, RuntimeError("blocked"), 2, page_index),
        )

    async def test_items_are_grouped_into_their_page_outcome(self):
        page_urls = ["p0", "p1", "p2"]

        async def source():
            # Mirrors base-api ResultOrder.ORIGINAL: items in target order and a
            # page-stage result only for a failed page.
            yield self._item(0, 0, "a")
            yield self._item(0, 1, "b")
            yield self._page_failure(1, "p1")
            yield self._item(2, 0, "c")

        results = [r async for r in api.SearchStream(source(), page_urls)]

        self.assertEqual([r.page_index for r in results], [0, 1, 2])
        self.assertEqual([r.succeeded for r in results], [True, False, True])
        self.assertEqual([r.item_count for r in results], [2, 0, 1])
        self.assertEqual([item.url for item in results[0].items], ["a", "b"])
        self.assertEqual([item.url for item in results[2].items], ["c"])
        self.assertIn("p1", str(results[1].error))
        self.assertIn("blocked", str(results[1].error))
        self.assertEqual(results[1].url, "p1")
        self.assertEqual(results[1].attempts, 2)

    async def test_page_outcome_arrives_after_its_items(self):
        page_urls = ["p0", "p1"]

        async def source():
            yield self._item(0, 0, "a")
            yield self._item(1, 0, "b")

        results = [r async for r in api.SearchStream(source(), page_urls)]
        self.assertEqual([r.page_index for r in results], [0, 1])
        self.assertEqual([item.url for item in results[0].items], ["a"])
        self.assertEqual([item.url for item in results[1].items], ["b"])

    async def test_failed_items_are_visible_but_page_succeeds(self):
        async def source():
            yield self._item(0, 0, "a")
            yield self._failed_item(0, "b")

        results = [r async for r in api.SearchStream(source(), ["p0"])]

        self.assertEqual(len(results), 1)
        page = results[0]
        self.assertTrue(page.succeeded)
        self.assertEqual([item.url for item in page.items], ["a"])
        self.assertEqual([item.url for item in page.failed_items], ["b"])

    async def test_page_outcomes_are_never_duplicated(self):
        async def source():
            yield self._item(0, 0, "a")
            yield self._page_failure(0, "p0")
            yield self._page_failure(0, "p0")  # duplicate is ignored

        results = [r async for r in api.SearchStream(source(), ["p0"])]

        self.assertEqual(len(results), 1)
        self.assertFalse(results[0].succeeded)

    async def test_returned_urls_come_from_the_request(self):
        # The page URL is the full requested URL, independent of what the source
        # reports inside its failure object.
        async def source():
            yield self._page_failure(0, "reported-by-source")

        results = [r async for r in api.SearchStream(source(), ["requested-url"])]
        self.assertEqual(results[0].url, "requested-url")


class IteratorConfigOverridesTests(unittest.TestCase):
    def test_failed_pages_are_yielded_regardless_of_caller_mode(self):
        caller = IteratorConfig(page_error_mode=ErrorMode.SKIP, order="completion")
        resolved = api._make_search_iterator_config(caller)
        self.assertEqual(resolved.page_error_mode, ErrorMode.YIELD)
        self.assertEqual(resolved.order.value, "original")
        self.assertIsNone(resolved.page_error_handler)

    def test_default_config_is_built_when_none(self):
        resolved = api._make_search_iterator_config(None)
        self.assertEqual(resolved.page_error_mode, ErrorMode.YIELD)
        self.assertEqual(resolved.order.value, "original")

    def test_item_settings_are_preserved(self):
        caller = IteratorConfig(item_error_mode=ErrorMode.RAISE)
        resolved = api._make_search_iterator_config(caller)
        self.assertEqual(resolved.item_error_mode, ErrorMode.RAISE)


class PageUrlBuilderTests(unittest.TestCase):
    def test_pages_zero_means_one_page(self):
        self.assertEqual(len(api._build_search_page_urls("q", "", "", "", "", 0)), 1)

    def test_unique_urls_without_fragment(self):
        urls = api._build_search_page_urls("a#b", "", "", "", "", 3)
        self.assertEqual(len(urls), 3)
        self.assertEqual(len(set(urls)), 3)
        for url in urls:
            self.assertEqual(urlsplit(url).fragment, "")


class OfflineGuardTests(unittest.TestCase):
    def test_stub_core_has_no_real_session(self):
        # Sanity check: the stub never constructs a real BaseCore/session.
        self.assertFalse(hasattr(StubCore({}), "session"))


if __name__ == "__main__":
    unittest.main()
