"""Tests for the title scraping executor.

All tests use hand-written local Markdown samples and in-memory fake
fetchers: no real API key, no Bright Data account and no network access are
required.
"""

import pytest

from ai_content_optimization_agent.tools import (
    MAX_SCRAPE_RETRIES,
    AttemptOutcome,
    ScrapeStatus,
    TitleScrapeError,
    TitleScraperExecutor,
    TitleScraperTool,
    extract_title,
    make_unlocker_fetcher,
)

URL = "https://example.com/article"

# --- Local, self-contained page samples ------------------------------------

MARKDOWN_WITH_H1 = """
# Navigation menu

Some preamble text that is not the title.

<h1 id="main">  The Real &amp; Best Title  </h1>

Lorem ipsum dolor sit amet, consectetur adipiscing elit.
"""

MARKDOWN_WITHOUT_H1 = """
Some introductory paragraph for the article.

- A bullet point
- Another bullet point

A second paragraph that explains the topic in more detail.
"""

MARKDOWN_EMPTY = "   \n\t\n  \n"

MARKDOWN_DECORATION_ONLY = """
---

#
***

>
"""


class FakeFetcher:
    """Callable fetcher returning queued payloads or raising queued errors."""

    def __init__(self, responses):
        # Each response is either a string (returned as Markdown) or an
        # Exception instance (raised when the attempt runs).
        self._responses = list(responses)
        self.calls = []

    def __call__(self, url):
        self.calls.append(url)
        response = self._responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


# --- extract_title unit checks ---------------------------------------------

def test_extract_title_prefers_h1_tag():
    assert extract_title(MARKDOWN_WITH_H1) == "The Real & Best Title"


def test_extract_title_infers_from_body_without_h1():
    assert (
        extract_title(MARKDOWN_WITHOUT_H1)
        == "Some introductory paragraph for the article."
    )


def test_extract_title_returns_none_for_empty_or_decoration_only_content():
    assert extract_title(MARKDOWN_EMPTY) is None
    assert extract_title(MARKDOWN_DECORATION_ONLY) is None
    assert extract_title("") is None


# --- Executor: the four required paths -------------------------------------

def test_scrape_success_records_single_attempt_in_order():
    fetcher = FakeFetcher([MARKDOWN_WITH_H1])
    result = TitleScraperExecutor(fetcher=fetcher).scrape(URL)

    assert result.url == URL
    assert result.status is ScrapeStatus.SUCCESS
    assert result.title == "The Real & Best Title"
    assert result.attempt_count == 1
    assert len(fetcher.calls) == 1
    assert fetcher.calls == [URL]

    assert len(result.attempts) == 1
    record = result.attempts[0]
    assert record.attempt_number == 1
    assert record.outcome is AttemptOutcome.SUCCESS
    assert record.reason  # a short, non-empty reason is recorded

    # The serialized form exposes the same ordered data.
    serialized = result.to_dict()
    assert serialized["url"] == URL
    assert serialized["status"] == "success"
    assert serialized["title"] == "The Real & Best Title"
    assert serialized["attempt_count"] == 1
    assert [a["attempt_number"] for a in serialized["attempts"]] == [1]
    assert [a["outcome"] for a in serialized["attempts"]] == ["success"]


def test_scrape_no_title_does_not_retry():
    fetcher = FakeFetcher([MARKDOWN_DECORATION_ONLY])
    result = TitleScraperExecutor(fetcher=fetcher).scrape(URL)

    assert result.status is ScrapeStatus.NO_TITLE
    assert result.title is None
    assert result.attempt_count == 1
    assert len(fetcher.calls) == 1  # no retry on no-title

    [record] = result.attempts
    assert record.attempt_number == 1
    assert record.outcome is AttemptOutcome.NO_TITLE
    assert "title" in record.reason.lower()


def test_scrape_empty_content_does_not_retry():
    fetcher = FakeFetcher([MARKDOWN_EMPTY])
    result = TitleScraperExecutor(fetcher=fetcher).scrape(URL)

    assert result.status is ScrapeStatus.EMPTY_CONTENT
    assert result.title is None
    assert result.attempt_count == 1
    assert len(fetcher.calls) == 1  # no retry on empty content

    [record] = result.attempts
    assert record.attempt_number == 1
    assert record.outcome is AttemptOutcome.EMPTY_CONTENT
    assert "empty" in record.reason.lower()


