"""
Shared resilient pagination and DOM fetching utilities for Letterboxd scrapers.

Provides exponential retry backoff, adaptive inter-page pacing, initial DOM reuse,
real-time progress callback hooks, and structured pagination results that record
*why* a run stopped. Filtered Letterboxd pages expose no total count, so the
paginator advances page by page and always reports the page it stopped on plus
the number of items collected, even when the run is incomplete.
"""

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import StrEnum

from letterboxdpy.core.exceptions import (
    AccessDeniedError,
    PrivateRouteError,
    ResourceNotFoundError,
)
from letterboxdpy.core.scraper import parse_url
from letterboxdpy.utils.utils_csv import transform_to_ranked_movies
from letterboxdpy.utils.utils_url import get_page_url

from models.logger import logger

MIN_PAGE_INTERVAL = 0.25


class StopReason(StrEnum):
    """Why a pagination run ended."""

    COMPLETE = "complete"
    EMPTY_COLLECTION = "empty_collection"
    EMPTY_PAGE = "empty_page"
    NO_NEW_ITEMS = "no_new_items"
    FETCH_FAILED = "fetch_failed"
    MAX_PAGES = "max_pages"


# User-facing descriptions for every stop reason.
STOP_REASON_LABELS = {
    StopReason.COMPLETE: "reached the last page",
    StopReason.EMPTY_COLLECTION: "the first page returned no matching films",
    StopReason.EMPTY_PAGE: "a page returned no films",
    StopReason.NO_NEW_ITEMS: "a page added no new films",
    StopReason.FETCH_FAILED: "a page request failed after retries",
    StopReason.MAX_PAGES: "the configured page limit was reached",
}


@dataclass
class PaginationResult:
    """Outcome of a pagination run, including partial-collection diagnostics."""

    movies: list
    items_collected: int
    pages_fetched: int
    stop_page: int
    stop_reason: StopReason
    base_url: str
    total_count: int | None = None
    failed_url: str | None = None
    page_item_counts: dict = field(default_factory=dict)

    @property
    def complete(self) -> bool:
        """True when the run naturally covered every page (or was empty)."""
        return self.stop_reason in (
            StopReason.COMPLETE,
            StopReason.EMPTY_COLLECTION,
        )

    @property
    def interrupted(self) -> bool:
        """True when a failure or page anomaly stopped the run before the end."""
        return self.stop_reason in (
            StopReason.FETCH_FAILED,
            StopReason.EMPTY_PAGE,
            StopReason.NO_NEW_ITEMS,
        )


def pace_request(step_start: float, min_interval: float = MIN_PAGE_INTERVAL) -> None:
    """Ensure a minimum polite interval between network requests."""
    elapsed = time.monotonic() - step_start
    remaining = min_interval - elapsed
    if remaining > 0:
        time.sleep(remaining)


def fetch_dom_with_retry(url: str, retries: int = 3):
    """Fetch and parse page DOM with canonical trailing slash and retry backoff."""
    url = url if url.endswith("/") or "?" in url else f"{url}/"
    for attempt in range(retries):
        t0 = time.monotonic()
        try:
            dom = parse_url(url)
            elapsed_ms = int((time.monotonic() - t0) * 1000)
            logger.info(
                "[FETCH] url=%s attempt=%d elapsed_ms=%d",
                url,
                attempt + 1,
                elapsed_ms,
            )
            return dom
        except (
            ResourceNotFoundError,
            PrivateRouteError,
            AccessDeniedError,
        ) as exc:
            elapsed_ms = int((time.monotonic() - t0) * 1000)
            logger.warning(
                "[FETCH:ABORT] url=%s elapsed_ms=%d err=%s",
                url,
                elapsed_ms,
                exc,
            )
            break
        except Exception as exc:
            elapsed_ms = int((time.monotonic() - t0) * 1000)
            logger.warning(
                "[FETCH:RETRY] url=%s attempt=%d/%d elapsed_ms=%d err=%s",
                url,
                attempt + 1,
                retries,
                elapsed_ms,
                exc,
            )
            if attempt == retries - 1:
                break
            time.sleep(1.0 * (attempt + 1))
    return None


