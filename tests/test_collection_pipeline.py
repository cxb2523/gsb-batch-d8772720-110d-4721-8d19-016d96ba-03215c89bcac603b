"""
End-to-end (offline) tests proving all three collection kinds share one
URL-construction path and one pagination path.

A fake fetcher records every requested address while returning scripted pages,
so these tests assert that filter/sort segments survive into paginated URLs for
user lists, watchlists and user films alike.
"""

from types import SimpleNamespace

from letterboxdpy.constants.project import DOMAIN
from letterboxdpy.utils.utils_url import get_page_url

from models.collection_url import (
    build_list_url,
    build_user_films_url,
    build_watchlist_url,
)
from models.paginator import StopReason, paginate_ranked_movies

ITEMS_PER_PAGE = 2


def _extractor(dom):
    return dom.movies


def _page(start, count):
    return SimpleNamespace(
        movies={
            f"film-{start + i}": {
                "name": f"Film {start + i}",
                "url": f"/film/{start + i}",
            }
            for i in range(count)
        }
    )


class RecordingFetcher:
    def __init__(self, pages):
        self.pages = pages
        self.calls = []

    def __call__(self, url):
        self.calls.append(url)
        page = 1 if "/page/" not in url else int(url.split("/page/")[1].split("/")[0])
        return self.pages[page]


def _run(request):
    pages = {1: _page(0, 2), 2: _page(2, 1)}
    fetcher = RecordingFetcher(pages)
    result = paginate_ranked_movies(
        base_url=request.base_url,
        items_per_page=ITEMS_PER_PAGE,
        extractor_fn=_extractor,
        fetch_fn=fetcher,
        min_interval=0,
    )
    return result, fetcher


class TestSharedPathAcrossCollections:
    def test_user_list_filters_and_sort_reach_each_page(self):
        request = build_list_url(
            "fan", "best-of", filters="decade/1990s/genre/crime", sort_by="rating"
        )
        result, fetcher = _run(request)

        assert request.base_url == (
            f"{DOMAIN}/fan/list/best-of/decade/1990s/genre/crime/by/rating/"
        )
        assert fetcher.calls == [
            f"{DOMAIN}/fan/list/best-of/decade/1990s/genre/crime/by/rating/",
            f"{DOMAIN}/fan/list/best-of/decade/1990s/genre/crime/by/rating/page/2/",
        ]
        assert result.stop_reason == StopReason.COMPLETE
        assert result.items_collected == 3

    def test_watchlist_filters_and_sort_reach_each_page(self):
        request = build_watchlist_url("fan", filters="genre/horror", sort_by="popular")
        result, fetcher = _run(request)

        assert fetcher.calls == [
            get_page_url(request.base_url, 1),
            get_page_url(request.base_url, 2),
        ]
        assert fetcher.calls[1].endswith("/watchlist/genre/horror/by/popular/page/2/")
        assert result.complete is True

    def test_user_films_rating_filter_and_sort_reach_each_page(self):
        request = build_user_films_url(
            "fan", filters="rated/4/decade/2010s", sort_by="entry-rating"
        )
        result, fetcher = _run(request)

        assert request.base_url == (
            f"{DOMAIN}/fan/films/rated/4/decade/2010s/by/entry-rating/"
        )
        assert fetcher.calls[1] == (
            f"{DOMAIN}/fan/films/rated/4/decade/2010s/by/entry-rating/page/2/"
        )
        assert result.stop_reason == StopReason.COMPLETE
        assert len(result.movies) == 3

    def test_mid_run_failure_is_surfaced_for_any_collection(self):
        request = build_watchlist_url("fan", filters="genre/drama")
        pages = {1: _page(0, 2), 2: None}
        result = paginate_ranked_movies(
            base_url=request.base_url,
            items_per_page=ITEMS_PER_PAGE,
            extractor_fn=_extractor,
            fetch_fn=RecordingFetcher(pages),
            min_interval=0,
        )
        assert result.stop_reason == StopReason.FETCH_FAILED
        assert result.stop_page == 2
        assert result.items_collected == 2
        assert result.failed_url == get_page_url(request.base_url, 2)
