"""
Offline tests for the resilient paginator.

A fake page-fetching function returns scripted multi-page "DOM" objects, so the
four required scenarios are exercised without any network access:

1. filtered/sorted address pagination through to the last page,
2. a page whose fetch fails (returns ``None``) after the run had data,
3. a page that extracts zero items,
4. a page that adds no new items (all ids already collected).
"""

from types import SimpleNamespace

from letterboxdpy.utils.utils_url import get_page_url

from models.paginator import StopReason, paginate_ranked_movies

ITEMS_PER_PAGE = 4
BASE_URL = "https://letterboxd.com/tester/list/demo/genre/horror/by/rating/"


def make_dom(page: int):
    """A minimal DOM stand-in; the fake extractor only reads ``.page``."""
    return SimpleNamespace(page=page)


def fake_extractor(dom):
    """Return movie slugs encoded on the fake DOM, or an explicit empty set."""
    return getattr(dom, "movies", {})


class ScriptedFetcher:
    """Callable that maps page URLs to scripted DOMs or fetch failures."""

    def __init__(self, pages: dict):
        self.pages = pages
        self.requested_urls = []

    def __call__(self, url: str):
        self.requested_urls.append(url)
        page = self._page_from_url(url)
        return self.pages.get(page)

    @staticmethod
    def _page_from_url(url: str) -> int:
        marker = "/page/"
        if marker not in url:
            return 1
        segment = url.split(marker, 1)[1].split("/", 1)[0]
        return int(segment)


def movies_for_page(page: int, start: int, count: int) -> dict:
    return {
        f"film-{start + i}": {"name": f"Film {start + i}", "url": f"/film/{start + i}"}
        for i in range(count)
    }


def page_dom(page: int, start: int, count: int):
    return SimpleNamespace(page=page, movies=movies_for_page(page, start, count))


class TestNormalPaginationToLastPage:
    def test_walks_every_page_until_short_final_page(self):
        # Two full pages (4 + 4) and one short page (2) => natural completion.
        pages = {
            1: page_dom(1, 0, 4),
            2: page_dom(2, 4, 4),
            3: page_dom(3, 8, 2),
        }
        fetcher = ScriptedFetcher(pages)
        progress_events = []

        result = paginate_ranked_movies(
            base_url=BASE_URL,
            items_per_page=ITEMS_PER_PAGE,
            extractor_fn=fake_extractor,
            on_progress=lambda current, total, page, ipp: progress_events.append(
                (current, page)
            ),
            fetch_fn=fetcher,
            min_interval=0,
        )

        assert result.stop_reason == StopReason.COMPLETE
        assert result.complete is True
        assert result.interrupted is False
        assert result.pages_fetched == 3
        assert result.stop_page == 3
        assert result.items_collected == 10
        assert len(result.movies) == 10
        assert result.page_item_counts == {1: 4, 2: 4, 3: 2}
        # Ranks are assigned 1..N.
        assert [movie["Rank"] for movie in result.movies] == list(range(1, 11))
        # Page 1 uses the root URL; later pages use /page/N/.
        assert fetcher.requested_urls == [
            get_page_url(BASE_URL, 1),
            get_page_url(BASE_URL, 2),
            get_page_url(BASE_URL, 3),
        ]
        assert [event[1] for event in progress_events] == [1, 2, 3]
        assert progress_events[-1][0] == 10

    def test_single_full_page_is_also_complete(self):
        fetcher = ScriptedFetcher({1: page_dom(1, 0, 3)})
        result = paginate_ranked_movies(
            base_url=BASE_URL,
            items_per_page=ITEMS_PER_PAGE,
            extractor_fn=fake_extractor,
            fetch_fn=fetcher,
            min_interval=0,
        )
        assert result.stop_reason == StopReason.COMPLETE
        assert result.items_collected == 3
        assert result.pages_fetched == 1


class TestFilteredSortedAddressIsPaginated:
    def test_page_urls_preserve_filter_and_sort_segments(self):
        pages = {
            1: page_dom(1, 0, 4),
            2: page_dom(2, 4, 1),
        }
        fetcher = ScriptedFetcher(pages)
        result = paginate_ranked_movies(
            base_url=BASE_URL,
            items_per_page=ITEMS_PER_PAGE,
            extractor_fn=fake_extractor,
            fetch_fn=fetcher,
            min_interval=0,
        )

        assert result.stop_reason == StopReason.COMPLETE
        assert fetcher.requested_urls[0] == (
            "https://letterboxd.com/tester/list/demo/genre/horror/by/rating/"
        )
        assert fetcher.requested_urls[1] == (
            "https://letterboxd.com/tester/list/demo/genre/horror/by/rating/page/2/"
        )

    def test_progress_without_total_still_reports_pages_and_counts(self):
        pages = {1: page_dom(1, 0, 4), 2: page_dom(2, 4, 2)}
        seen_totals = []
        result = paginate_ranked_movies(
            base_url=BASE_URL,
            items_per_page=ITEMS_PER_PAGE,
            extractor_fn=fake_extractor,
            total_count=None,
            on_progress=lambda current, total, page, ipp: seen_totals.append(total),
            fetch_fn=ScriptedFetcher(pages),
            min_interval=0,
        )
        assert result.complete is True
        # No total is known, yet every page still emits a progress event.
        assert seen_totals == [None, None]
        assert result.items_collected == 6


