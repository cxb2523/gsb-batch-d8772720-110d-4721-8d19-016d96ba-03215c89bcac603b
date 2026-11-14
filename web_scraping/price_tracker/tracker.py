"""Price tracker web scraping with structured, retry-aware results.

Every fetch is classified into one of the outcome categories below instead of
returning an ambiguous free-text string, and transient failures (network errors
and HTTP 5xx responses) are retried automatically.

Outcome categories
------------------
OUTCOME_SUCCESS          - target element found and its text extracted
OUTCOME_ELEMENT_NOT_FOUND- page fetched and parsed but no matching element
OUTCOME_HTTP_ERROR       - server responded with a non-retryable HTTP error (4xx)
OUTCOME_NETWORK_ERROR    - request never produced a response (timeout, DNS, ...)
OUTCOME_PARSE_ERROR      - response body could not be parsed / inspected

The real fetch path keeps using ``requests.get`` with a browser User-Agent.
For local verification without touching the network, instantiate
:class:`WebScraper` and inject a fake request callable (and, optionally, a
replacement for the retry wait).
"""

from dataclasses import dataclass, field
from typing import Any, Callable, List, Optional

import requests
from bs4 import BeautifulSoup

# ---------------------------------------------------------------------------
# Outcome categories (stable string constants; safe to compare against)
# ---------------------------------------------------------------------------
OUTCOME_SUCCESS = "success"
OUTCOME_ELEMENT_NOT_FOUND = "element_not_found"
OUTCOME_HTTP_ERROR = "http_error"
OUTCOME_NETWORK_ERROR = "network_error"
OUTCOME_PARSE_ERROR = "parse_error"

# Transient outcomes that are eligible for a retry.
RETRYABLE_OUTCOMES = (OUTCOME_NETWORK_ERROR, )

# At most three attempts per fetch (the initial try + two retries).
DEFAULT_MAX_ATTEMPTS = 3
# Short pause before the 2nd and 3rd attempts; configurable per scraper.
DEFAULT_RETRY_DELAY = 1.0

# Realistic User-Agent to avoid being blocked by servers
DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
    )
}


