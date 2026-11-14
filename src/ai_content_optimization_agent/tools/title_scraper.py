"""Title scraping executor for the existing content-optimization agent chain.

This module replaces the implicit "call the web unlocker and hope for an
``<h1>``" flow with an explicit, observable execution step:

* the page Markdown is fetched through the Bright Data web unlocker tool;
* the title is extracted from the first ``<h1>`` tag, falling back to an
  inference from the page body when no heading is present;
* every attempt (number, outcome and short reason) is recorded and logged;
* the result is always returned as a structured :class:`TitleScrapeResult`.

Retry rules::

    * a *scrape error* is retried up to :data:`MAX_SCRAPE_RETRIES` times
      (i.e. at most 4 attempts in total);
    * *empty content* and *no title* are never retried;
    * when every attempt fails the final status is ``scrape_error`` with an
      empty title.

The module is importable without any Bright Data credentials or network
access: the unlocker is only instantiated lazily by the default fetcher, and
a custom fetcher can be injected (which is what the tests rely on).
"""

from __future__ import annotations

import html
import inspect
import logging
import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Optional

from pydantic import BaseModel, Field as PydanticField

from crewai.tools import BaseTool

logger = logging.getLogger(__name__)

#: Maximum number of *retries* performed after the initial attempt when the
#: unlocker raises an exception. The total number of attempts is therefore
#: ``1 + MAX_SCRAPE_RETRIES``.
MAX_SCRAPE_RETRIES = 3

#: Maximum length kept for a short reason / exception message.
_MAX_REASON_LENGTH = 200

#: Matches an ``<h1>...</h1>`` heading, including attributes and newlines.
_H1_PATTERN = re.compile(r"<h1\b[^>]*>(.*?)</h1>", re.IGNORECASE | re.DOTALL)

#: Matches an ATX Markdown heading (``# Title``). Whitespace is restricted to
#: non-newline characters so a bare ``#`` line cannot swallow following lines.
_MD_H1_PATTERN = re.compile(r"^[ \t]{0,3}#[ \t]+(.+?)[ \t]*#*[ \t]*$", re.MULTILINE)

#: Matches an underline-style Setext Markdown level-1 heading.
_SETEXT_H1_PATTERN = re.compile(r"^([^\n]+?)[ \t]*\n=+[ \t]*$", re.MULTILINE)

#: Removes a Markdown image, keeping nothing (images carry no title text).
_MD_IMAGE_PATTERN = re.compile(r"!\[[^\]]*\]\([^)]*\)")

#: Removes the wrapper of a Markdown link, keeping its label.
_MD_LINK_PATTERN = re.compile(r"\[([^\]]*)\]\([^)]*\)")

#: Strips any remaining HTML tag.
_HTML_TAG_PATTERN = re.compile(r"<[^>]+>")

#: A line made solely of Markdown decoration / punctuation.
_DECORATION_ONLY_PATTERN = re.compile(r"^[\s\-_*=#>:|`~]+$")

#: A line is only considered inferable when it contains an alphanumeric or
#: word character (covers CJK / accented characters as well).
_INFERABLE_PATTERN = re.compile(r"\w", re.UNICODE)


class ScrapeStatus(str, Enum):
    """Final status of a title-scraping run."""

    SUCCESS = "success"
    NO_TITLE = "no_title"
    EMPTY_CONTENT = "empty_content"
    SCRAPE_ERROR = "scrape_error"


class AttemptOutcome(str, Enum):
    """Outcome of a single scraping attempt."""

    SUCCESS = "success"
    NO_TITLE = "no_title"
    EMPTY_CONTENT = "empty_content"
    SCRAPE_ERROR = "scrape_error"


@dataclass(frozen=True)
class AttemptRecord:
    """One recorded attempt of the scraping loop."""

    attempt_number: int
    outcome: AttemptOutcome
    reason: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "attempt_number": self.attempt_number,
            "outcome": self.outcome.value,
            "reason": self.reason,
        }


@dataclass
class TitleScrapeResult:
    """Structured result returned for every scraping run."""

    url: str
    status: ScrapeStatus
    title: Optional[str]
    attempts: list[AttemptRecord] = field(default_factory=list)

    @property
    def attempt_count(self) -> int:
        """Number of attempts actually performed."""
        return len(self.attempts)

    @property
    def success(self) -> bool:
        return self.status is ScrapeStatus.SUCCESS

    def to_dict(self) -> dict[str, Any]:
        return {
            "url": self.url,
            "status": self.status.value,
            "title": self.title,
            "attempt_count": self.attempt_count,
            "attempts": [record.to_dict() for record in self.attempts],
        }


