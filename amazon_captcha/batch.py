"""Batch processing for many ASINs / URLs with concurrency control.

Wraps either the local fetcher (:mod:`amazon_captcha.fetch`) or the Thordata
client (:mod:`amazon_captcha.thordata_client`) so a list of ASINs can be
processed with bounded concurrency, optional progress bar, and graceful
per-item error handling.

The auditable pipeline is :func:`run_fetch_batch`: every input produces exactly
one :class:`BatchRecord` describing the requested URL, the number of attempts,
the final status, CAPTCHA detection details, and a terminal outcome category.
One item failing never interrupts the rest of the batch.
"""

from __future__ import annotations

import concurrent.futures
import time
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field

from .export import PRODUCT_COLUMNS
from .fetch import (
    FETCH_OUTCOMES,
    OUTCOME_CAPTCHA_EXHAUSTED,
    OUTCOME_REQUEST_ERROR,
    OUTCOME_SUCCESS,
    FetchRecord,
    fetch_record,
)

try:  # tqdm is optional — degrade gracefully when absent.
    from tqdm import tqdm

    _HAS_TQDM = True
except ImportError:  # pragma: no cover
    _HAS_TQDM = False


@dataclass
class BatchResult:
    """Outcome of a batch run (legacy generic worker contract)."""

    ok: list[dict] = field(default_factory=list)
    errors: list[dict] = field(default_factory=list)

    @property
    def total(self) -> int:
        return len(self.ok) + len(self.errors)