@dataclass(frozen=True)
class AttemptRecord:
    """One row in the per-attempt history of a fetch."""

    attempt_number: int
    outcome: str
    status_code: Optional[int]
    reason: str

    def to_dict(self) -> dict:
        return {
            "attempt_number": self.attempt_number,
            "outcome": self.outcome,
            "status_code": self.status_code,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class ScrapeResult:
    """Structured result of :meth:`WebScraper.get_web_data`.

    Attributes
    ----------
    outcome:
        Final outcome category (one of the ``OUTCOME_*`` constants).
    text:
        Trimmed target text on success, otherwise ``None``.
    status_code:
        HTTP status code of the last response that was actually received,
        or ``None`` if no response ever came back.
    reason:
        Short human-readable explanation of the final outcome.
    attempts:
        Ordered history of every attempt, each an :class:`AttemptRecord`.
    """

    outcome: str
    text: Optional[str]
    status_code: Optional[int]
    reason: str
    attempts: List[AttemptRecord] = field(default_factory=list)

    @property
    def success(self) -> bool:
        return self.outcome == OUTCOME_SUCCESS

    def to_dict(self) -> dict:
        return {
            "outcome": self.outcome,
            "text": self.text,
            "status_code": self.status_code,
            "reason": self.reason,
            "attempts": [attempt.to_dict() for attempt in self.attempts],
        }


class WebScraper:
    """Retrying scraper with injectable transport and wait functions.

    Parameters
    ----------
    request_func:
        Callable used for every HTTP attempt. It must accept
        ``(url, headers=...)`` and return a response-like object exposing
        ``status_code`` (int) and ``content`` (bytes/str). Defaults to
        ``requests.get`` for real network access. Inject a fake to run fully
        offline: the fake may return fixed HTML or raise an exception.
    wait_func:
        Callable invoked with the delay (seconds) before each retry. Defaults
        to :func:`time.sleep`; inject a recorder to avoid real waiting.
    max_attempts:
        Maximum number of attempts per fetch (default 3).
    retry_delay:
        Short wait before the 2nd and 3rd attempts, in seconds.
    headers:
        Request headers; defaults to the browser User-Agent headers.
    """

    def __init__(
        self,
        request_func: Optional[Callable[..., Any]] = None,
        wait_func: Optional[Callable[[float], None]] = None,
        max_attempts: int = DEFAULT_MAX_ATTEMPTS,
        retry_delay: float = DEFAULT_RETRY_DELAY,
        headers: Optional[dict] = None,
    ) -> None:
        if max_attempts < 1:
            raise ValueError("max_attempts must be at least 1")
        self.request_func = request_func if request_func is not None else requests.get
        if wait_func is not None:
            self.wait_func = wait_func
        else:
            import time

            self.wait_func = time.sleep
        self.max_attempts = max_attempts
        self.retry_delay = retry_delay
        self.headers = dict(DEFAULT_HEADERS if headers is None else headers)

    # ------------------------------------------------------------------
    # Public entry
    # ------------------------------------------------------------------
    def get_web_data(
        self,
        url: str,
        tag: str,
        attribute: str,
        value: str,
    ) -> ScrapeResult:
        """Fetch ``url`` and extract text from ``<tag attribute=value>``.

        Never raises for element-not-found, HTTP, network or parse failures;
        every failure is reported through the returned :class:`ScrapeResult`.
        Only network errors and HTTP 5xx responses are retried (up to
        ``max_attempts`` times). 4xx responses, missing elements and parse
        errors settle on the first attempt.
        """
        attempts: List[AttemptRecord] = []
        last_status_code: Optional[int] = None

        for attempt_number in range(1, self.max_attempts + 1):
            record, target_text = self._attempt(
                url, tag, attribute, value, attempt_number
            )
            attempts.append(record)
            if record.status_code is not None:
                last_status_code = record.status_code

            if record.outcome == OUTCOME_SUCCESS:
                return self._build_result(
                    record, target_text, last_status_code, attempts
                )

            if not self._is_retryable(record) or attempt_number == self.max_attempts:
                # First-and-final for non-transient outcomes, or retries spent.
                return self._build_result(
                    record, None, last_status_code, attempts
                )

            # Transient failure: short, configurable wait before the retry.
            self.wait_func(self.retry_delay)

        # Defensive fallback; the loop above always returns explicitly.
        last_record = attempts[-1]
        return self._build_result(last_record, None, last_status_code, attempts)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------
    def _attempt(
        self,
        url: str,
        tag: str,
        attribute: str,
        value: str,
        attempt_number: int,
    ) -> tuple:
        """Run a single attempt, returning ``(AttemptRecord, text_or_None)``."""
        try:
            response = self.request_func(url, headers=self.headers)
        except requests.exceptions.RequestException as exc:
            return (
                AttemptRecord(
                    attempt_number,
                    OUTCOME_NETWORK_ERROR,
                    None,
                    self._short_reason(exc),
                ),
                None,
            )
        except Exception as exc:  # pragma: no cover - non-requests transport
            return (
                AttemptRecord(
                    attempt_number,
                    OUTCOME_NETWORK_ERROR,
                    None,
                    self._short_reason(exc),
                ),
                None,
            )

        status_code = getattr(response, "status_code", None)

        # HTTP error: server responded, so this is distinct from a network
        # error. Only 5xx is transient; 4xx (and any other 4xx-class code)
        # settles immediately.
        if isinstance(status_code, int) and status_code >= 400:
            if 500 <= status_code < 600:
                outcome = OUTCOME_HTTP_ERROR
                reason = f"HTTP {status_code} server error"
            else:
                outcome = OUTCOME_HTTP_ERROR
                reason = f"HTTP {status_code} client error"
            return (
                AttemptRecord(attempt_number, outcome, status_code, reason),
                None,
            )

        try:
            soup = BeautifulSoup(response.content, "html.parser")
            target_element = soup.find(tag, {attribute: value})

            if target_element is None:
                # Missing element is an outcome, never an exception.
                return (
                    AttemptRecord(
                        attempt_number,
                        OUTCOME_ELEMENT_NOT_FOUND,
                        status_code,
                        (
                            f"No element <{tag}> with "
                            f"{attribute}='{value}' found in the page"
                        ),
                    ),
                    None,
                )

            text = target_element.get_text().strip()
            if not text:
                # Element present but empty after trimming: treat as missing.
                return (
                    AttemptRecord(
                        attempt_number,
                        OUTCOME_ELEMENT_NOT_FOUND,
                        status_code,
                        (
                            f"Element <{tag}> with {attribute}='{value}' "
                            "contained no text"
                        ),
                    ),
                    None,
                )
        except Exception as exc:
            return (
                AttemptRecord(
                    attempt_number,
                    OUTCOME_PARSE_ERROR,
                    status_code,
                    self._short_reason(exc),
                ),
                None,
            )

        return (
            AttemptRecord(
                attempt_number,
                OUTCOME_SUCCESS,
                status_code,
                "Target element found",
            ),
            text,
        )

    @staticmethod
    def _is_retryable(record: AttemptRecord) -> bool:
        if record.outcome in RETRYABLE_OUTCOMES:
            return True
        # 5xx responses are the retryable HTTP errors; 4xx are final.
        return (
            record.outcome == OUTCOME_HTTP_ERROR
            and isinstance(record.status_code, int)
            and 500 <= record.status_code < 600
        )

    @staticmethod
    def _build_result(
        record: AttemptRecord,
        text: Optional[str],
        status_code: Optional[int],
        attempts: List[AttemptRecord],
    ) -> ScrapeResult:
        return ScrapeResult(
            outcome=record.outcome,
            text=text,
            status_code=status_code,
            reason=record.reason,
            attempts=list(attempts),
        )

    @staticmethod
    def _short_reason(exc: BaseException, limit: int = 200) -> str:
        message = str(exc).strip() or exc.__class__.__name__
        if len(message) > limit:
            message = message[: limit - 3] + "..."
        return f"{exc.__class__.__name__}: {message}"


# Module-level default scraper used by the backwards-compatible entry point.
_default_scraper = WebScraper()


def get_web_data(url, tag, attribute, value):
    """Fetch text from ``<tag attribute=value>`` on the page at ``url``.

    The function name and four parameters are unchanged, but the return value
    is now a structured :class:`ScrapeResult` (see its fields for the final
    outcome category, extracted text, last HTTP status code, reason and the
    full per-attempt history). This uses the real ``requests`` transport with
    the browser User-Agent; for offline tests use :class:`WebScraper` with an
    injected fake request function.
    """
    return _default_scraper.get_web_data(url, tag, attribute, value)


if __name__ == "__main__":
    # Test: Fetching the main heading of a Wikipedia page
    target_url = "https://en.wikipedia.org/wiki/Python_(programming_language)"

    print(f"DEBUG: Fetching data from {target_url}...")

    # Parameters: tag='h1', attribute='id', value='firstHeading'
    result = get_web_data(target_url, "h1", "id", "firstHeading")

    print("RESULT:")
    for key, val in result.to_dict().items():
        print(f"  {key}: {val}")
