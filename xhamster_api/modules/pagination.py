"""Per-page pagination helpers for the in-library listing scrapers.

The shared ``base_api.scrape_stream`` iterator only emits successfully parsed
*items*: callers cannot tell whether a missing page failed to fetch, was
reachable but contained no results, or was skipped.  The helpers in this module
drive the same page URLs one at a time and always produce exactly one
:class:`PageOutcome` per requested page.

Outcome kinds:

* :data:`PageStatus.SUCCESS` - the page was fetched and at least one item was
  parsed.  The constructed media objects are carried on the outcome.
* :data:`PageStatus.EMPTY` - the page was fetched successfully but the
  extractor returned no items.  This is deliberately distinct from a fetch
  failure.
* :data:`PageStatus.FAILED` - fetching the page raised (network error, HTTP
  404, bot detection, ...).  A human-readable reason is attached and iteration
  continues with the next page.

A single page failure never terminates the whole iteration, and items from
pages that already succeeded are yielded immediately, so a later failure cannot
make them disappear.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator, Callable, Iterable, Mapping
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Generic, TypeVar

from base_api import BaseCore, IteratorConfig
from base_api.modules.logger import get_logger
from base_api.modules.provider import fetch_content

from xhamster_api.modules import errors as provider_errors

logger = get_logger(__name__)

MediaT = TypeVar("MediaT")


class PageStatus(str, Enum):
    """Observable terminal status of a single scraped page."""

    SUCCESS = "success"
    EMPTY = "empty"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class PageOutcome(Generic[MediaT]):
    """The observable result of processing exactly one listing page.

    Every requested page produces an outcome, regardless of whether it could be
    fetched.  ``items`` is always a tuple (possibly empty) and ``error`` is the
    original exception for a failed page or ``None`` otherwise.
    """

    page: int
    url: str
    status: PageStatus
    items: tuple[MediaT, ...] = field(default_factory=tuple)
    error: Exception | None = None

    @property
    def succeeded(self) -> bool:
        """Return ``True`` when the page was fetched and contained items."""
        return self.status is PageStatus.SUCCESS

    @property
    def is_empty(self) -> bool:
        """Return ``True`` when the page was reachable but had zero items."""
        return self.status is PageStatus.EMPTY

    @property
    def failed(self) -> bool:
        """Return ``True`` when the page could not be fetched."""
        return self.status is PageStatus.FAILED

    @property
    def reason(self) -> str | None:
        """Human-readable failure reason, or ``None`` for non-failed pages."""
        if self.status is not PageStatus.FAILED:
            return None
        error = self.error
        if error is None:
            return "Unknown page fetch failure"
        message = str(error).strip()
        if message:
            return f"{type(error).__name__}: {message}"
        return type(error).__name__


def _describe_error(error: Exception) -> str:
    message = str(error).strip()
    if message:
        return f"{type(error).__name__}: {message}"
    return type(error).__name__


async def iter_page_outcomes(
    *,
    core: BaseCore,
    constructor: Callable[..., MediaT],
    page_urls: Iterable[str],
    item_extractor: Callable[..., Iterable[Mapping[str, Any]]],
    iterator_config: IteratorConfig | None = None,
) -> AsyncGenerator[PageOutcome[MediaT], None]:
    """Yield one :class:`PageOutcome` for every URL in ``page_urls``.

    Pages are processed sequentially in the given order, so the outcome order
    matches the page order exactly.  A page fetch error is converted into a
    ``FAILED`` outcome instead of propagating, which lets the remaining pages
    keep being processed.  A page that fetches fine but yields no items becomes
    an ``EMPTY`` outcome.

    Media objects are constructed eagerly from the extractor mappings but are
    not loaded over the network: their lazy ``html`` loaders behave exactly as
    they do in the item stream.

    ``iterator_config`` is accepted for signature compatibility with
    ``scrape_stream``.  Page fetching is driven directly through the shared
    :func:`~base_api.modules.provider.fetch_content` helper so every page can be
    observed individually; the transport layer already applies its own bounded
    retry policy.
    """
    del iterator_config  # retained for call-site compatibility
    urls = tuple(page_urls)

    for index, url in enumerate(urls, start=1):
        try:
            html_content = await fetch_content(
                core, url, logger=logger, error_types=provider_errors
            )
        except Exception as error:  # noqa: BLE001 - every failure becomes observable
            logger.exception(
                "Page %s (%s) could not be fetched: %s",
                index,
                url,
                _describe_error(error),
            )
            yield PageOutcome(
                page=index,
                url=url,
                status=PageStatus.FAILED,
                error=error,
            )
            continue

        try:
            extracted = tuple(item_extractor(html_content))
        except Exception as error:  # noqa: BLE001 - parse failure is a per-page outcome
            # A broken page layout is an observation about this page, not a
            # reason to abort the whole listing.
            logger.exception(
                "Page %s (%s) failed while parsing items: %s", index, url, error
            )
            yield PageOutcome(
                page=index,
                url=url,
                status=PageStatus.FAILED,
                error=error,
            )
            continue

        if not extracted:
            logger.info(
                "Page %s (%s) is reachable but returned no items", index, url
            )
            yield PageOutcome(page=index, url=url, status=PageStatus.EMPTY)
            continue

        items = [constructor(core=core, **dict(data)) for data in extracted]
        yield PageOutcome(
            page=index,
            url=url,
            status=PageStatus.SUCCESS,
            items=tuple(items),
        )
