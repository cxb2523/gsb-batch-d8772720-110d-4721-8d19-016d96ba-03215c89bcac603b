"""
Offline integration tests for the three collection model classes.

Network access is fully replaced by monkeypatching the low-level DOM fetch and
the movie extractor, proving each model:

* builds its request address through the shared ``collection_url`` path,
* paginates through :mod:`models.paginator`,
* records stop-page / stop-reason diagnostics on an interrupted run.
"""

from types import SimpleNamespace

import letterboxdpy.pages.user_list as user_list_page
from letterboxdpy.pages import user_films as user_films_page

from models.paginator import StopReason
from models.userfilms import UserFilms
from models.userlist import UserList
from models.watchlist import WatchList

ITEMS = 100


def _movies(dom):
    """Fake vertical-list extractor returning a full page of fake movies."""
    return {
        f"film-{i}": {"name": f"Film {i}", "url": f"/film/film-{i}"}
        for i in range(ITEMS)
    }


def _films_movies(dom):
    """Fake user-watched extractor (72 entries, the films page size)."""
    return {
        f"film-{i}": {
            "name": f"Film {i}",
            "url": f"/film/film-{i}",
            "rating": None,
            "liked": False,
            "id": i,
        }
        for i in range(72)
    }


def _failing_fetch(url):
    """Page 1 succeeds; every later page fails (exhausted retries)."""
    return None if "/page/" in url else SimpleNamespace(ok=True)


class _ListPatches:
    """Patch the metadata lookups the List base class performs in __init__."""

    def __init__(self, monkeypatch):
        self.monkeypatch = monkeypatch

    def __enter__(self):
        mp = self.monkeypatch
        mp.setattr(user_list_page, "parse_url", lambda url: SimpleNamespace())
        mp.setattr(user_list_page, "extract_count", lambda dom: 250)
        mp.setattr(user_list_page, "get_list_last_page", lambda dom, count=0: 3)
        mp.setattr(user_list_page, "extract_title", lambda dom: "Title")
        mp.setattr(user_list_page, "extract_author", lambda dom: "Author")
        mp.setattr(user_list_page, "extract_description", lambda dom: "")
        mp.setattr(user_list_page, "extract_date_created", lambda dom: None)
        mp.setattr(user_list_page, "extract_date_updated", lambda dom: None)
        mp.setattr(user_list_page, "extract_tags", lambda dom: [])
        mp.setattr(user_list_page, "extract_list_id", lambda dom: "1")
        return self

    def __exit__(self, *exc):
        self.monkeypatch.undo()
        return False


def _patch_network(monkeypatch, fetch=_failing_fetch, extractor=_movies):
    import models.paginator as paginator_module
    import models.watchlist as watchlist_module

    # The paginator resolves the fetcher from its own globals, while the
    # watchlist constructor imported the same name directly; patch both so no
    # test can fall through to a real network request.
    monkeypatch.setattr(paginator_module, "fetch_dom_with_retry", fetch)
    monkeypatch.setattr(watchlist_module, "fetch_dom_with_retry", fetch)
    monkeypatch.setattr(
        "letterboxdpy.utils.movies_extractor.extract_movies_from_vertical_list",
        extractor,
    )


class TestUserListModel:
    def test_filtered_sort_url_and_failure_diagnostics(self, monkeypatch):
        with _ListPatches(monkeypatch):
            _patch_network(monkeypatch)
            collection = UserList(
                "fan",
                "top-100",
                filters="decade/1990s/genre/crime",
                sort_by="rating",
            )

            assert collection.url == (
                "https://letterboxd.com/fan/list/top-100/"
                "decade/1990s/genre/crime/by/rating/"
            )
            assert collection.filters == "decade/1990s/genre/crime"
            assert collection.sort_by == "rating"
            # Filtered lists cannot know a total.
            assert collection.total_count is None

            movies = collection.fetch_movies()
            result = collection.fetch_result

        assert len(movies) == ITEMS
        assert result.stop_reason == StopReason.FETCH_FAILED
        assert result.stop_page == 2
        assert result.pages_fetched == 1
        assert result.interrupted is True
        assert result.failed_url.endswith(
            "top-100/decade/1990s/genre/crime/by/rating/page/2/"
        )
        assert collection.jsonify()["pagination"]["stop_reason"] == "fetch_failed"

    def test_unfiltered_list_keeps_known_total(self, monkeypatch):
        with _ListPatches(monkeypatch):
            # Marker lets the cached DOM be distinguished from a fetch failure.
            monkeypatch.setattr(
                user_list_page,
                "parse_url",
                lambda url: SimpleNamespace(cached_page_one=True),
            )
            _patch_network(monkeypatch)
            collection = UserList("fan", "top-100")
            assert collection.url == "https://letterboxd.com/fan/list/top-100/"
            assert collection.total_count == 250
            collection.fetch_movies()
        # Page 1 is the cached parent-class DOM; page 2 then fails to fetch.
        assert collection.fetch_result.stop_reason == StopReason.FETCH_FAILED
        assert collection.fetch_result.stop_page == 2


