"""Per-page outcome tracking and resumable pagination for listing scrapers.

The shared :class:`~base_api.base.Helper` only exposes terminal *page* failures
and treats an extractor returning zero items like any other successful page.
Listing scrapers additionally need to know, for every requested page, whether it
contained videos, was an intentionally empty listing, failed to parse, was
blocked by bot protection or could not be fetched at all — without one bad page
aborting the whole iteration.

This module drives the page requests itself (via the provider's
:func:`spankbang_api.api.get_html_content` fetch seam, which translates
transport errors into the provider's typed exceptions), classifies every page
and feeds successfully fetched HTML to the regular ``Helper`` item pipeline
through a small core proxy so no page is downloaded twice.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Awaitable, Callable, Sequence

from base_api import Helper, RetryPolicy
from base_api.modules.config import IteratorConfig, make_iterator_config
from base_api.modules import errors as base_errors

from spankbang_api.modules.consts import select_video_nodes
from spankbang_api.modules import errors as provider_errors


logger = logging.getLogger(__name__)


class PageOutcome(StrEnum):
    """Terminal state of a single listing page request."""

    SUCCESS = "success"
    """The page was fetched and produced at least one video item."""

    EMPTY = "empty"
    """The list container was present but contained no video items."""

    BLOCKED = "blocked"
    """The HTTP layer detected bot / anti-scraping protection."""

    PARSE_FAILED = "parse_failed"
    """HTML was fetched but neither the list container nor video items exist."""

    NETWORK_ERROR = "network_error"
    """The request itself raised before usable HTML was returned."""


@dataclass(frozen=True, slots=True)
class PageResult:
    """Outcome record handed to ``on_page_result`` after each page finishes."""

    page: int
    """1-based page number, matching the request order."""

    url: str
    """The exact URL that was requested for this page."""

    outcome: PageOutcome
    """How the page ended (see :class:`PageOutcome`)."""

    video_count: int
    """Number of videos extracted from this page (``0`` for every failure)."""

    reason: str | None = None
    """Short human-readable failure reason; ``None`` on success/empty pages."""


# A callback may be synchronous or asynchronous and may accept the PageResult
# positionally or as keyword arguments.
PageResultCallback = Callable[[PageResult], Any | Awaitable[Any]]


# Request-level failures that indicate the site actively rejected the scraper.
_BLOCKED_ERRORS = (
    provider_errors.BotDetection,
    base_errors.BotProtectionDetected,
    base_errors.AccessDeniedError,
)

# Request-level failures caused by connectivity / transport problems rather
# than by the page markup.
_NETWORK_ERRORS = (
    provider_errors.NetworkError,
    provider_errors.ProxyError,
    provider_errors.UnknownNetworkError,
    base_errors.NetworkRequestError,
    base_errors.HTTPStatusError,
    base_errors.RequestRetriesExhausted,
    base_errors.UnknownError,
)


def _short_reason(error: BaseException) -> str:
    """Keep callback failure reasons short while retaining the error type."""
    message = str(error).strip()
    name = type(error).__name__
    if not message:
        return name
    return f"{name}: {message}"[:300]


def classify_page_html(html: str) -> tuple[PageOutcome, int]:
    """Classify already-fetched listing HTML without performing any I/O.

    :returns: ``(outcome, video_count)`` where ``outcome`` is one of
        :attr:`PageOutcome.SUCCESS`, :attr:`PageOutcome.EMPTY` or
        :attr:`PageOutcome.PARSE_FAILED`.
    """
    _, containers, items = select_video_nodes(html)
    if items:
        return PageOutcome.SUCCESS, len(items)
    if containers:
        # The listing markup is intact, the site simply has no more videos.
        return PageOutcome.EMPTY, 0
    return PageOutcome.PARSE_FAILED, 0


async def invoke_page_callback(
    callback: PageResultCallback | None, result: PageResult
) -> None:
    """Invoke a user callback without letting its failures break pagination."""
    if callback is None:
        return
    try:
        if inspect.iscoroutinefunction(callback):
            await callback(result)
            return
        value = callback(result)
        if inspect.isawaitable(value):
            await value
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001 - callback isolation is part of the contract
        # A faulty observer must not stop the scrape or affect later pages.
        logger.exception(
            "on_page_result callback failed for page %s (%s)",
            result.page,
            result.url,
        )


class _PrefetchedCore:
    """Core proxy serving one prefetched page's HTML and delegating the rest.

    ``Helper`` fetches page HTML itself before running the extractor. The page
    has already been downloaded (and classified) by the pagination loop, so the
    proxy answers that one request from memory — keeping the single-fetch
    semantics — while video item requests keep using the real core.
    """

    __slots__ = ("_core", "_prefetch")

    def __init__(self, core: Any, prefetched: dict[str, str]):
        object.__setattr__(self, "_core", core)
        object.__setattr__(self, "_prefetch", prefetched)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._core, name)

    async def fetch_text(self, url: str, *args: Any, **kwargs: Any) -> str:
        prefetched = self._prefetch.get(url)
        if prefetched is not None:
            return prefetched
        return await self._core.fetch_text(url, *args, **kwargs)


def _build_iterator_config(iterator_config: IteratorConfig | None) -> IteratorConfig:
    if iterator_config is None:
        return make_iterator_config(
            max_item_concurrency=2,
            max_page_concurrency=1,
        )
    return iterator_config


async def scrape_listing_pages(
    *,
    core: Any,
    constructor: Any,
    target_page_urls: Sequence[str],
    page_numbers: Sequence[int],
    item_extractor: Callable[..., list[dict[str, object]]],
    iterator_config: IteratorConfig | None,
    fetch_html: Callable[..., Awaitable[str]],
    on_page_result: PageResultCallback | None,
    fetch_owner: Any = None,
):
    """Iterate listing pages sequentially, classifying and reporting each one.

    Every page produces exactly one :class:`PageResult` (when a callback is
    supplied). Empty and unparseable pages never raise and never yield items;
    blocked and network-error pages are reported and skipped as well, so later
    pages still run and already collected videos keep flowing to the caller.

    ``fetch_html`` is invoked as ``fetch_html(core, url, owner=fetch_owner)``.
    Passing the callable itself (rather than a pre-bound partial) keeps it
    patchable as a module-level seam in tests.
    """
    config = _build_iterator_config(iterator_config)
    # The outer loop owns page-level retries: one attempt per page keeps a dead
    # page from stalling the whole listing behind the core's own retry budget.
    config.page_retry = RetryPolicy(max_attempts=1)

    for page_number, page_url in zip(page_numbers, target_page_urls):
        try:
            html = await fetch_html(core, page_url, owner=fetch_owner)
        except _BLOCKED_ERRORS as error:
            result = PageResult(
                page=page_number,
                url=page_url,
                outcome=PageOutcome.BLOCKED,
                video_count=0,
                reason=_short_reason(error),
            )
            await invoke_page_callback(on_page_result, result)
            continue
        except _NETWORK_ERRORS as error:
            result = PageResult(
                page=page_number,
                url=page_url,
                outcome=PageOutcome.NETWORK_ERROR,
                video_count=0,
                reason=_short_reason(error),
            )
            await invoke_page_callback(on_page_result, result)
            continue

        outcome, video_count = classify_page_html(html)
        result = PageResult(
            page=page_number,
            url=page_url,
            outcome=outcome,
            video_count=video_count,
            reason=None,
        )

        if outcome is not PageOutcome.SUCCESS:
            # Empty listings and markup changes must not raise; simply report
            # the page and move on to the next one.
            await invoke_page_callback(on_page_result, result)
            continue

        # Reuse the standard Helper item pipeline (construction, lazy html
        # loading, retry/error modes, ordering) with the page HTML prefetched.
        helper = Helper(
            core=_PrefetchedCore(core, {page_url: html}),
            constructor=constructor,
        )
        stream = helper.iterator(
            target_page_urls=[page_url],
            item_extractor=item_extractor,
            iterator_config=config,
        )
        async with stream:
            async for scrape_result in stream:
                yield scrape_result

        await invoke_page_callback(on_page_result, result)


def paginate(
    *,
    pages: int,
    resume_from: int,
    build_url: Callable[[int], str],
) -> tuple[list[int], list[str]]:
    """Resolve the requested page range to ``(page_numbers, urls)``.

    ``resume_from`` is 1-based and inclusive. When it is greater than
    ``pages`` no pages are requested and both returned lists are empty.
    """
    if resume_from < 1:
        raise ValueError("resume_from must be >= 1")
    if resume_from > pages:
        return [], []
    page_numbers = list(range(resume_from, pages + 1))
    return page_numbers, [build_url(page) for page in page_numbers]


__all__ = [
    "PageOutcome",
    "PageResult",
    "PageResultCallback",
    "classify_page_html",
    "invoke_page_callback",
    "scrape_listing_pages",
    "paginate",
]