"""
Tests for the unified filtered/sorted collection URL construction path.

Covers all three collection kinds (user list, watchlist, user films) and
asserts filter/sort segment order, slashes, embedded-sort extraction and
sanitization of malformed input. No network access is performed.
"""

import pytest
from letterboxdpy.constants.project import DOMAIN

from models.collection_url import (
    build_collection_url,
    build_list_url,
    build_user_films_url,
    build_watchlist_url,
    sanitize_filters,
)


class TestSanitizeFilters:
    def test_empty_and_none(self):
        assert sanitize_filters("") == ("", None)
        assert sanitize_filters(None) == ("", None)
        assert sanitize_filters("   ") == ("", None)

    def test_strips_slashes(self):
        filters, sort_by = sanitize_filters("/decade/1990s/genre/crime/")
        assert filters == "decade/1990s/genre/crime"
        assert sort_by is None

    def test_extracts_embedded_sort(self):
        filters, sort_by = sanitize_filters("decade/1990s/genre/crime/by/rating")
        assert filters == "decade/1990s/genre/crime"
        assert sort_by == "rating"

    def test_removes_page_segments(self):
        filters, sort_by = sanitize_filters("genre/horror/page/3/by/popular")
        assert filters == "genre/horror"
        assert sort_by == "popular"

    def test_collapses_duplicate_slashes(self):
        filters, _ = sanitize_filters("decade/1990s//genre/crime/")
        assert filters == "decade/1990s/genre/crime"

    def test_non_string_filters(self):
        assert sanitize_filters(123) == ("", None)


class TestListUrl:
    def test_plain_list_url(self):
        request = build_list_url("fastfingertips", "my-list")
        assert request.base_url == f"{DOMAIN}/fastfingertips/list/my-list/"
        assert request.filters == ""
        assert request.sort_by is None
        assert request.kind == "list"
        assert request.slug == "my-list"

    def test_filters_only(self):
        request = build_list_url(
            "fastfingertips",
            "my-list",
            filters="decade/1990s/genre/crime+-comedy",
        )
        assert request.base_url == (
            f"{DOMAIN}/fastfingertips/list/my-list/decade/1990s/genre/crime+-comedy/"
        )

    def test_filters_and_sort_are_joined_in_one_place(self):
        request = build_list_url(
            "fastfingertips",
            "my-list",
            filters="decade/1990s/genre/crime",
            sort_by="rating",
        )
        assert request.base_url == (
            f"{DOMAIN}/fastfingertips/list/my-list/decade/1990s/genre/crime/by/rating/"
        )
        # Exactly one /by/ segment and it sits after the filter segments.
        assert request.base_url.count("/by/") == 1
        assert request.base_url.index("/decade/") < request.base_url.index("/by/")

    def test_sort_only(self):
        request = build_list_url("fastfingertips", "my-list", sort_by="shuffle")
        assert request.base_url == (f"{DOMAIN}/fastfingertips/list/my-list/by/shuffle/")

    def test_embedded_sort_is_absorbed(self):
        request = build_list_url(
            "fastfingertips", "my-list", filters="genre/horror/by/popular"
        )
        assert request.filters == "genre/horror"
        assert request.sort_by == "popular"
        assert request.base_url == (
            f"{DOMAIN}/fastfingertips/list/my-list/genre/horror/by/popular/"
        )

    def test_explicit_sort_overrides_embedded_sort(self):
        request = build_list_url(
            "fastfingertips",
            "my-list",
            filters="genre/horror/by/popular",
            sort_by="name",
        )
        assert request.sort_by == "name"
        assert request.base_url.endswith("genre/horror/by/name/")
        assert request.base_url.count("/by/") == 1

    def test_replacing_existing_sort_keeps_single_segment(self):
        request = build_list_url(
            "fastfingertips",
            "my-list",
            filters="/genre/horror/by/name/",
            sort_by="release",
        )
        assert request.base_url.count("/by/") == 1
        assert request.base_url.endswith("/by/release/")

    def test_missing_slug_raises(self):
        with pytest.raises(ValueError, match="list slug"):
            build_list_url("fastfingertips", None)


class TestWatchlistUrl:
    def test_plain_watchlist(self):
        request = build_watchlist_url("mubi")
        assert request.base_url == f"{DOMAIN}/mubi/watchlist/"

    def test_filtered_and_sorted_watchlist(self):
        request = build_watchlist_url(
            "mubi", filters="genre/science-fiction", sort_by="date-earliest"
        )
        assert request.base_url == (
            f"{DOMAIN}/mubi/watchlist/genre/science-fiction/by/date-earliest/"
        )
        assert request.kind == "watchlist"
        assert request.slug is None


class TestUserFilmsUrl:
    def test_plain_films(self):
        request = build_user_films_url("scorsese")
        assert request.base_url == f"{DOMAIN}/scorsese/films/"

    def test_full_filter_path_with_rating(self):
        request = build_user_films_url(
            "scorsese",
            filters="rated/4/decade/2010s/genre/drama",
            sort_by="entry-rating",
        )
        assert request.base_url == (
            f"{DOMAIN}/scorsese/films/rated/4/decade/2010s/genre/drama/by/entry-rating/"
        )

    def test_segment_order_is_stable(self):
        request = build_user_films_url(
            "scorsese", filters="genre/drama/decade/2010s", sort_by="popular"
        )
        # The builder preserves the supplied filter order but always puts
        # the sort segment last, so pagination appends /page/N/ cleanly.
        assert request.base_url.startswith(
            f"{DOMAIN}/scorsese/films/genre/drama/decade/2010s/"
        )
        assert request.base_url.endswith("/by/popular/")


class TestCollectionUrlValidation:
    def test_unknown_kind_raises(self):
        with pytest.raises(ValueError, match="Unknown collection kind"):
            build_collection_url("diary", "someone")

    @pytest.mark.parametrize(
        ("kind", "expected_prefix"),
        [
            ("list", f"{DOMAIN}/x/list/slug/"),
            ("watchlist", f"{DOMAIN}/x/watchlist/"),
            ("films", f"{DOMAIN}/x/films/"),
        ],
    )
    def test_all_three_kinds_share_one_builder(self, kind, expected_prefix):
        request = build_collection_url(
            kind, "x", slug="slug" if kind == "list" else None
        )
        assert request.base_url == expected_prefix

    def test_str_returns_base_url(self):
        request = build_watchlist_url("x", filters="genre/horror")
        assert str(request) == request.base_url