class TestWatchListModel:
    def test_filtered_sort_url_and_failure_diagnostics(self, monkeypatch):
        _patch_network(monkeypatch)

        collection = WatchList(
            SimpleNamespace(watchlist_length=None),
            "fan",
            filters="genre/horror",
            sort_by="popular",
        )

        assert collection.url == (
            "https://letterboxd.com/fan/watchlist/genre/horror/by/popular/"
        )
        assert collection.filters == "genre/horror"
        assert collection.sort_by == "popular"
        # The fake page-1 DOM carries no count markup, so the count resolves
        # to zero; the filtered total stays unknown for progress reporting.
        assert collection.count == 0
        assert collection.total_count is None

        movies = collection.fetch_movies()
        result = collection.fetch_result

        assert len(movies) == ITEMS
        assert result.stop_reason == StopReason.FETCH_FAILED
        assert result.stop_page == 2
        assert result.failed_url.endswith("watchlist/genre/horror/by/popular/page/2/")
        assert collection.jsonify()["pagination"]["items_collected"] == ITEMS

    def test_cached_watchlist_length_skips_initial_fetch(self, monkeypatch):
        calls = []

        def recording_fetch(url):
            calls.append(url)
            return _failing_fetch(url)

        _patch_network(monkeypatch, fetch=recording_fetch)
        user = SimpleNamespace(watchlist_length=56)
        collection = WatchList(user, filters="genre/drama")
        # No constructor fetch because the cached length was trusted.
        assert collection.count == 56
        assert collection.total_count is None
        collection.fetch_movies()
        assert calls[0].endswith("/watchlist/genre/drama/")
        assert collection.fetch_result.stop_reason == StopReason.FETCH_FAILED


class TestUserFilmsModel:
    def test_filtered_sort_url_and_failure_diagnostics(self, monkeypatch):
        monkeypatch.setattr(user_films_page, "parse_url", lambda url: SimpleNamespace())
        monkeypatch.setattr(user_films_page, "extract_count", lambda dom: 140)

        import models.paginator as paginator_module
        import models.userfilms as local_userfilms

        monkeypatch.setattr(paginator_module, "fetch_dom_with_retry", _failing_fetch)
        monkeypatch.setattr(
            local_userfilms,
            "extract_movies_from_user_watched",
            _films_movies,
        )

        collection = UserFilms(
            "fan", filters="rated/4/decade/2010s", sort_by="entry-rating"
        )
        assert collection.url == (
            "https://letterboxd.com/fan/films/rated/4/decade/2010s/by/entry-rating/"
        )

        movies = collection.fetch_movies()
        result = collection.fetch_result

        assert len(movies) == 72
        assert result.stop_reason == StopReason.FETCH_FAILED
        assert result.stop_page == 2
        assert result.failed_url.endswith(
            "films/rated/4/decade/2010s/by/entry-rating/page/2/"
        )
        assert collection.jsonify()["pagination"]["stop_reason"] == "fetch_failed"

    def test_completion_on_short_final_page(self, monkeypatch):
        monkeypatch.setattr(user_films_page, "parse_url", lambda url: SimpleNamespace())
        monkeypatch.setattr(user_films_page, "extract_count", lambda dom: 5)

        import models.paginator as paginator_module
        import models.userfilms as local_userfilms

        monkeypatch.setattr(
            paginator_module,
            "fetch_dom_with_retry",
            lambda url: SimpleNamespace(ok=True),
        )

        def five_movies(dom):
            return {
                f"film-{i}": dict(_films_movies(dom)[f"film-{i}"]) for i in range(5)
            }

        monkeypatch.setattr(
            local_userfilms,
            "extract_movies_from_user_watched",
            five_movies,
        )

        collection = UserFilms("fan")
        collection.fetch_movies()
        assert collection.fetch_result.stop_reason == StopReason.COMPLETE
        assert collection.fetch_result.items_collected == 5
        assert collection.fetch_result.complete is True