class TitleScrapeError(Exception):
    """Raised when no title could be produced for the given URL.

    The error always carries the target URL and the number of attempts that
    were made, so callers can decide whether to abort the whole pipeline.
    """

    def __init__(self, url: str, attempt_count: int, message: Optional[str] = None):
        self.url = url
        self.attempt_count = attempt_count
        if message is None:
            message = (
                f"Failed to scrape a title for URL '{url}' after "
                f"{attempt_count} attempt(s)."
            )
        super().__init__(message)


def _short_reason(text: str) -> str:
    """Collapse an arbitrary message into a single short reason line."""
    reason = " ".join(str(text).split())
    if len(reason) > _MAX_REASON_LENGTH:
        reason = reason[: _MAX_REASON_LENGTH - 3] + "..."
    return reason


def _exception_reason(error: BaseException) -> str:
    return _short_reason(f"{type(error).__name__}: {error}")


def _clean_title(raw: str) -> str:
    """Normalize a candidate title into a plain single-line string."""
    text = _MD_IMAGE_PATTERN.sub("", raw)
    text = _MD_LINK_PATTERN.sub(r"\1", text)
    text = _HTML_TAG_PATTERN.sub("", text)
    text = html.unescape(text)
    return " ".join(text.split()).strip()


def extract_title(content: str) -> Optional[str]:
    """Extract a title from page Markdown.

    The first non-empty ``<h1>`` tag wins; Markdown level-1 headings are
    accepted as well. When no usable heading exists, a title is inferred from
    the first meaningful body line. ``None`` is returned when the content
    contains nothing a title could be derived from.
    """
    if not content or not content.strip():
        return None

    # 1. Explicit <h1> tag (the primary contract of the existing flow).
    for match in _H1_PATTERN.finditer(content):
        title = _clean_title(match.group(1))
        if title:
            return title

    # 2. Markdown ATX heading: "# Title".
    for match in _MD_H1_PATTERN.finditer(content):
        title = _clean_title(match.group(1))
        if title:
            return title

    # 3. Markdown Setext heading: "Title\n=====".
    for match in _SETEXT_H1_PATTERN.finditer(content):
        title = _clean_title(match.group(1))
        if title:
            return title

    # 4. Fallback: infer a title from the first meaningful body line.
    for line in content.splitlines():
        stripped = line.strip()
        if not stripped or _DECORATION_ONLY_PATTERN.match(stripped):
            continue
        candidate = _clean_title(stripped)
        if (
            candidate
            and not _DECORATION_ONLY_PATTERN.match(candidate)
            and _INFERABLE_PATTERN.search(candidate)
        ):
            return candidate

    return None


def _normalize_content(raw: Any) -> str:
    """Normalize whatever the unlocker returned into a Markdown string."""
    if raw is None:
        return ""
    if isinstance(raw, bytes):
        return raw.decode("utf-8", errors="replace")
    return str(raw)


def build_default_unlocker() -> Any:
    """Instantiate the Bright Data web unlocker tool.

    The import is lazy so that this module (and its tests) can be loaded in
    environments where ``BrightDataWebUnlockerTool`` or its credentials are
    not available.
    """
    try:
        from crewai_tools import BrightDataWebUnlockerTool
    except ImportError as exc:  # pragma: no cover - depends on installed package
        raise ImportError(
            "BrightDataWebUnlockerTool is required to fetch web pages but is "
            "not available in the installed crewai_tools package. Install a "
            "crewai_tools release that ships the Bright Data tools, or inject "
            "a custom fetcher into TitleScraperExecutor."
        ) from exc

    return BrightDataWebUnlockerTool()


def make_unlocker_fetcher(unlocker: Optional[Any] = None) -> Callable[[str], str]:
    """Build a fetcher backed by a Bright Data web unlocker tool.

    When ``unlocker`` is omitted it is instantiated lazily on the first call,
    so merely importing this module (or constructing :class:`TitleScraperTool`)
    never requires the Bright Data package or its credentials.

    Different crewai_tools releases expose slightly different calling
    conventions, so both ``tool.run(url, ...)``/``tool._run(url, ...)`` and
    direct ``tool(url)`` calls are supported.
    """
    state: dict[str, Any] = {"unlocker": unlocker}

    def fetch(url: str) -> str:
        tool = state["unlocker"]
        if tool is None:
            tool = build_default_unlocker()
            state["unlocker"] = tool

        if hasattr(tool, "run") and callable(tool.run):
            target = tool.run
        elif hasattr(tool, "_run") and callable(tool._run):
            target = tool._run
        else:
            target = tool

        try:
            parameters = inspect.signature(target).parameters
        except (TypeError, ValueError):
            parameters = {}

        kwargs: dict[str, Any] = {}
        if "scrape_format" in parameters:
            kwargs["scrape_format"] = "markdown"
        elif "format" in parameters:
            kwargs["format"] = "markdown"

        return _normalize_content(target(url, **kwargs))

    return fetch


#: A fetcher receives a URL and returns the page content as Markdown.
ContentFetcher = Callable[[str], str]


