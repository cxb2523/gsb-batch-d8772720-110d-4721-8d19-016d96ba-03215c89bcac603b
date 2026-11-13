"""HTTP fetching with retry, backoff, and header rotation.

A small, dependency-light fetcher built on top of ``requests``. It pairs the
CAPTCHA detection logic in :mod:`amazon_captcha.detect` with exponential
backoff and per-attempt header rotation, so the example demonstrates *why* naive
scraping hits CAPTCHA and what a minimal resilience layer looks like.

This is intentionally not a production scraping engine — it exists to make the
tutorial's claims concrete and runnable.

Two entry points are provided:

* :func:`fetch_record` — always returns a structured :class:`FetchRecord`
  describing every attempt and its terminal outcome (success, CAPTCHA
  exhaustion, or request error). It never raises, which makes it safe to call
  from batch pipelines where one bad input must not abort the whole run.
* :func:`fetch_with_retry` — the original convenience wrapper that returns a
  :class:`FetchOutcome` on an HTTP response or raises :class:`FetchError` once
  all attempts fail with a request exception.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from dataclasses import dataclass, field

import requests

from .detect import DetectionResult, detect
from .headers import BROWSER_PROFILES, BrowserProfile, rotating_profiles

# Terminal outcome categories for a (possibly retried) fetch.
OUTCOME_SUCCESS = "success"
"""A page was retrieved and the final response is not a CAPTCHA/challenge."""

OUTCOME_CAPTCHA_EXHAUSTED = "captcha_exhausted"
"""All attempts were spent and the last response was still a CAPTCHA/challenge."""
OUTCOME_REQUEST_ERROR = "request_error"
"""Every attempt raised a request-level exception (connection, timeout, ...)."""

FETCH_OUTCOMES: frozenset[str] = frozenset(
    {OUTCOME_SUCCESS, OUTCOME_CAPTCHA_EXHAUSTED, OUTCOME_REQUEST_ERROR}
)


class FetchError(Exception):
    """Raised when a fetch ultimately fails after all retries.

    Carries ``attempts`` so callers catching the exception still know how many
    HTTP attempts were made before it was raised.
    """

    def __init__(self, message: str, *, attempts: int = 0) -> None:
        super().__init__(message)
        self.attempts = attempts


@dataclass
class FetchOutcome:
    """Result of a single (possibly retried) fetch attempt."""

    response: requests.Response
    detection: DetectionResult
    attempts: int

    @property
    def is_captcha(self) -> bool:
        return self.detection.is_captcha


@dataclass
class FetchRecord:
    """Auditable record of everything that happened while fetching one URL.

    Attributes:
        url: The requested URL (the input URL as passed in).
        attempts: Number of HTTP attempts actually made (>= 1 once the fetch
            ran, including attempts that raised before returning a response).
        status_code: Final HTTP status code, or ``None`` when no response was
            ever received (e.g. repeated connection failures).
        is_captcha: Whether the final response was detected as a CAPTCHA /
            challenge page. Always ``False`` for request-error outcomes.
        risk_level: Risk bucket from the final detection
            (``none``/``low``/``medium``/``high``); ``none`` when no response
            was received.
        matched_markers: Canonical CAPTCHA markers hit on the final response.
        outcome: Terminal category — one of :data:`FETCH_OUTCOMES`.
        error: Stringified exception message for request-error outcomes,
            otherwise ``None``.
        effective_url: Final URL reported by the response (after redirects),
            or ``None`` when no response was received.
    """

    url: str
    attempts: int = 0
    status_code: int | None = None
    is_captcha: bool = False
    risk_level: str = "none"
    matched_markers: list[str] = field(default_factory=list)
    outcome: str = OUTCOME_REQUEST_ERROR
    error: str | None = None
    effective_url: str | None = None
    # The raw response/detection are retained for in-process callers (e.g. the
    # fetch subcommand that saves the body) but excluded from serialization.
    response: requests.Response | None = field(default=None, repr=False, compare=False)
    detection: DetectionResult | None = field(default=None, repr=False, compare=False)
    error_exc: Exception | None = field(default=None, repr=False, compare=False)

    @property
    def ok(self) -> bool:
        """True when the terminal outcome was a normal page retrieval."""
        return self.outcome == OUTCOME_SUCCESS

    def to_dict(self) -> dict:
        """JSON-serializable view of the record (no raw response/exception)."""
        return {
            "url": self.url,
            "attempts": self.attempts,
            "status_code": self.status_code,
            "is_captcha": self.is_captcha,
            "risk_level": self.risk_level,
            "matched_markers": list(self.matched_markers),
            "outcome": self.outcome,
            "error": self.error,
            "effective_url": self.effective_url,
        }


def _backoff(attempt: int, base: float, cap: float) -> float:
    """Exponential backoff with a cap, plus a touch of jitter-free determinism."""
    return min(cap, base * (2 ** (attempt - 1)))


def fetch_record(
    url: str,
    *,
    max_attempts: int = 3,
    backoff_base: float = 1.0,
    backoff_cap: float = 30.0,
    timeout: float = 30.0,
    profiles: Iterator[BrowserProfile] | None = None,
    session: requests.Session | None = None,
    detect_captcha: bool = True,
    sleep: callable = time.sleep,
) -> FetchRecord:
    """Fetch *url* and always return a structured :class:`FetchRecord`.

    Retries trigger on connection errors, on challenge status codes (403/429/
    503), and — when *detect_captcha* is True — on responses that look like a
    CAPTCHA page. Each retry sleeps with exponential backoff.

    This function never raises: terminal failures are reported via the record's
    ``outcome`` and ``error`` fields instead, so batch callers always get one
    auditable record per input.

    Args:
        url: Absolute URL to fetch.
        max_attempts: Maximum number of HTTP attempts (including the first).
        backoff_base: Base seconds for exponential backoff.
        backoff_cap: Upper bound on a single backoff sleep.
        timeout: Per-request timeout in seconds.
        profiles: Iterator yielding a :class:`BrowserProfile` per attempt.
            Defaults to a round-robin over :data:`BROWSER_PROFILES`.
        session: Optional :class:`requests.Session` for connection reuse.
        detect_captcha: When True, a CAPTCHA-looking body triggers a retry.
        sleep: Injectible sleep (used by tests to avoid real waiting).

    Returns:
        A :class:`FetchRecord` whose ``outcome`` is one of:

        * :data:`OUTCOME_SUCCESS` — final response is an ordinary page;
        * :data:`OUTCOME_CAPTCHA_EXHAUSTED` — retries ran out while the last
          response was still a CAPTCHA/challenge page;
        * :data:`OUTCOME_REQUEST_ERROR` — every attempt raised a request
          exception; ``error`` holds the last exception's message.
    """
    if profiles is None:
        profiles = rotating_profiles()
    sess = session or requests.Session()

    record = FetchRecord(url=url)
    last_exc: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        record.attempts = attempt
        profile = next(profiles)
        headers = profile.as_headers()
        try:
            resp = sess.get(url, headers=headers, timeout=timeout)
        except requests.RequestException as exc:
            last_exc = exc
            if attempt < max_attempts:
                sleep(_backoff(attempt, backoff_base, backoff_cap))
                continue
            record.outcome = OUTCOME_REQUEST_ERROR
            record.error = f"Request failed after {max_attempts} attempts: {exc}"
            record.error_exc = exc
            return record

        result = detect(
            resp.text,
            status=resp.status_code,
            url=str(resp.url),
        )
        record.response = resp
        record.detection = result
        record.status_code = resp.status_code
        record.effective_url = str(resp.url)
        record.is_captcha = result.is_captcha
        record.risk_level = result.risk_level
        record.matched_markers = list(result.matched_markers)

        should_retry = resp.status_code in (403, 429, 503) or (detect_captcha and result.is_captcha)
        if not should_retry or attempt == max_attempts:
            record.outcome = OUTCOME_CAPTCHA_EXHAUSTED if result.is_captcha else OUTCOME_SUCCESS
            return record

        sleep(_backoff(attempt, backoff_base, backoff_cap))

    # Unreachable: the loop always returns. Kept for type safety / defensive use.
    record.outcome = OUTCOME_REQUEST_ERROR
    record.error = f"Exhausted {max_attempts} attempts" + (
        f"; last error: {last_exc}" if last_exc else ""
    )
    record.error_exc = last_exc
    return record


def fetch_with_retry(
    url: str,
    *,
    max_attempts: int = 3,
    backoff_base: float = 1.0,
    backoff_cap: float = 30.0,
    timeout: float = 30.0,
    profiles: Iterator[BrowserProfile] | None = None,
    session: requests.Session | None = None,
    detect_captcha: bool = True,
    sleep: callable = time.sleep,
) -> FetchOutcome:
    """Fetch *url* with retry, backoff, and per-attempt header rotation.

    Thin wrapper over :func:`fetch_record` preserving the original contract:
    returns a :class:`FetchOutcome` whenever an HTTP response was received (even
    if it is a CAPTCHA page after the final retry), and raises
    :class:`FetchError` when every attempt failed with a request exception.

    Args:
        url: Absolute URL to fetch.
        max_attempts: Maximum number of HTTP attempts (including the first).
        backoff_base: Base seconds for exponential backoff.
        backoff_cap: Upper bound on a single backoff sleep.
        timeout: Per-request timeout in seconds.
        profiles: Iterator yielding a :class:`BrowserProfile` per attempt.
            Defaults to a round-robin over :data:`BROWSER_PROFILES`.
        session: Optional :class:`requests.Session` for connection reuse.
        detect_captcha: When True, a CAPTCHA-looking body triggers a retry.
        sleep: Injectible sleep (used by tests to avoid real waiting).
    """
    record = fetch_record(
        url,
        max_attempts=max_attempts,
        backoff_base=backoff_base,
        backoff_cap=backoff_cap,
        timeout=timeout,
        profiles=profiles,
        session=session,
        detect_captcha=detect_captcha,
        sleep=sleep,
    )
    if record.outcome == OUTCOME_REQUEST_ERROR:
        raise FetchError(
            record.error or f"Request failed after {record.attempts} attempts",
            attempts=record.attempts,
        ) from record.error_exc
    # A response was received on every non-error outcome; assert for typing.
    assert record.response is not None and record.detection is not None
    return FetchOutcome(
        response=record.response,
        detection=record.detection,
        attempts=record.attempts,
    )


def fetch_once(
    url: str, *, profile: BrowserProfile | None = None, timeout: float = 30.0
) -> FetchOutcome:
    """Single, non-retrying fetch with optional explicit profile selection."""
    profile = profile or BROWSER_PROFILES[0]
    sess = requests.Session()
    resp = sess.get(url, headers=profile.as_headers(), timeout=timeout)
    result = detect(resp.text, status=resp.status_code, url=str(resp.url))
    return FetchOutcome(response=resp, detection=result, attempts=1)