class TestFetchFailure:
    def test_stops_and_records_failed_page_with_partial_items(self):
        pages = {
            1: page_dom(1, 0, 4),
            2: None,  # request failure after retries exhausted
        }
        fetcher = ScriptedFetcher(pages)
        result = paginate_ranked_movies(
            base_url=BASE_URL,
            items_per_page=ITEMS_PER_PAGE,
            extractor_fn=fake_extractor,
            fetch_fn=fetcher,
            min_interval=0,
        )

        assert result.stop_reason == StopReason.FETCH_FAILED
        assert result.interrupted is True
        assert result.complete is False
        assert result.items_collected == 4
        assert result.pages_fetched == 1
        assert result.stop_page == 2
        assert result.failed_url == get_page_url(BASE_URL, 2)

    def test_failure_on_first_page_returns_empty_result(self):
        result = paginate_ranked_movies(
            base_url=BASE_URL,
            items_per_page=ITEMS_PER_PAGE,
            extractor_fn=fake_extractor,
            fetch_fn=ScriptedFetcher({1: None}),
            min_interval=0,
        )
        assert result.stop_reason == StopReason.FETCH_FAILED
        assert result.items_collected == 0
        assert result.movies == []
        assert result.pages_fetched == 0
        assert result.stop_page == 1


class TestEmptyPage:
    def test_empty_first_page_marks_empty_collection(self):
        empty_dom = SimpleNamespace(page=1, movies={})
        result = paginate_ranked_movies(
            base_url=BASE_URL,
            items_per_page=ITEMS_PER_PAGE,
            extractor_fn=fake_extractor,
            fetch_fn=ScriptedFetcher({1: empty_dom}),
            min_interval=0,
        )
        assert result.stop_reason == StopReason.EMPTY_COLLECTION
        assert result.complete is True
        assert result.items_collected == 0
        assert result.stop_page == 1

    def test_empty_mid_run_page_marks_incomplete(self):
        pages = {
            1: page_dom(1, 0, 4),
            2: SimpleNamespace(page=2, movies={}),
        }
        result = paginate_ranked_movies(
            base_url=BASE_URL,
            items_per_page=ITEMS_PER_PAGE,
            extractor_fn=fake_extractor,
            fetch_fn=ScriptedFetcher(pages),
            min_interval=0,
        )
        assert result.stop_reason == StopReason.EMPTY_PAGE
        assert result.interrupted is True
        assert result.items_collected == 4
        assert result.pages_fetched == 1
        assert result.stop_page == 2


class TestNoNewItems:
    def test_page_with_only_duplicate_ids_stops_as_stalled(self):
        duplicated = SimpleNamespace(
            page=2,
            # Same ids/slugs as page 1: nothing new is added.
            movies=movies_for_page(1, 0, 4),
        )
        pages = {1: page_dom(1, 0, 4), 2: duplicated}
        result = paginate_ranked_movies(
            base_url=BASE_URL,
            items_per_page=ITEMS_PER_PAGE,
            extractor_fn=fake_extractor,
            fetch_fn=ScriptedFetcher(pages),
            min_interval=0,
        )
        assert result.stop_reason == StopReason.NO_NEW_ITEMS
        assert result.interrupted is True
        assert result.items_collected == 4
        assert result.pages_fetched == 2
        assert result.stop_page == 2
        assert result.page_item_counts == {1: 4, 2: 4}

    def test_partial_overlap_still_collects_new_entries(self):
        # Two ids already seen, two genuinely new ones: progress continues.
        mixed = SimpleNamespace(
            page=2,
            movies={
                **movies_for_page(1, 0, 2),  # duplicates
                **movies_for_page(2, 10, 2),  # fresh
            },
        )
        pages = {1: page_dom(1, 0, 4), 2: mixed, 3: page_dom(3, 20, 1)}
        result = paginate_ranked_movies(
            base_url=BASE_URL,
            items_per_page=ITEMS_PER_PAGE,
            extractor_fn=fake_extractor,
            fetch_fn=ScriptedFetcher(pages),
            min_interval=0,
        )
        assert result.stop_reason == StopReason.COMPLETE
        assert result.items_collected == 7


class TestMaxPages:
    def test_respects_max_pages_and_reports_reason(self):
        pages = {
            1: page_dom(1, 0, 4),
            2: page_dom(2, 4, 4),
            3: page_dom(3, 8, 4),
        }
        result = paginate_ranked_movies(
            base_url=BASE_URL,
            items_per_page=ITEMS_PER_PAGE,
            extractor_fn=fake_extractor,
            fetch_fn=ScriptedFetcher(pages),
            max_pages=2,
            min_interval=0,
        )
        assert result.stop_reason == StopReason.MAX_PAGES
        assert result.complete is False
        assert result.interrupted is False
        assert result.pages_fetched == 2
        assert result.stop_page == 2
        assert result.items_collected == 8


class TestZeroTotal:
    def test_zero_total_short_circuits_without_fetching(self):
        fetcher = ScriptedFetcher({})
        result = paginate_ranked_movies(
            base_url=BASE_URL,
            items_per_page=ITEMS_PER_PAGE,
            extractor_fn=fake_extractor,
            total_count=0,
            fetch_fn=fetcher,
            min_interval=0,
        )
        assert result.stop_reason == StopReason.EMPTY_COLLECTION
        assert result.items_collected == 0
        assert fetcher.requested_urls == []


class TestInitialDomReuse:
    def test_cached_first_page_dom_is_not_refetched(self):
        pages = {2: page_dom(2, 4, 2)}
        fetcher = ScriptedFetcher(pages)
        cached = page_dom(1, 0, 4)
        result = paginate_ranked_movies(
            base_url=BASE_URL,
            items_per_page=ITEMS_PER_PAGE,
            extractor_fn=fake_extractor,
            initial_dom=cached,
            fetch_fn=fetcher,
            min_interval=0,
        )
        assert result.stop_reason == StopReason.COMPLETE
        assert result.items_collected == 6
        # Page 1 must come from the cache; only page 2 hits the fetcher.
        assert fetcher.requested_urls == [get_page_url(BASE_URL, 2)]
