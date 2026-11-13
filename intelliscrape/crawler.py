"""Website crawler for IntelliScrape - discovers and scrapes all pages.

The crawler fetches every attempted URL exactly once.  The raw HTML returned
by that single fetch is reused both for text extraction and for discovering
the next batch of same-domain links, so a page whose body extraction fails
never triggers a second network request just to collect its links.

Every URL that is part of the run gets a :class:`PageOutcome` record on
:attr:`CrawlResult.outcomes`, including URLs that were queued but never
fetched because ``max_pages`` was reached.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Set, TYPE_CHECKING
from urllib.parse import urlsplit, urlunsplit, urljoin

from bs4 import BeautifulSoup

if TYPE_CHECKING:
    from .core import IntelliScrape


# ---------------------------------------------------------------------------
# Outcome categories
# ---------------------------------------------------------------------------

#: The page was fetched and yielded non-empty text content.
OUTCOME_SUCCESS = "success"
#: The page was fetched but the run considered it a failure
#: (fetch/extraction error or empty body).
OUTCOME_FAILED = "failed"
#: The URL was discovered and queued but never fetched (e.g. max_pages hit).
OUTCOME_NOT_ATTEMPTED = "not_attempted"

# Machine-readable failure reasons (``None`` for successful pages).
ERROR_FETCH = "fetch_error"
ERROR_EMPTY_CONTENT = "empty_content"
ERROR_EXTRACTION = "extraction_error"


@dataclass
class ScrapeResult:
    """Result of scraping a single page."""
    url: str
    content: str
    status: str = "success"


@dataclass
class PageOutcome:
    """What happened to a single URL during a crawl.

    Every URL the crawl knew about produces one of these records, so the
    full run can be accounted for page by page.

    Attributes
    ----------
    url:
        The URL the record describes, normalized without fragment.
    status:
        One of :data:`OUTCOME_SUCCESS`, :data:`OUTCOME_FAILED`,
        :data:`OUTCOME_NOT_ATTEMPTED`.
    reason:
        Human-readable explanation.  ``None`` for successful pages and
        URLs that were never attempted for a benign reason.
    error_type:
        Machine-readable failure category (``ERROR_*`` constant) or
        ``None`` when the page did not fail.
    chars:
        Number of characters extracted from the page body.  ``0`` for
        failures and unattempted URLs.
    new_links:
        Number of same-domain links discovered on this page that were
        not already visited or queued.  ``0`` for unattempted URLs.
    """
    url: str
    status: str
    reason: Optional[str] = None
    error_type: Optional[str] = None
    chars: int = 0
    new_links: int = 0

    @property
    def succeeded(self) -> bool:
        return self.status == OUTCOME_SUCCESS


@dataclass
class CrawlResult:
    """Result of crawling an entire website."""
    base_url: str
    pages: List[ScrapeResult] = field(default_factory=list)
    failed: List[ScrapeResult] = field(default_factory=list)
    #: One record per URL the crawl knew about (attempted or not).
    outcomes: List[PageOutcome] = field(default_factory=list)

    @property
    def total_pages(self) -> int:
        return len(self.pages)

    @property
    def total_failed(self) -> int:
        return len(self.failed)

    @property
    def total_not_attempted(self) -> int:
        return sum(1 for o in self.outcomes if o.status == OUTCOME_NOT_ATTEMPTED)

    def outcomes_by_status(self) -> Dict[str, List[PageOutcome]]:
        """Group outcome records by their status category."""
        grouped: Dict[str, List[PageOutcome]] = {
            OUTCOME_SUCCESS: [],
            OUTCOME_FAILED: [],
            OUTCOME_NOT_ATTEMPTED: [],
        }
        for outcome in self.outcomes:
            grouped.setdefault(outcome.status, []).append(outcome)
        return grouped

    def to_text(self) -> str:
        """Convert all scraped content to a single text document."""
        parts = []
        for page in self.pages:
            parts.append(f"{'='*80}")
            parts.append(f"URL: {page.url}")
            parts.append(f"{'='*80}")
            parts.append(page.content)
            parts.append("")
        return "\n".join(parts)


def normalize_url(url: str) -> str:
    """Strip the fragment from a URL so fragment-only variants dedupe.

    Query strings and paths are preserved; only ``#fragment`` is removed
    because it never identifies a distinct page on the server.
    """
    parsed = urlsplit(url)
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, parsed.query, ""))


def _extract_links(html: str, base_url: str) -> Set[str]:
    """Extract all internal HTTP(S) links from HTML.

    Only links whose netloc matches ``base_url`` are returned, and every
    link is normalized (fragment removed) so duplicate spellings collapse.
    """
    soup = BeautifulSoup(html, "html.parser")
    links: Set[str] = set()

    base_domain = urlsplit(base_url).netloc

    for a_tag in soup.find_all("a", href=True):
        href = a_tag["href"].strip()

        if not href:
            continue

        # Skip non-HTTP links
        if href.startswith(("#", "mailto:", "tel:", "javascript:")):
            continue

        # Resolve relative URLs
        full_url = urljoin(base_url, href)

        # Parse and validate
        parsed = urlsplit(full_url)
        if parsed.scheme not in ("http", "https"):
            continue

        # Only keep internal links (same domain)
        if parsed.netloc == base_domain:
            links.add(normalize_url(full_url))

    return links


def _default_fetcher(scraper: "IntelliScrape", on_progress) -> Callable[[str], str]:
    """Build a fetcher that performs exactly one request per URL.

    The raw HTML from that single request is what the crawler reuses for
    both text extraction and link discovery.
    """

    def fetch(url: str) -> str:
        return scraper.scrape(url, return_raw=True, on_progress=on_progress)

    return fetch


def _extract_text(raw_html: str) -> str:
    """Run the same parse/extract/clean pipeline as ``IntelliScrape.scrape``.

    Returns an empty string (possibly whitespace) when the HTML carries no
    text instead of raising, so the crawler can classify such pages as
    empty-content failures.  Genuine parse/extraction errors still raise.
    """
    from .parser import build_dom
    from .extractor import extract_text
    from .cleaner import clean_text

    dom = build_dom(raw_html)
    text = extract_text(dom)
    if not text or not text.strip():
        return ""
    return clean_text(text)


def crawl(
    url: str,
    *,
    max_pages: int = 50,
    delay: float = 0.5,
    log: Optional[Callable[[str], None]] = None,
    on_page: Optional[Callable[[int, int], None]] = None,
    scraper: Optional["IntelliScrape"] = None,
    on_progress: Optional[Callable] = None,
    fetcher: Optional[Callable[[str], str]] = None,
) -> CrawlResult:
    """Crawl a website starting from the given URL.

    Parameters
    ----------
    url : str
        Starting URL to crawl.  Empty values raise ``ValueError``.
    max_pages : int
        Maximum number of pages to *fetch* (default: 50).  Once reached,
        no further network requests are made; URLs still queued are
        recorded as ``not_attempted`` instead of failed.
    delay : float
        Delay between requests in seconds (default: 0.5).
    log : callable, optional
        Logging function for progress updates.
    on_page : callable, optional
        Callback with (pages_done, pages_failed) after each fetched page.
    scraper : IntelliScrape, optional
        Scraper instance with anti-bot detection, manual CAPTCHA, etc.
        If None, a new default scraper is created.  Ignored when an
        explicit ``fetcher`` is supplied.
    on_progress : callable, optional
        Progress callback for engine status updates.
    fetcher : callable, optional
        Replacement fetch function ``url -> raw HTML``.  It is called at
        most once per URL and must raise on transport failure.  Mainly
        useful for testing, but also allows swapping in any custom
        transport.  Defaults to the scraper's raw-HTML pipeline.

    Returns
    -------
    CrawlResult
        Contains scraped pages, failures and one :class:`PageOutcome`
        per known URL.
    """
    import time

    if not url:
        raise ValueError("URL is required")

    if scraper is None and fetcher is None:
        from .core import IntelliScrape
        scraper = IntelliScrape()

    if fetcher is None:
        fetcher = _default_fetcher(scraper, on_progress)

    start_url = normalize_url(url)
    result = CrawlResult(base_url=url)

    visited: Set[str] = set()
    to_visit: Set[str] = {start_url}
    attempted = 0

    if log:
        log(f"Starting crawl of {url}")
        log(f"Max pages: {max_pages}")

    while to_visit and attempted < max_pages:
        current_url = to_visit.pop()

        if current_url in visited:
            continue

        visited.add(current_url)
        attempted += 1

        if log:
            log(f"[{attempted}/{max_pages}] Scraping: {current_url}")

        outcome = PageOutcome(url=current_url, status=OUTCOME_FAILED)

        try:
            # Exactly one network request per page: the raw HTML returned
            # here feeds both body extraction and link discovery.
            raw_html = fetcher(current_url)
        except Exception as exc:
            outcome.error_type = ERROR_FETCH
            outcome.reason = f"fetch failed: {exc}"
            result.failed.append(ScrapeResult(
                url=current_url,
                content="",
                status=f"failed: {exc}",
            ))
            result.outcomes.append(outcome)
            if log:
                log(f"  FAILED - {exc}")
            if on_page:
                on_page(len(result.pages), len(result.failed))
            if delay > 0:
                time.sleep(delay)
            continue

        # Link discovery reuses the HTML already in hand; it never makes
        # another request, even if body extraction below fails.
        try:
            discovered = _extract_links(raw_html, start_url)
        except Exception as exc:
            discovered = set()
            if log:
                log(f"  link extraction error - {exc}")

        known = visited | to_visit
        fresh_links = {link for link in discovered if link not in known}
        to_visit.update(fresh_links)
        outcome.new_links = len(fresh_links)

        try:
            content = _extract_text(raw_html)
        except Exception as exc:
            outcome.error_type = ERROR_EXTRACTION
            outcome.reason = f"content extraction failed: {exc}"
            result.failed.append(ScrapeResult(
                url=current_url,
                content="",
                status=f"failed: content extraction failed: {exc}",
            ))
            result.outcomes.append(outcome)
            if log:
                log(f"  FAILED - content extraction failed: {exc}")
            if on_page:
                on_page(len(result.pages), len(result.failed))
            if delay > 0:
                time.sleep(delay)
            continue

        if not content or not content.strip():
            # Fetched fine, but the page has no usable body: still a failure.
            outcome.error_type = ERROR_EMPTY_CONTENT
            outcome.reason = "fetched but extracted content is empty"
            result.failed.append(ScrapeResult(
                url=current_url,
                content="",
                status="failed: fetched but extracted content is empty",
            ))
            result.outcomes.append(outcome)
            if log:
                log("  FAILED - fetched but extracted content is empty")
            if on_page:
                on_page(len(result.pages), len(result.failed))
        else:
            outcome.status = OUTCOME_SUCCESS
            outcome.reason = None
            outcome.chars = len(content)
            result.pages.append(ScrapeResult(url=current_url, content=content))
            result.outcomes.append(outcome)
            if log:
                log(f"  OK - {len(content)} chars extracted, "
                    f"{outcome.new_links} new links")
            if on_page:
                on_page(len(result.pages), len(result.failed))

        # Rate limiting
        if delay > 0:
            time.sleep(delay)

    # Anything still queued was never fetched: account for it explicitly
    # instead of silently dropping it.  These are not failures.
    for unvisited in sorted(to_visit):
        if unvisited in visited:
            continue
        result.outcomes.append(PageOutcome(
            url=unvisited,
            status=OUTCOME_NOT_ATTEMPTED,
            reason=f"not attempted: max_pages={max_pages} reached",
        ))

    if log:
        log(
            f"\nCrawl complete: {result.total_pages} scraped, "
            f"{result.total_failed} failed, "
            f"{result.total_not_attempted} not attempted"
        )

    return result
