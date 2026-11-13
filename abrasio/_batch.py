"""Batch page fetching with bounded concurrency and per-URL outcomes.

`Abrasio.fetch_pages()` opens one page per input URL (reusing the already
running session), runs at most `max_concurrency` pages at a time, and returns
one outcome record per URL in the same order as the input. A single failing
URL never aborts the whole batch: its failure is recorded on that URL's
result and the remaining URLs keep going.

Failures are classified into four reasons so callers can decide what to do:

* ``timeout``  - the navigation (or the page work) exceeded the time budget.
* ``blocked``  - the site refused the request (HTTP 401/403/407/429/451/503,
                 a Cloudflare/WAF challenge page, or a `BlockedError`).
* ``empty``    - the page loaded but produced no visible body text.
* ``error``    - any other exception.
"""

import asyncio
import inspect
import logging
import re
from dataclasses import asdict, dataclass
from html.parser import HTMLParser
from typing import Any, Awaitable, Callable, List, Optional, Sequence

from ._exceptions import BlockedError
from ._exceptions import TimeoutError as AbrasioTimeoutError

logger = logging.getLogger("abrasio.batch")

STATUS_SUCCESS = "success"
STATUS_FAILED = "failed"

# A page close should be quick; if the browser wedges we stop waiting so a
# stuck close cannot hold a concurrency slot forever.
_CLOSE_TIMEOUT_SEC = 5.0

# After a per-attempt deadline fires we cancel the attempt, then wait up to
# this long for its cleanup (`page.close()`) to complete before retrying. It
# is deliberately larger than _CLOSE_TIMEOUT_SEC so the normal close path can
# finish inside the grace window.
_CLOSE_GRACE_SEC = _CLOSE_TIMEOUT_SEC + 1.0


class FailureReason:
    """Failure categories attached to a failed `PageFetchResult`."""

    TIMEOUT = "timeout"
    BLOCKED = "blocked"
    EMPTY = "empty"
    ERROR = "error"
    # Alias: "other exception" in the API docs maps to the catch-all category.
    OTHER = ERROR


# HTTP statuses that mean "the site refused / throttled us" rather than a
# transient transport problem.
_BLOCKED_STATUS_CODES = frozenset({401, 403, 407, 429, 451, 503, 999})

# Markers of bot-protection / denial pages in the HTML body. Deliberately
# narrow (vendor-specific) so ordinary content that merely mentions "blocked"
# or "access denied" is not misclassified.
_BLOCKED_HTML_MARKERS = (
    "cdn-cgi/challenge-platform",
    "challenge-platform/h/",
    "cf-browser-verification",
    "cf-challenge",
    "captcha-delivery",
    "px-captcha",
    "incapsula incident id",
)

# Markers in the page title, which is where block/interstitial pages usually
# identify themselves.
_BLOCKED_TITLE_MARKERS = (
    "just a moment...",
    "attention required! | cloudflare",
    "access denied",
    "you have been blocked",
    "request blocked",
)


@dataclass
class PageFetchResult:
    """Outcome for one URL in a `Abrasio.fetch_pages(...)` batch.

    Attributes:
        url: The URL as passed by the caller.
        status: ``"success"`` or ``"failed"``.
        attempts: How many page attempts were made (1 when not retried).
        reason: Failure category (see `FailureReason`), ``None`` on success.
        title: Page title on success (``None`` for failed URLs).
        text: Visible body text on success (``None`` for failed URLs).
        status_code: HTTP status of the main response, when available.
        error: Human-readable exception/timeout summary for failed URLs.
        final_url: URL the browser actually landed on, when available.
    """

    url: str
    status: str
    attempts: int
    reason: Optional[str] = None
    title: Optional[str] = None
    text: Optional[str] = None
    status_code: Optional[int] = None
    error: Optional[str] = None
    final_url: Optional[str] = None

    # -- convenience accessors -------------------------------------------------
    @property
    def ok(self) -> bool:
        """True when the page was fetched successfully."""
        return self.status == STATUS_SUCCESS

    @property
    def success(self) -> bool:
        """Alias for :attr:`ok` (some callers read ``result.success``)."""
        return self.ok

    @property
    def failed(self) -> bool:
        """True when this URL ended in a failure."""
        return not self.ok

    def get(self, key: str, default: Any = None) -> Any:
        """Dict-like access, useful when results are consumed generically."""
        return getattr(self, key, default)

    def __getitem__(self, key: str) -> Any:
        try:
            return getattr(self, key)
        except AttributeError:
            raise KeyError(key) from None

    def to_dict(self) -> dict:
        """Return a plain dict, including the derived ``ok`` flag."""
        data = asdict(self)
        data["ok"] = self.ok
        return data

    # Common alias for callers used to ``asdict``-style APIs.
    def as_dict(self) -> dict:
        return self.to_dict()