class TitleScraperExecutor:
    """Fetch a page and extract its title with retries and full traceability."""

    def __init__(
        self,
        fetcher: Optional[ContentFetcher] = None,
        max_retries: int = MAX_SCRAPE_RETRIES,
    ):
        self.fetcher: ContentFetcher = (
            fetcher if fetcher is not None else make_unlocker_fetcher()
        )
        self.max_retries = max_retries

    def scrape(self, url: str) -> TitleScrapeResult:
        """Run the scrape-and-extract loop for ``url``."""
        attempts: list[AttemptRecord] = []
        max_attempts = self.max_retries + 1

        for attempt_number in range(1, max_attempts + 1):
            logger.info("Title scrape attempt %s/%s for %s", attempt_number, max_attempts, url)
            try:
                content = self.fetcher(url)
            except Exception as error:  # noqa: BLE001 - every failure is recorded
                reason = _exception_reason(error)
                attempts.append(
                    AttemptRecord(attempt_number, AttemptOutcome.SCRAPE_ERROR, reason)
                )
                logger.warning(
                    "Title scrape attempt %s for %s failed: %s",
                    attempt_number,
                    url,
                    reason,
                )
                continue

            content = _normalize_content(content)
            if not content.strip():
                reason = "The web unlocker returned empty content."
                attempts.append(
                    AttemptRecord(attempt_number, AttemptOutcome.EMPTY_CONTENT, reason)
                )
                logger.warning("Title scrape for %s ended with empty content", url)
                return TitleScrapeResult(url, ScrapeStatus.EMPTY_CONTENT, None, attempts)

            title = extract_title(content)
            if not title:
                reason = "No <h1> heading or inferable title found in the content."
                attempts.append(
                    AttemptRecord(attempt_number, AttemptOutcome.NO_TITLE, reason)
                )
                logger.warning("Title scrape for %s could not find a title", url)
                return TitleScrapeResult(url, ScrapeStatus.NO_TITLE, None, attempts)

            reason = "Title extracted successfully."
            attempts.append(
                AttemptRecord(attempt_number, AttemptOutcome.SUCCESS, reason)
            )
            logger.info("Title scrape for %s succeeded: %s", url, title)
            return TitleScrapeResult(url, ScrapeStatus.SUCCESS, title, attempts)

        logger.error(
            "Title scrape for %s failed after %s attempts", url, len(attempts)
        )
        return TitleScrapeResult(url, ScrapeStatus.SCRAPE_ERROR, None, attempts)


def scrape_title(
    url: str,
    fetcher: Optional[ContentFetcher] = None,
    max_retries: int = MAX_SCRAPE_RETRIES,
) -> TitleScrapeResult:
    """Convenience wrapper around :class:`TitleScraperExecutor`."""
    return TitleScraperExecutor(fetcher=fetcher, max_retries=max_retries).scrape(url)


class TitleScraperToolInput(BaseModel):
    """Arguments exposed to the CrewAI agent."""

    url: str = PydanticField(description="The URL of the web page to scrape.")


class TitleScraperTool(BaseTool):
    """CrewAI tool wrapping the title-scraping executor.

    On success the tool returns the plain-text title, which keeps the
    downstream search task contract unchanged. On failure it raises
    :class:`TitleScrapeError` carrying the URL and attempt count, so an empty
    string or a raw exception is never handed to the search task.
    """

    name: str = "Title Scraper"
    description: str = (
        "Fetch a web page with the Bright Data web unlocker (Markdown format), "
        "extract the text of its <h1> tag (inferring a title from the body when "
        "no <h1> exists), and return the plain-text title. Retries transient "
        "scraping errors and records every attempt."
    )
    args_schema: type[BaseModel] = TitleScraperToolInput
    result_as_answer: bool = True
    executor: Any = None

    def __init__(
        self,
        executor: Optional[TitleScraperExecutor] = None,
        fetcher: Optional[ContentFetcher] = None,
        max_retries: int = MAX_SCRAPE_RETRIES,
        **data: Any,
    ) -> None:
        active_executor = executor or TitleScraperExecutor(
            fetcher=fetcher, max_retries=max_retries
        )
        super().__init__(executor=active_executor, **data)

    def _run(self, url: str) -> str:
        result = self.executor.scrape(url)
        if result.success and result.title:
            return result.title

        raise TitleScrapeError(url=url, attempt_count=result.attempt_count)


__all__ = [
    "MAX_SCRAPE_RETRIES",
    "AttemptOutcome",
    "AttemptRecord",
    "ScrapeStatus",
    "TitleScrapeError",
    "TitleScrapeResult",
    "TitleScraperExecutor",
    "TitleScraperTool",
    "TitleScraperToolInput",
    "build_default_unlocker",
    "extract_title",
    "make_unlocker_fetcher",
    "scrape_title",
]
