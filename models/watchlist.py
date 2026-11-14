from collections.abc import Callable

from letterboxdpy.utils.utils_url import extract_path_segment
from letterboxdpy.watchlist import Watchlist

from models.collection_url import build_watchlist_url
from models.paginator import (
    PaginationResult,
    collection_metadata,
    fetch_dom_with_retry,
    paginate_vertical_collection,
)


class WatchList(Watchlist):
    """WatchList class for handling Letterboxd user watchlists."""

    def __init__(
        self,
        target,
        username: str | None = None,
        filters: str = "",
        sort_by: str | None = None,
    ):
        """Initialize WatchList with username or User object, reusing cached count/DOM."""
        if username:
            user = username
        elif hasattr(target, "username") and target.username:
            user = target.username
        elif isinstance(target, str) and "letterboxd.com" in target:
            extracted = extract_path_segment(
                target, after="letterboxd.com/", before="/"
            )
            user = extracted if extracted else target
        else:
            user = str(target)

        self.username = user
        # Filter/sort joining goes through the same construction path as user
        # lists and user films, so no condition can be dropped locally.
        request = build_watchlist_url(user, filters=filters, sort_by=sort_by)
        self.filters = request.filters
        self.sort_by = request.sort_by
        self.url = request.base_url

        self.pages = self.WatchlistPages(self.username, sort_by=self.sort_by)
        self.pages.watchlist.url = self.url
        self._initial_dom = None
        self._movies = None
        self.fetch_result: PaginationResult | None = None

        cached_len = getattr(target, "watchlist_length", None)
        if cached_len is not None:
            self.count = cached_len
            self.last_page = self.get_last_page()
        else:
            self._initial_dom = fetch_dom_with_retry(self.url)
            self.count = self._extract_count_from_dom(self._initial_dom)
            self.last_page = self.get_last_page()

        # Filtered pages expose no total count; fall back to count-less progress.
        self.total_count = None if self.filters else self.count

    @staticmethod
    def _extract_count_from_dom(dom) -> int:
        """Extract watchlist film count from pre-fetched DOM."""
        if not dom or not hasattr(dom, "find"):
            return 0
        wl_div = dom.find("div", class_="s-watchlist-content")
        if wl_div and "data-num-entries" in wl_div.attrs:
            return int(wl_div["data-num-entries"])
        count_span = dom.find("span", class_="js-watchlist-count")
        if count_span:
            return int(count_span.text.split()[0].replace(",", ""))
        return 0

    def fetch_movies(
        self,
        on_progress: Callable | None = None,
        max_pages: int | None = None,
    ) -> list:
        """Scrape watchlist movies with progress callback and initial DOM reuse."""
        if self._movies is None:
            self.fetch_result = paginate_vertical_collection(
                url=self.url,
                items_per_page=self.pages.watchlist.FILMS_PER_PAGE,
                initial_dom=self._initial_dom,
                total_count=self.total_count,
                on_progress=on_progress,
                max_pages=max_pages,
            )
            self._movies = self.fetch_result.movies
        return self._movies

    @property
    def movies(self) -> list:
        """Get watchlist movies formatted for dataframe display."""
        return self.fetch_movies()

    def jsonify(self) -> dict:
        """Serialize watchlist metadata plus the last pagination outcome.

        Built explicitly rather than via the parent's reflective encoder, which
        would try to serialize the cached BeautifulSoup DOM (its tag attribute
        sets are not JSON encodable).
        """
        return collection_metadata(self, self.fetch_result)