def paginate_ranked_movies(
    base_url: str,
    items_per_page: int,
    extractor_fn: Callable,
    initial_dom=None,
    total_count: int | None = None,
    on_progress: Callable | None = None,
    max_pages: int | None = None,
    fetch_fn: Callable | None = None,
    min_interval: float = MIN_PAGE_INTERVAL,
) -> PaginationResult:
    """
    Scrape paginated Letterboxd movie collections page by page.

    Filtered collections do not expose a total count, so the run is driven
    purely by page content: it advances until a short/empty page, a page that
    adds nothing, a failed request, or ``max_pages``. Every outcome — including
    partial runs — is captured in the returned :class:`PaginationResult` so the
    UI can state how many items were collected and on which page it stopped.

    Args:
        base_url: Base collection URL (page 1) to paginate.
        items_per_page: Maximum number of items expected per full page.
        extractor_fn: Function taking a BeautifulSoup DOM and returning a dict
            of movies keyed by a stable movie id/slug.
        initial_dom: Optional pre-fetched DOM for page 1 to avoid duplicate
            requests.
        total_count: Expected total movie count, when known (``None`` for
            filtered collections). Used only for progress reporting.
        on_progress: Optional callback(current, total, page, items_per_page).
        max_pages: Optional maximum number of pages to fetch.
        fetch_fn: Optional URL -> DOM callable, defaulting to
            :func:`fetch_dom_with_retry`. Inject a fake in tests to avoid
            network access.
        min_interval: Polite minimum delay between network requests; set to
            zero in tests.

    Returns:
        A :class:`PaginationResult` carrying the ranked movie list plus
        stop-page/stop-reason diagnostics.
    """
    fetch_page = fetch_fn or fetch_dom_with_retry
    start_time = time.monotonic()
    collected: dict = {}
    page_item_counts: dict = {}
    page = 1
    stop_reason = StopReason.COMPLETE
    failed_url: str | None = None
    pages_fetched = 0

    logger.info(
        "[PAGINATE:START] base_url=%s expected_total=%s items_per_page=%d cached_p1=%s max_pages=%s",
        base_url,
        total_count,
        items_per_page,
        initial_dom is not None,
        max_pages,
    )

    if total_count == 0:
        stop_reason = StopReason.EMPTY_COLLECTION
        logger.info(
            "[PAGINATE:DONE] base_url=%s total_collected=0 pages=0 reason=%s elapsed_ms=0",
            base_url,
            stop_reason.value,
        )
        return PaginationResult(
            movies=[],
            items_collected=0,
            pages_fetched=0,
            stop_page=1,
            stop_reason=stop_reason,
            base_url=base_url,
            total_count=total_count,
            page_item_counts=page_item_counts,
        )

    while True:
        step_start = time.monotonic()
        page_url = get_page_url(base_url, page)
        used_cached = page == 1 and initial_dom is not None
        dom = initial_dom if used_cached else fetch_page(page_url)
        if not dom:
            stop_reason = StopReason.FETCH_FAILED
            failed_url = page_url
            logger.warning(
                "[PAGINATE:FETCH_FAILED] base_url=%s page=%d url=%s collected=%d",
                base_url,
                page,
                page_url,
                len(collected),
            )
            break

        scraped = extractor_fn(dom)
        if not scraped:
            stop_reason = (
                StopReason.EMPTY_COLLECTION if page == 1 else StopReason.EMPTY_PAGE
            )
            logger.warning(
                "[PAGINATE:EMPTY] base_url=%s page=%d collected=%d",
                base_url,
                page,
                len(collected),
            )
            break

        pages_fetched = page
        page_item_counts[page] = len(scraped)
        prev_count = len(collected)
        collected.update(scraped)

        if len(collected) == prev_count:
            stop_reason = StopReason.NO_NEW_ITEMS
            logger.warning(
                "[PAGINATE:STALLED] base_url=%s page=%d no new items added",
                base_url,
                page,
            )
            break

        logger.info(
            "[PAGINATE:PAGE] page=%d page_items=%d collected=%d/%s cached=%s",
            page,
            len(scraped),
            len(collected),
            total_count or "?",
            used_cached,
        )

        if on_progress is not None:
            on_progress(len(collected), total_count, page, items_per_page)

        if len(scraped) < items_per_page:
            stop_reason = StopReason.COMPLETE
            break

        if max_pages and page >= max_pages:
            stop_reason = StopReason.MAX_PAGES
            logger.info(
                "[PAGINATE:MAX_PAGES] base_url=%s page=%d collected=%d",
                base_url,
                page,
                len(collected),
            )
            break

        page += 1
        if not used_cached:
            pace_request(step_start, min_interval)

    total_ms = int((time.monotonic() - start_time) * 1000)
    logger.info(
        "[PAGINATE:DONE] base_url=%s total_collected=%d pages=%d stop_page=%d reason=%s elapsed_ms=%d",
        base_url,
        len(collected),
        pages_fetched,
        page,
        stop_reason.value,
        total_ms,
    )

    return PaginationResult(
        movies=transform_to_ranked_movies(collected),
        items_collected=len(collected),
        pages_fetched=pages_fetched,
        stop_page=page,
        stop_reason=stop_reason,
        base_url=base_url,
        total_count=total_count,
        failed_url=failed_url,
        page_item_counts=page_item_counts,
    )


