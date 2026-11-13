"""Batch page crawling on top of :class:`~selectolax.lexbor.LexborHTMLParser`.

Fetching the pages is the caller's job. This module takes the fetched HTML and
handles everything that comes afterwards in one place:

* parsing every page with :class:`~selectolax.lexbor.LexborHTMLParser`,
* running a caller-supplied extraction function against each parsed document,
* recording a per-page outcome (success with the extracted value, or failure
  with the error type and message) instead of letting one bad page abort the
  whole batch,
* resuming a previous run so that pages which already succeeded are never
  parsed or extracted again.

Typical usage::

    from selectolax.crawl import crawl_pages

    def extract_title(tree):
        return tree.css_first("h1").text(strip=True)

    summary = crawl_pages(
        [
            {"page_id": "home", "html": "<h1>Home</h1>"},
            ("about", b"<h1>About</h1>"),
        ],
        extract_title,
    )
    summary.failed_page_ids          # []
    summary["home"].result           # 'Home'

    # Fix the failing pages/tasks and hand the summary back; pages that
    # succeeded above are skipped and ``extract_title`` is not called for them.
    summary = crawl_pages(fixed_tasks, extract_title, previous=summary)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple, Union

from selectolax.lexbor import LexborHTMLParser

__all__ = [
    "PageStatus",
    "PageResult",
    "CrawlSummary",
    "CrawlValidationError",
    "EmptyExtractionResultError",
    "crawl_pages",
]

#: A task is either a ``(page_id, html)`` pair or a mapping holding the
#: ``page_id`` and ``html`` keys (extra keys are allowed and ignored).
Task = Union[Tuple[Any, Union[str, bytes]], Mapping[str, Any]]

#: Extraction functions receive a parsed document and may return anything
#: except ``None``; returning ``None`` is recorded as a page failure.
Extractor = Callable[[LexborHTMLParser], Any]


class PageStatus(str, Enum):
    """Outcome of processing a single page."""

    SUCCESS = "success"
    FAILED = "failed"


class CrawlValidationError(ValueError):
    """Raised when the crawl input itself is invalid.

    Subclasses :class:`ValueError`, so existing code catching ``ValueError``
    keeps working. It is raised before any page is processed, for example when
    the task sequence is empty, a task lacks ``page_id``/``html`` or page ids
    are duplicated.
    """


class EmptyExtractionResultError(ValueError):
    """Raised when an extraction function returns ``None``.

    The exception is caught inside :func:`crawl_pages` and recorded as a failed
    :class:`PageResult`, so a ``None`` result is never silently treated as
    success. The class is exported so callers can recognise the error type.
    """


@dataclass
class PageResult:
    """The outcome of processing one page.

    Attributes
    ----------
    page_id:
        Identifier the task was submitted with.
    status:
        :attr:`PageStatus.SUCCESS` or :attr:`PageStatus.FAILED`.
    result:
        Value returned by the extraction function on success, ``None`` on
        failure.
    error_type:
        Class name of the exception that failed the page (e.g.
        ``"AttributeError"``), or ``None`` on success.
    error_message:
        Message of that exception, or ``None`` on success.
    """

    page_id: Any
    status: PageStatus
    result: Any = None
    error_type: Optional[str] = None
    error_message: Optional[str] = None

    @classmethod
    def success(cls, page_id: Any, result: Any) -> "PageResult":
        return cls(page_id=page_id, status=PageStatus.SUCCESS, result=result)

    @classmethod
    def failure(cls, page_id: Any, exc: BaseException) -> "PageResult":
        return cls(
            page_id=page_id,
            status=PageStatus.FAILED,
            error_type=type(exc).__name__,
            error_message=str(exc),
        )

    @property
    def ok(self) -> bool:
        """``True`` when the page was extracted successfully."""
        return self.status is PageStatus.SUCCESS

    def __bool__(self) -> bool:
        return self.ok


@dataclass
class CrawlSummary:
    """Aggregate outcome of a :func:`crawl_pages` run.

    The object is both the return value of a run and the resume token for the
    next one: pass it as ``previous`` to skip every page that already
    succeeded.
    """

    #: One :class:`PageResult` per page id, in processing order.
    results: Dict[Any, PageResult] = field(default_factory=dict)
    #: Number of tasks actually parsed and extracted in this run.
    processed: int = 0
    #: Number of tasks skipped because they already succeeded in ``previous``.
    skipped: int = 0

    def __getitem__(self, page_id: Any) -> PageResult:
        return self.results[page_id]

    def get(
        self, page_id: Any, default: Optional[PageResult] = None
    ) -> Optional[PageResult]:
        """Return the page result, or ``default`` when the id is unknown."""
        return self.results.get(page_id, default)

    def __contains__(self, page_id: Any) -> bool:
        return page_id in self.results

    def __iter__(self):
        return iter(self.results)

    def __len__(self) -> int:
        return len(self.results)

    @property
    def failed_page_ids(self) -> List[Any]:
        """Ids of every failed page, in the order the tasks were submitted."""
        return [page_id for page_id, result in self.results.items() if not result.ok]

    @property
    def successful_page_ids(self) -> List[Any]:
        """Ids of every successfully extracted page, in submission order."""
        return [page_id for page_id, result in self.results.items() if result.ok]

    @property
    def failures(self) -> List[PageResult]:
        """The :class:`PageResult` objects of all failed pages."""
        return [result for result in self.results.values() if not result.ok]

    @property
    def succeeded(self) -> List[PageResult]:
        """The :class:`PageResult` objects of all successful pages."""
        return [result for result in self.results.values() if result.ok]

    @property
    def total(self) -> int:
        """Number of pages recorded in this summary."""
        return len(self.results)

    @property
    def failed_count(self) -> int:
        """Number of failed pages."""
        return len(self.failures)

    @property
    def succeeded_count(self) -> int:
        """Number of successful pages."""
        return len(self.succeeded)


def _normalize_tasks(tasks: Any) -> List[Tuple[Any, Union[str, bytes]]]:
    """Validate the task sequence and turn every task into ``(id, html)``.

    Validation runs up-front, before any page is parsed, so malformed input is
    reported consistently instead of surfacing halfway through a batch.
    """
    if isinstance(tasks, (str, bytes)) or not hasattr(tasks, "__iter__"):
        raise CrawlValidationError(
            "tasks must be an iterable of task mappings or (page_id, html) pairs"
        )

    normalized: List[Tuple[Any, Union[str, bytes]]] = []
    seen_ids = set()

    for index, task in enumerate(tasks):
        location = f"task at index {index}"

        if isinstance(task, Mapping):
            if "page_id" not in task:
                raise CrawlValidationError(f"{location} is missing the 'page_id' key")
            if "html" not in task:
                raise CrawlValidationError(f"{location} is missing the 'html' key")
            page_id, html = task["page_id"], task["html"]
        elif isinstance(task, tuple) and not isinstance(task, (str, bytes)):
            if len(task) != 2:
                raise CrawlValidationError(
                    f"{location} must be a (page_id, html) pair, got {len(task)} elements"
                )
            page_id, html = task
        else:
            raise CrawlValidationError(
                f"{location} must be a mapping or a (page_id, html) pair, "
                f"got {type(task).__name__}"
            )

        if page_id is None:
            raise CrawlValidationError(f"{location} has a 'page_id' of None")
        try:
            hash(page_id)
        except TypeError as exc:
            raise CrawlValidationError(
                f"{location} has an unhashable page_id of type {type(page_id).__name__}"
            ) from exc
        if not isinstance(html, (str, bytes)):
            raise CrawlValidationError(
                f"{location} html must be str or bytes, got {type(html).__name__}"
            )
        if page_id in seen_ids:
            raise CrawlValidationError(f"duplicate page_id {page_id!r} in tasks")
        seen_ids.add(page_id)

        normalized.append((page_id, html))

    if not normalized:
        raise CrawlValidationError("tasks must contain at least one page")

    return normalized


def crawl_pages(
    tasks: Any,
    extractor: Extractor,
    previous: Optional[CrawlSummary] = None,
) -> CrawlSummary:
    """Parse a batch of pages and extract data from each one.

    Each task must provide a page identifier and a piece of HTML. A task is
    either a mapping with ``page_id`` and ``html`` keys (extra keys are
    allowed) or a ``(page_id, html)`` tuple. The HTML is parsed with
    :class:`~selectolax.lexbor.LexborHTMLParser` and the resulting document is
    passed to ``extractor``.

    A failure on one page -- broken markup that defeats the extractor, a
    selector that matches nothing and is then dereferenced, the extraction
    function raising, or it returning ``None`` -- is recorded on that page and
    never interrupts the other pages.

    Parameters
    ----------
    tasks:
        Iterable of task mappings or ``(page_id, html)`` pairs. Must not be
        empty.
    extractor:
        Callable taking a :class:`~selectolax.lexbor.LexborHTMLParser` and
        returning the page result. Returning ``None`` is treated as a failure.
    previous:
        A :class:`CrawlSummary` from an earlier run. Pages that succeeded in
        that summary are skipped: their HTML is not parsed and ``extractor``
        is not called for them. Previously failed pages and brand-new tasks
        are processed normally. Pages absent from ``tasks`` are not carried
        over.

    Returns
    -------
    CrawlSummary
        A fresh summary holding one :class:`PageResult` per task, reachable by
        page id, together with the :attr:`~CrawlSummary.skipped` count and the
        :attr:`~CrawlSummary.failed_page_ids` list. Pass it back as
        ``previous`` to rerun only the failures.

    Raises
    ------
    CrawlValidationError
        If ``tasks`` is empty or non-iterable, a task is missing its page id
        or HTML, page ids are duplicated, ``extractor`` is not callable, or
        ``previous`` is not a :class:`CrawlSummary`.
    """
    if not callable(extractor):
        raise CrawlValidationError(
            f"extractor must be callable, got {type(extractor).__name__}"
        )
    if previous is not None and not isinstance(previous, CrawlSummary):
        raise CrawlValidationError(
            f"previous must be a CrawlSummary instance, got {type(previous).__name__}"
        )

    normalized = _normalize_tasks(tasks)

    summary = CrawlSummary()
    previous_results = previous.results if previous is not None else {}

    for page_id, html in normalized:
        prior = previous_results.get(page_id)
        if prior is not None and prior.ok:
            # Already extracted successfully: do not parse or extract again.
            summary.results[page_id] = prior
            summary.skipped += 1
            continue

        summary.processed += 1
        try:
            tree = LexborHTMLParser(html)
            extracted = extractor(tree)
            if extracted is None:
                raise EmptyExtractionResultError(
                    f"extraction function returned None for page {page_id!r}"
                )
        except Exception as exc:  # noqa: BLE001 - any failure is a per-page outcome
            summary.results[page_id] = PageResult.failure(page_id, exc)
        else:
            summary.results[page_id] = PageResult.success(page_id, extracted)

    return summary