def test_scrape_error_retries_until_exhausted():
    failures = [ConnectionError("network down") for _ in range(MAX_SCRAPE_RETRIES + 1)]
    fetcher = FakeFetcher(failures)
    result = TitleScraperExecutor(fetcher=fetcher).scrape(URL)

    # 1 initial attempt + MAX_SCRAPE_RETRIES retries.
    expected_attempts = MAX_SCRAPE_RETRIES + 1
    assert result.status is ScrapeStatus.SCRAPE_ERROR
    assert result.title is None
    assert result.attempt_count == expected_attempts
    assert len(fetcher.calls) == expected_attempts
    assert fetcher.calls == [URL] * expected_attempts

    assert len(result.attempts) == expected_attempts
    assert [r.attempt_number for r in result.attempts] == list(
        range(1, expected_attempts + 1)
    )
    assert all(r.outcome is AttemptOutcome.SCRAPE_ERROR for r in result.attempts)
    # The exception type and message survive as the short reason.
    assert all("ConnectionError" in r.reason for r in result.attempts)
    assert all("network down" in r.reason for r in result.attempts)


def test_scrape_recovers_after_transient_errors():
    fetcher = FakeFetcher(
        [
            TimeoutError("timed out"),
            ConnectionError("reset"),
            MARKDOWN_WITH_H1,
        ]
    )
    result = TitleScraperExecutor(fetcher=fetcher).scrape(URL)

    assert result.status is ScrapeStatus.SUCCESS
    assert result.title == "The Real & Best Title"
    assert result.attempt_count == 3
    assert [r.outcome for r in result.attempts] == [
        AttemptOutcome.SCRAPE_ERROR,
        AttemptOutcome.SCRAPE_ERROR,
        AttemptOutcome.SUCCESS,
    ]
    assert [r.attempt_number for r in result.attempts] == [1, 2, 3]


# --- CrewAI tool wrapper ----------------------------------------------------

def test_tool_returns_plain_text_title_on_success():
    fetcher = FakeFetcher([MARKDOWN_WITH_H1])
    tool = TitleScraperTool(fetcher=fetcher)

    assert tool.name == "Title Scraper"
    title = tool._run(URL)
    assert title == "The Real & Best Title"
    assert isinstance(title, str)


@pytest.mark.parametrize(
    "payload,expected_attempts",
    [
        (MARKDOWN_EMPTY, 1),
        (MARKDOWN_DECORATION_ONLY, 1),
    ],
)
def test_tool_raises_structured_error_without_passing_empty_string(payload, expected_attempts):
    fetcher = FakeFetcher([payload])
    tool = TitleScraperTool(fetcher=fetcher)

    with pytest.raises(TitleScrapeError) as exc_info:
        tool._run(URL)

    error = exc_info.value
    assert error.url == URL
    assert error.attempt_count == expected_attempts
    assert URL in str(error)


def test_tool_raises_structured_error_after_retry_exhaustion():
    failures = [RuntimeError("boom") for _ in range(MAX_SCRAPE_RETRIES + 1)]
    fetcher = FakeFetcher(failures)
    tool = TitleScraperTool(fetcher=fetcher)

    with pytest.raises(TitleScrapeError) as exc_info:
        tool._run(URL)

    error = exc_info.value
    assert error.url == URL
    assert error.attempt_count == MAX_SCRAPE_RETRIES + 1
    # The raw exception text must not leak into the downstream-facing message.
    assert "boom" not in str(error)


# --- Unlocker fetcher wiring (no network involved) --------------------------

class FakeUnlocker:
    def __init__(self):
        self.calls = []

    def run(self, url, scrape_format=None):
        self.calls.append((url, scrape_format))
        return f"<h1>{url}</h1>"


def test_make_unlocker_fetcher_requests_markdown_and_extracts_via_executor():
    unlocker = FakeUnlocker()
    fetcher = make_unlocker_fetcher(unlocker)
    result = TitleScraperExecutor(fetcher=fetcher).scrape(URL)

    assert result.status is ScrapeStatus.SUCCESS
    assert result.title == URL
    assert unlocker.calls == [(URL, "markdown")]
