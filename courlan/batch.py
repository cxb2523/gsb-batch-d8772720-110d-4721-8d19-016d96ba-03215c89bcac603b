"""
Batch retrieval of site homepages into a preconfigured UrlStore.

The entry point is `collect_homepages()`, which fetches one homepage per
input base URL, in input order, and hands each page to
`UrlStore.add_from_html()` so that the store's own robots rules, language
and strict settings apply. The fetch function is pluggable, which keeps
the function testable without network access. Every site yields one
`SiteOutcome`, and processing continues after per-site failures.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from enum import Enum
from urllib.robotparser import RobotFileParser

from .core import filter_links
from .filters import domain_filter, validate_url
from .network import HTTP_POOL
from .urlstore import UrlStore
from .urlutils import get_ascii_url, get_base_url

LOGGER = logging.getLogger(__name__)

_CHARSET = re.compile(r"charset\s*=\s*[\"']?([^\s;\"']+)", re.I)


class FetchError(Exception):
    "A homepage could not be retrieved: transport error or non-2xx response."


def _charset(content_type: str) -> str | None:
    "Extract a lowercase charset name from a Content-Type header, if any."
    match = _CHARSET.search(content_type)
    return match[1].lower() if match else None


def fetch_page(url: str, timeout: float = 10.0) -> str:
    """Retrieve a HTML page over HTTP and return it as a string.

    This is the default `fetch` function of `collect_homepages()`. It can be
    replaced by any callable taking a URL and returning the page content,
    which is useful for testing or for using another HTTP client.

    Args:
        url: page to retrieve, requested in ASCII/punycode form
        timeout: request timeout in seconds

    Returns:
        The decoded page content.

    Raises:
        FetchError: on transport errors or non-2xx responses.
    """
    try:
        response = HTTP_POOL.request("GET", get_ascii_url(url), timeout=timeout)
    except Exception as err:
        raise FetchError(f"network error: {err}") from err
    if not 200 <= response.status < 300:
        raise FetchError(f"HTTP status {response.status}")
    charset = _charset(response.headers.get("content-type", ""))
    try:
        return response.data.decode(charset or "utf-8", errors="replace")
    except LookupError:  # unknown charset label
        return response.data.decode("utf-8", errors="replace")


class SiteStatus(str, Enum):
    "Outcome category of one site processed in a batch."

    SUCCESS = "success"
    FAILURE = "failure"
    REJECTED = "rejected"


@dataclass(frozen=True)
class SiteOutcome:
    "Result of fetching and processing one site: its URL, status and readable reason."

    url: str
    status: SiteStatus
    reason: str
    added_links: int = 0

    @property
    def site(self) -> str:
        "Return the site URL as given in the batch input."
        return self.url


@dataclass
class BatchResult:
    """Summary of a homepage batch, with one outcome per input site.

    Attributes:
        outcomes: per-site outcomes, in input order
    """

    outcomes: list[SiteOutcome] = field(default_factory=list)

    def _count(self, status: SiteStatus) -> int:
        return sum(outcome.status is status for outcome in self.outcomes)

    @property
    def success_count(self) -> int:
        "Return the number of sites whose links were added to the store."
        return self._count(SiteStatus.SUCCESS)

    @property
    def failure_count(self) -> int:
        "Return the number of sites that could not be fetched or processed."
        return self._count(SiteStatus.FAILURE)

    @property
    def rejected_count(self) -> int:
        "Return the number of sites whose links were all filtered out."
        return self._count(SiteStatus.REJECTED)

    @property
    def total_added(self) -> int:
        "Return the number of links added to the store across all sites."
        return sum(outcome.added_links for outcome in self.outcomes)

    @property
    def total_count(self) -> int:
        "Return the number of sites processed."
        return len(self.outcomes)


def _valid_site(site: str) -> str | None:
    "Return the requestable site URL, stripped, or None if it is invalid."
    if not isinstance(site, str):
        return None
    site = site.strip()
    valid, parsed = validate_url(site)
    if not valid or parsed is None:
        return None
    # userinfo is dropped before the host checks, as in check_url
    if not domain_filter(parsed.netloc.rpartition("@")[2]):
        return None
    return site


def _kept_links(
    html: str,
    url: str,
    lang: str | None,
    rules: RobotFileParser | None,
    strict: bool,
) -> int:
    "Return the number of links filter_links() keeps with the given settings."
    links, priority = filter_links(
        htmlstring=html,
        url=url,
        external=False,
        lang=lang,
        rules=rules,
        strict=strict,
        with_nav=True,
    )
    return len(links) + len(priority)


def _rejection_reason(html: str, url: str, store: UrlStore) -> str:
    "Explain why a fetched page yielded no new links."
    try:
        # mirror the arguments add_from_html() uses
        rules = store.get_rules(get_base_url(url))
        kept = _kept_links(html, url, store.language, rules, store.strict)
        if kept:
            return "rejected: no new links, all remaining links already known"
        # isolate the setting responsible by lifting it one at a time
        if rules is not None and _kept_links(
            html, url, store.language, None, store.strict
        ):
            return "rejected: robots rules exclude all links"
        if store.language is not None and _kept_links(
            html, url, None, rules, store.strict
        ):
            return "rejected: language filter excludes all links"
        if store.strict and _kept_links(html, url, store.language, rules, False):
            return "rejected: strict mode excludes all links"
        if not _kept_links(html, url, None, None, False):
            return "rejected: no usable internal links in page"
        return "rejected: no links left after robots, language or strict filtering"
    except Exception as err:  # noqa: BLE001 - the reason must never be fatal
        LOGGER.debug("cannot determine rejection reason for %s: %s", url, err)
        return "rejected: no links left after robots, language or strict filtering"


def _process_site(
    site: str, store: UrlStore, fetch: Callable[[str], str]
) -> SiteOutcome:
    "Fetch one site homepage and add its links to the store, reporting the outcome."
    try:
        page_url = _valid_site(site)
    except Exception as err:  # noqa: BLE001 - one site must not abort the batch
        LOGGER.debug("cannot validate site %r: %s", site, err)
        page_url = None
    if page_url is None:
        return SiteOutcome(
            url=_site_text(site),
            status=SiteStatus.FAILURE,
            reason="invalid URL, no request sent",
        )
    try:
        html = fetch(page_url)
    except Exception as err:  # noqa: BLE001 - one site must not abort the batch
        detail = str(err) or type(err).__name__
        return SiteOutcome(
            url=_site_text(site),
            status=SiteStatus.FAILURE,
            reason=f"request failed: {detail}",
        )
    try:
        before = store.total_url_number()
        store.add_from_html(html, page_url)
        added = max(0, store.total_url_number() - before)
    except Exception as err:  # noqa: BLE001 - one site must not abort the batch
        detail = str(err) or type(err).__name__
        return SiteOutcome(
            url=_site_text(site),
            status=SiteStatus.FAILURE,
            reason=f"error while adding links: {detail}",
        )
    if added:
        links = "link" if added == 1 else "links"
        return SiteOutcome(
            url=_site_text(site),
            status=SiteStatus.SUCCESS,
            reason=f"{added} new {links} added",
            added_links=added,
        )
    return SiteOutcome(
        url=_site_text(site),
        status=SiteStatus.REJECTED,
        reason=_rejection_reason(html, page_url, store),
    )


def _site_text(site: str) -> str:
    "Return the site as displayable text, tolerating non-string input."
    return site if isinstance(site, str) else repr(site)


def collect_homepages(
    site_urls: str | Iterable[str] | None,
    store: UrlStore,
    fetch: Callable[[str], str] = fetch_page,
) -> BatchResult:
    """Fetch the homepage of every site and add its links to the given store.

    Sites are processed sequentially, in input order. Each page is handed to
    `store.add_from_html()`, so the store's robots rules, `language` and
    `strict` settings decide which links are kept. Invalid URLs are reported
    as failures without any request, and an error on one site does not stop
    the following ones.

    Args:
        site_urls: base URLs of the sites, e.g. ``["https://example.org"]``;
            a single string is accepted as one site
        store: configured `UrlStore` receiving the extracted links
        fetch: callable taking a URL and returning the page content; replace
            `fetch_page()` to use another HTTP client or in tests

    Returns:
        A `BatchResult` with one `SiteOutcome` per input site, in input order,
        and the success, failure and rejected counts. Empty input yields an
        empty but structurally complete result.
    """
    if isinstance(site_urls, str):
        site_urls = [site_urls]
    outcomes: list[SiteOutcome] = []
    for site in site_urls if site_urls is not None else []:
        outcome = _process_site(site, store, fetch)
        LOGGER.debug("%s: %s (%s)", outcome.url, outcome.status.value, outcome.reason)
        outcomes.append(outcome)
    return BatchResult(outcomes)