def run_collection_pagination(
    *,
    url: str,
    items_per_page: int,
    extractor_fn: Callable,
    initial_dom=None,
    total_count: int | None = None,
    on_progress: Callable | None = None,
    max_pages: int | None = None,
) -> PaginationResult:
    """
    Thin named-argument entry point shared by every collection model.

    Keeps the three model ``fetch_movies`` methods identical in shape while
    each still declares its own URL, page size, extractor and cached DOM.
    """
    return paginate_ranked_movies(
        base_url=url,
        items_per_page=items_per_page,
        extractor_fn=extractor_fn,
        initial_dom=initial_dom,
        total_count=total_count,
        on_progress=on_progress,
        max_pages=max_pages,
    )


def pagination_metadata(result: PaginationResult) -> dict:
    """Serialize a pagination outcome for the in-app Details expander."""
    return {
        "items_collected": result.items_collected,
        "pages_fetched": result.pages_fetched,
        "stop_page": result.stop_page,
        "stop_reason": result.stop_reason.value,
        "complete": result.complete,
        "failed_url": result.failed_url,
    }


def collection_metadata(collection, result: PaginationResult | None = None) -> dict:
    """Serialize common collection fields plus an optional pagination outcome."""
    data = {
        "username": collection.username,
        "url": collection.url,
        "count": collection.count,
        "filters": collection.filters or None,
        "sort_by": collection.sort_by,
    }
    if result is not None:
        data["pagination"] = pagination_metadata(result)
    return data


def paginate_vertical_collection(
    *,
    url: str,
    items_per_page: int,
    initial_dom=None,
    total_count: int | None = None,
    on_progress: Callable | None = None,
    max_pages: int | None = None,
) -> PaginationResult:
    """
    Pagination entry point for vertical poster collections (lists/watchlists).

    Both share the same vertical-list extractor, so the wiring lives here once
    and the models only supply their address, page size and cached DOM.
    """
    from letterboxdpy.utils.movies_extractor import (
        extract_movies_from_vertical_list,
    )

    return run_collection_pagination(
        url=url,
        items_per_page=items_per_page,
        extractor_fn=extract_movies_from_vertical_list,
        initial_dom=initial_dom,
        total_count=total_count,
        on_progress=on_progress,
        max_pages=max_pages,
    )
