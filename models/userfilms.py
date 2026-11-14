"""UserFilms model for handling Letterboxd user watched films."""

from collections.abc import Callable

from letterboxdpy.pages.user_films import (
    UserFilms as BaseUserFilms,
)
from letterboxdpy.pages.user_films import (
    extract_movies_from_user_watched,
)

from models.collection_url import build_user_films_url
from models.paginator import (
    PaginationResult,
    collection_metadata,
    run_collection_pagination,
)


class UserFilms(BaseUserFilms):
    """UserFilms class for handling Letterboxd user watched films with filters."""

    def __init__(
        self,
        username: str,
        filters: str = "",
        sort_by: str | None = None,
    ):
        clean_filters = filters.strip("/") if isinstance(filters, str) else filters
        super().__init__(username=username, filters=clean_filters, sort_by=sort_by)
        # Rebuild the address through the shared construction path so lists,
        # watchlists and films join filter/sort segments identically.
        request = build_user_films_url(
            username, filters=clean_filters or "", sort_by=sort_by
        )
        self.filters = request.filters
        self.sort_by = request.sort_by
        self.url = request.base_url
        self.title = f"{username}'s films"
        # get_count() parses page 1 via the lazy dom property; keep the parsed
        # DOM so pagination can reuse it instead of re-requesting page 1.
        self.count = self.get_count()
        self._dom = getattr(self, "_dom", None)
        self.last_page = self.get_last_page(self.count)
        self.total_count = self.count
        self.fetch_result: PaginationResult | None = None
        self._movies = None

    def fetch_movies(
        self,
        on_progress: Callable | None = None,
        max_pages: int | None = None,
    ) -> list:
        """Scrape and return watched movies with optional progress callback."""
        if self._movies is None:
            self.fetch_result = run_collection_pagination(
                url=self.url,
                items_per_page=self.FILMS_PER_PAGE,
                extractor_fn=extract_movies_from_user_watched,
                initial_dom=self._dom,
                total_count=self.total_count,
                on_progress=on_progress,
                max_pages=max_pages,
            )
            self._movies = self.fetch_result.movies
        return self._movies

    @property
    def movies(self) -> list:
        """Scrape and return all watched movies across pages."""
        return self.fetch_movies()

    def jsonify(self) -> dict:
        """Serialize user films metadata for UI display."""
        return collection_metadata(self, self.fetch_result)