@dataclass
class BatchRecord:
    """One auditable record per batch input.

    Attributes:
        item: The original input line (ASIN or URL, verbatim).
        url: The URL actually requested. When the input was an ASIN this is
            the result of :func:`asin_to_url`; otherwise it equals *item*.
        attempts: Number of HTTP attempts made.
        status_code: Final HTTP status code, or ``None`` on request errors.
        is_captcha: Whether the final response was a CAPTCHA/challenge page.
        risk_level: Detection risk bucket (``none``/``low``/``medium``/
            ``high``); ``none`` when no response was received.
        matched_markers: CAPTCHA markers hit on the final response.
        outcome: Terminal category — ``success``, ``captcha_exhausted`` or
            ``request_error``.
        error: Exception message for request-error outcomes, else ``None``.
        effective_url: Final URL after redirects, when a response was received.
    """

    item: str
    url: str
    attempts: int = 0
    status_code: int | None = None
    is_captcha: bool = False
    risk_level: str = "none"
    matched_markers: list[str] = field(default_factory=list)
    outcome: str = OUTCOME_REQUEST_ERROR
    error: str | None = None
    effective_url: str | None = None

    @property
    def ok(self) -> bool:
        """True when the item ended in a normal page retrieval."""
        return self.outcome == OUTCOME_SUCCESS

    @classmethod
    def from_fetch(cls, item: str, url: str, record: FetchRecord) -> BatchRecord:
        """Build a batch record from an item/URL pair and a :class:`FetchRecord`."""
        return cls(
            item=item,
            url=url,
            attempts=record.attempts,
            status_code=record.status_code,
            is_captcha=record.is_captcha,
            risk_level=record.risk_level,
            matched_markers=list(record.matched_markers),
            outcome=record.outcome,
            error=record.error,
            effective_url=record.effective_url,
        )

    def to_dict(self) -> dict:
        """JSON-serializable view of the record."""
        return {
            "item": self.item,
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


def asin_to_url(asin: str, domain: str = "amazon.com") -> str:
    """Build a canonical Amazon product URL from an ASIN."""
    asin = asin.strip()
    if asin.startswith(("http://", "https://")):
        return asin
    return f"https://www.{domain}/dp/{asin}"


def run_fetch_batch(
    items: Iterable[str],
    *,
    as_asin: bool = False,
    domain: str = "amazon.com",
    max_workers: int = 4,
    max_attempts: int = 3,
    timeout: float = 30.0,
    session=None,
    session_factory: Callable[[], object] | None = None,
    sleep: Callable[[float], None] = time.sleep,
    show_progress: bool = False,
    desc: str = "batch",
) -> list[BatchRecord]:
    """Fetch every input with bounded concurrency; return one record per item.

    Each input is converted to a request URL first (via
    :func:`asin_to_url` when *as_asin* is True) and then handed to
    :func:`amazon_captcha.fetch.fetch_record`. Because ``fetch_record`` never
    raises, a single bad item cannot abort the run; request-level failures are
    captured on the returned record. The output order matches the input order
    so records can be checked against the source file line by line.

    Args:
        items: ASINs or URLs to process.
        as_asin: When True, treat each item as an ASIN and convert it to a
            canonical product URL under *domain*.
        domain: Amazon domain used when *as_asin* is True.
        max_workers: Thread pool size.
        max_attempts: Maximum HTTP attempts per item.
        timeout: Per-request timeout in seconds.
        session: Optional shared session-like object (needs a ``get`` method).
        session_factory: Zero-argument callable returning a per-item session;
            takes precedence over *session*. Mainly used to inject fakes in
            tests without any real network access.
        sleep: Injectible backoff sleep.
        show_progress: Show a tqdm bar when tqdm is installed.
        desc: Progress bar description.

    Returns:
        A list of :class:`BatchRecord` in the same order as *items*.
    """
    items = list(items)

    def resolve_url(raw: str) -> str:
        return asin_to_url(raw, domain=domain) if as_asin else raw.strip()

    def worker(raw_item: str) -> BatchRecord:
        url = resolve_url(raw_item)
        try:
            sess = session_factory() if session_factory is not None else session
            record = fetch_record(
                url,
                max_attempts=max_attempts,
                timeout=timeout,
                session=sess,
                sleep=sleep,
            )
        except Exception as exc:  # noqa: BLE001 — batch must survive any failure
            record = FetchRecord(
                url=url,
                outcome=OUTCOME_REQUEST_ERROR,
                error=f"Unexpected batch worker failure: {exc!r}",
                error_exc=exc,
            )
        return BatchRecord.from_fetch(raw_item, url, record)

    records: list[BatchRecord | None] = [None] * len(items)
    iterator: Iterable[tuple[int, str]] = list(enumerate(items))
    if show_progress and _HAS_TQDM:
        iterator = tqdm(iterator, total=len(items), desc=desc)

    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as pool:
        future_map = {pool.submit(worker, raw_item): index for index, raw_item in iterator}
        for future in concurrent.futures.as_completed(future_map):
            index = future_map[future]
            # The worker itself never raises; result() only surfaces pool bugs.
            records[index] = future.result()

    return [record for record in records if record is not None]


def summarize(records: Sequence[BatchRecord]) -> dict[str, int]:
    """Count records by outcome category (all known categories are present)."""
    counts = dict.fromkeys(sorted(FETCH_OUTCOMES), 0)
    for record in records:
        counts[record.outcome] = counts.get(record.outcome, 0) + 1
    counts["total"] = len(records)
    return counts


def run_batch(
    items: Iterable[str],
    worker: Callable[[str], dict],
    *,
    max_workers: int = 4,
    show_progress: bool = True,
    desc: str = "processing",
) -> BatchResult:
    """Run *worker* over *items* with bounded concurrency.

    Args:
        items: Identifiers (ASINs or URLs) to process.
        worker: Callable that takes one item and returns a dict result. It may
            raise — failures are recorded, not propagated.
        max_workers: Thread pool size.
        show_progress: Show a tqdm bar when tqdm is installed.
        desc: Progress bar description.
    """
    items = list(items)
    result = BatchResult()

    iterator: Iterable[str] = items
    if show_progress and _HAS_TQDM:
        iterator = tqdm(items, desc=desc)

    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as pool:
        future_map = {pool.submit(worker, item): item for item in iterator}
        for future in concurrent.futures.as_completed(future_map):
            item = future_map[future]
            try:
                result.ok.append(future.result())
            except Exception as exc:  # noqa: BLE001 — batch must survive
                result.errors.append({"item": item, "error": repr(exc)})
    return result


__all__ = [
    "BatchRecord",
    "BatchResult",
    "asin_to_url",
    "run_batch",
    "run_fetch_batch",
    "summarize",
    "PRODUCT_COLUMNS",
    "OUTCOME_SUCCESS",
    "OUTCOME_CAPTCHA_EXHAUSTED",
    "OUTCOME_REQUEST_ERROR",
    "FETCH_OUTCOMES",
]
