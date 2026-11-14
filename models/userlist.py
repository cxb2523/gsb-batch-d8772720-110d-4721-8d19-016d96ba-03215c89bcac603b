from collections.abc import Callable

from letterboxdpy.list import List

from models.collection_url import build_list_url
from models.paginator import (
    PaginationResult,
    paginate_vertical_collection,
    pagination_metadata,
)


class UserList(List):
    """UserList class for handling Letterboxd user lists with filter support."""

    def __init__(
        self,
        username: str,
        slug: str,
        filters: str = "",
        sort_by: str | None = None,
    ):
        super().__init__(username, slug, sort_by=sort_by)
        # The shared builder is the single place that joins filter and sort
        # segments, covering both the filtered and the unfiltered cases.
        request = build_list_url(
            self.username, slug, filters=filters, sort_by=self.sort_by
        )
        self.filters = request.filters
        self.sort_by = request.sort_by
        self.url = request.base_url
        self.pages.list.url = self.url
        # The parent class already fetched page 1 for the unfiltered URL; with
        # active filters that DOM represents a different address and must not
        # be reused, so the paginator re-requests page 1.
        self._initial_dom = None if self.filters else self.pages.list.dom
        # Filtered pages report no total, so progress is count-less there.
        self.total_count = None if self.filters else self.count
        self.fetch_result: PaginationResult | None = None
        self._movies = None

    def fetch_movies(
        self,
        on_progress: Callable | None = None,
        max_pages: int | None = None,
    ) -> list:
        """Scrape list movies with progress callback and initial DOM reuse."""
        if self._movies is None:
            self.fetch_result = paginate_vertical_collection(
                url=self.url,
                items_per_page=self.pages.list.FILMS_PER_PAGE,
                initial_dom=self._initial_dom,
                total_count=self.total_count,
                on_progress=on_progress,
                max_pages=max_pages,
            )
            self._movies = self.fetch_result.movies
        return self._movies

    @property
    def movies(self) -> list:
        """Get list movies formatted for dataframe display."""
        return self.fetch_movies()

    def jsonify(self) -> dict:
        """Serialize list metadata plus the last pagination outcome."""
        data = super().jsonify()
        if self.fetch_result is not None:
            data["pagination"] = pagination_metadata(self.fetch_result)
        return data