class _TextExtractor(HTMLParser):
    """Extract human-visible text from HTML when the browser has no body."""

    _BREAK_TAGS = frozenset(
        {"br", "p", "div", "li", "tr", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6"}
    )
    # Elements whose contents are not visible page text (head holds the title,
    # metadata and styles/scripts).
    _SKIP_TAGS = frozenset({"head", "script", "style"})

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._skip_depth = 0
        self.parts: List[str] = []

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIP_TAGS:
            self._skip_depth += 1
        elif tag in self._BREAK_TAGS:
            self.parts.append(" ")

    def handle_startendtag(self, tag, attrs):
        if tag in self._BREAK_TAGS:
            self.parts.append(" ")

    def handle_endtag(self, tag):
        if tag in self._SKIP_TAGS:
            self._skip_depth = max(0, self._skip_depth - 1)
        elif tag in self._BREAK_TAGS:
            self.parts.append(" ")

    def handle_data(self, data):
        if not self._skip_depth:
            self.parts.append(data)


def _html_to_text(value: Optional[str]) -> str:
    if not value:
        return ""
    parser = _TextExtractor()
    try:
        parser.feed(value)
        parser.close()
    except Exception:  # malformed HTML: best effort
        return ""
    return re.sub(r"\s+", " ", "".join(parser.parts)).strip()


def _exception_reason(exc: BaseException) -> str:
    if isinstance(exc, asyncio.TimeoutError) or isinstance(exc, AbrasioTimeoutError):
        return FailureReason.TIMEOUT
    if isinstance(exc, BlockedError):
        return FailureReason.BLOCKED

    name = type(exc).__name__.lower()
    message = str(exc).lower()
    if "timeout" in name or "timed out" in message or "timeout" in message:
        return FailureReason.TIMEOUT
    if "blocked" in name or "blocked" in message or "forbidden" in message:
        return FailureReason.BLOCKED
    return FailureReason.ERROR


def _failure_result(
    url: str,
    reason: str,
    *,
    error: Optional[str] = None,
    status_code: Optional[int] = None,
    title: Optional[str] = None,
) -> PageFetchResult:
    return PageFetchResult(
        url=url,
        status=STATUS_FAILED,
        attempts=1,  # callers overwrite with the real attempt number
        reason=reason,
        title=title,
        status_code=status_code,
        error=error,
    )


def _result_from_exception(url: str, exc: BaseException) -> PageFetchResult:
    return _failure_result(
        url,
        _exception_reason(exc),
        error=f"{type(exc).__name__}: {exc}"[:1000],
        status_code=getattr(exc, "status_code", None),
    )


async def _safe_title(page: Any) -> Optional[str]:
    try:
        title = await page.title()
    except Exception:
        return None
    if title is None:
        return None
    return str(title)


async def _safe_content(page: Any) -> str:
    try:
        content = await page.content()
    except Exception:
        return ""
    return content if isinstance(content, str) else ""


async def _page_text(page: Any, html: str) -> str:
    """Visible body text, preferring the browser's own text extraction."""
    try:
        text = await page.inner_text("body")
    except Exception:
        text = None
    if isinstance(text, str):
        return text.strip()

    try:
        text = await page.evaluate("() => document.body ? document.body.innerText : ''")
    except Exception:
        text = None
    if isinstance(text, str):
        return text.strip()

    return _html_to_text(html)


def _looks_blocked_html(html: str, title: Optional[str]) -> bool:
    lowered_html = (html or "").lower()
    if any(marker in lowered_html for marker in _BLOCKED_HTML_MARKERS):
        return True
    lowered_title = (title or "").lower()
    return any(marker in lowered_title for marker in _BLOCKED_TITLE_MARKERS)


async def _do_close(page: Any) -> None:
    try:
        result = page.close()
        if inspect.isawaitable(result):
            await asyncio.wait_for(result, timeout=_CLOSE_TIMEOUT_SEC)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # pragma: no cover - browser dependent
        logger.debug("Batch page did not close cleanly: %s", exc)


async def _close_quietly(page: Any) -> None:
    """Close a page, completing the close even if this task is cancelled.

    A page close is cleanup: if the attempt's deadline fires while the page is
    open we cancel the attempt, but the page must still be torn down before
    the URL is retried or its concurrency slot is reused. The close therefore
    runs in its own task and is awaited through cancellation, which is then
    re-raised.
    """
    if page is None:
        return
    close_task = asyncio.ensure_future(_do_close(page))
    try:
        await asyncio.shield(close_task)
    except asyncio.CancelledError:
        # Let the close finish, then propagate the cancellation.
        try:
            await asyncio.wait({close_task})
        except asyncio.CancelledError:  # pragma: no cover - double cancel
            pass
        raise


def _consume_task_outcome(task: asyncio.Future) -> None:
    """Retrieve a finished task's exception so asyncio doesn't warn about it."""
    if task.cancelled():
        return
    try:
        task.exception()
    except Exception:  # pragma: no cover - task already finished
        pass


def _log_unclosed_task(url: str):
    """Callback: note when an abandoned attempt task finally exits."""

    def _callback(task: asyncio.Future) -> None:
        if task.cancelled():
            logger.debug("Abandoned batch attempt for %s finished cancelling", url)
            return
        exc = task.exception()
        if exc is not None:
            logger.debug("Abandoned batch attempt for %s ended: %s", url, exc)

    return _callback


async def _fetch_once(
    page_factory: Callable[[], Awaitable[Any]],
    url: str,
    *,
    timeout_sec: float,
    wait_until: str,
) -> PageFetchResult:
    """One attempt: open a page, navigate, extract, always close the page."""
    page = None
    # Tracks whether the page's *own* close was already awaited, so cleanup in
    # `finally` only fires for pages that would otherwise leak.
    closed = False
    try:
        page = await page_factory()
        try:
            timeout_ms = max(1, int(timeout_sec * 1000))
            response = await page.goto(url, timeout=timeout_ms, wait_until=wait_until)

            status_code = getattr(response, "status", None)
            if status_code in _BLOCKED_STATUS_CODES:
                return _failure_result(
                    url,
                    FailureReason.BLOCKED,
                    status_code=status_code,
                    error=f"HTTP {status_code}",
                )

            title = await _safe_title(page)
            html = await _safe_content(page)
            if _looks_blocked_html(html, title):
                return _failure_result(
                    url,
                    FailureReason.BLOCKED,
                    status_code=status_code,
                    title=title,
                    error="bot-protection / block page detected",
                )

            text = await _page_text(page, html)
            if not text:
                return _failure_result(
                    url,
                    FailureReason.EMPTY,
                    status_code=status_code,
                    title=title,
                    error="page produced no visible body text",
                )

            final_url = getattr(page, "url", None)
            return PageFetchResult(
                url=url,
                status=STATUS_SUCCESS,
                attempts=1,
                title=title,
                text=text,
                status_code=status_code,
                final_url=final_url if isinstance(final_url, str) else None,
            )
        finally:
            # Close before merging back into the parent task: an outer deadline
            # cancel may have been requested but not yet delivered, and we want
            # the page gone before the next attempt starts.
            closed = True
            await _close_quietly(page)
    except Exception as exc:
        return _result_from_exception(url, exc)
    finally:
        if page is not None and not closed:
            await _close_quietly(page)


async def _fetch_with_retries(
    page_factory: Callable[[], Awaitable[Any]],
    url: str,
    *,
    retries: int,
    retry_backoff: float,
    timeout_sec: float,
    wait_until: str,
    semaphore: asyncio.Semaphore,
) -> PageFetchResult:
    """Attempt a URL until it succeeds or its retry budget is exhausted.

    The concurrency slot is taken per attempt, not for the whole retry loop:
    once an attempt's page closes the slot is handed to the next queued URL
    while this URL waits out its backoff.
    """
    total_attempts = retries + 1
    last_result: PageFetchResult = _failure_result(
        url, FailureReason.ERROR, error="no attempt was made"
    )

    for attempt in range(1, total_attempts + 1):
        async with semaphore:
            # Run the attempt as a task so a hard per-attempt deadline can be
            # applied without losing the cleanup path. `_fetch_once` always
            # closes its page in `finally`; when the deadline fires we give it
            # a short grace period to finish closing before the next attempt
            # starts, so a retry never overlaps with a leaked page for the
            # same URL.
            task = asyncio.create_task(
                _fetch_once(
                    page_factory,
                    url,
                    timeout_sec=timeout_sec,
                    wait_until=wait_until,
                )
            )
            done, _ = await asyncio.wait({task}, timeout=timeout_sec)

            if task in done:
                try:
                    last_result = task.result()
                except Exception as exc:  # defensive - _fetch_once shouldn't raise
                    last_result = _result_from_exception(url, exc)
            else:
                last_result = _failure_result(
                    url,
                    FailureReason.TIMEOUT,
                    error=f"timeout after {timeout_sec:g}s",
                )
                # Cancel the attempt, then give it a grace period to run its
                # `finally` (which closes the page). We only move on to the
                # next attempt once the page is gone, so retries never overlap
                # with a leaked page for the same URL.
                task.cancel()
                done, _ = await asyncio.wait({task}, timeout=_CLOSE_GRACE_SEC)
                _consume_task_outcome(task)
                if task not in done:
                    # The browser call is not responding to cancellation.
                    # Abandon it; a background task can't hold the batch, but
                    # log it so a real leak is visible.
                    logger.warning(
                        "Batch attempt for %s did not close its page within %.1fs grace",
                        url,
                        _CLOSE_GRACE_SEC,
                    )
                    task.add_done_callback(_log_unclosed_task(url))

        last_result.attempts = attempt
        if last_result.ok:
            return last_result

        if attempt < total_attempts and retry_backoff > 0:
            await asyncio.sleep(retry_backoff * attempt)

    return last_result


async def fetch_pages_batch(
    page_factory: Callable[[], Awaitable[Any]],
    urls: Sequence[str],
    *,
    max_concurrency: int = 5,
    retries: int = 0,
    retry_backoff: float = 0.0,
    timeout: Optional[float] = None,
    wait_until: str = "domcontentloaded",
) -> List[PageFetchResult]:
    """Fetch all `urls` through `page_factory`, returning ordered outcomes.

    Args:
        page_factory: Awaitable returning a fresh Page (usually
            ``Abrasio.new_page``).
        urls: Addresses to fetch.
        max_concurrency: Maximum pages open at any moment. Extra URLs queue.
        retries: Extra attempts for a failing URL (0 = a single attempt).
        retry_backoff: Seconds to sleep between attempts (multiplied by the
            attempt number).
        timeout: Per-attempt timeout in seconds. Callers normally resolve the
            session default before calling this helper.
        wait_until: Playwright navigation readiness state.

    Returns:
        One `PageFetchResult` per input URL, in input order.
    """
    if max_concurrency < 1:
        raise ValueError("max_concurrency must be >= 1")
    if retries < 0:
        raise ValueError("retries must be >= 0")
    if retry_backoff < 0:
        raise ValueError("retry_backoff must be >= 0")
    if timeout is not None and timeout <= 0:
        raise ValueError("timeout must be > 0 seconds")

    if isinstance(urls, str):
        items: List[str] = [urls]
    else:
        items = list(urls)
    if not items:
        return []

    timeout_sec = float(timeout if timeout is not None else 30.0)
    semaphore = asyncio.Semaphore(max_concurrency)
    # One lock per distinct URL: duplicate entries in `urls` are fetched one
    # after another instead of by two tasks at the same time. Locks are always
    # taken before the concurrency semaphore (a single global order), so this
    # cannot deadlock.
    url_locks = {url: asyncio.Lock() for url in items}
    results: List[Optional[PageFetchResult]] = [None] * len(items)

    async def worker(index: int, url: str) -> None:
        try:
            # Serialize duplicate URLs: the same address is never handled by
            # two tasks at the same time. Locks are always taken before the
            # concurrency semaphore (a single global order), so this cannot
            # deadlock.
            async with url_locks[url]:
                results[index] = await _fetch_with_retries(
                    page_factory,
                    url,
                    retries=retries,
                    retry_backoff=retry_backoff,
                    timeout_sec=timeout_sec,
                    wait_until=wait_until,
                    semaphore=semaphore,
                )
        except Exception as exc:  # defensive: never let one URL abort the batch
            results[index] = _result_from_exception(url, exc)

    tasks = [asyncio.create_task(worker(i, url)) for i, url in enumerate(items)]
    await asyncio.gather(*tasks, return_exceptions=True)

    for index, result in enumerate(results):
        if result is None:  # task was cancelled / died before recording
            results[index] = _failure_result(
                items[index],
                FailureReason.ERROR,
                error="internal error: batch task produced no result",
            )
            results[index].attempts = 0

    completed = [r for r in results if r is not None]
    succeeded = sum(1 for r in completed if r.ok)
    logger.info(
        "fetch_pages: %d/%d succeeded (concurrency=%d, retries=%d)",
        succeeded,
        len(completed),
        max_concurrency,
        retries,
    )
    return [r for r in results if r is not None]
