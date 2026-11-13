import pytest

from selectolax.crawl import (
    CrawlSummary,
    CrawlValidationError,
    EmptyExtractionResultError,
    PageStatus,
    crawl_pages,
)
from selectolax.lexbor import LexborHTMLParser


def extract_title(tree: LexborHTMLParser) -> str:
    heading = tree.css_first("h1")
    assert heading is not None
    return heading.text(strip=True)


def test_normal_path_dict_tasks():
    tasks = [
        {"page_id": "home", "html": "<html><body><h1>Home page</h1></body></html>"},
        {"page_id": "about", "html": "<h1>About us</h1>"},
    ]

    summary = crawl_pages(tasks, extract_title)

    assert isinstance(summary, CrawlSummary)
    assert summary.processed == 2
    assert summary.skipped == 0
    assert summary.total == 2
    assert summary.failed_page_ids == []
    assert summary.successful_page_ids == ["home", "about"]
    assert summary.failed_count == 0
    assert summary.succeeded_count == 2

    home = summary["home"]
    assert home.status is PageStatus.SUCCESS
    assert home.ok
    assert home.result == "Home page"
    assert home.error_type is None
    assert home.error_message is None
    assert summary["about"].result == "About us"

    # The summary supports membership and iteration by page id.
    assert "home" in summary
    assert "missing" not in summary
    assert list(summary) == ["home", "about"]


def test_tuple_tasks_and_bytes_html_are_accepted():
    summary = crawl_pages(
        [("one", b"<h1>Bytes title</h1>"), ("two", "<h1>Str title</h1>")],
        extract_title,
    )

    assert summary.failed_page_ids == []
    assert summary["one"].result == "Bytes title"
    assert summary["two"].result == "Str title"


def test_single_page_failure_does_not_stop_the_others():
    calls = []

    def extractor(tree):
        heading = tree.css_first("h1")
        # Raises AttributeError on the page that has no <h1>.
        title = heading.text(strip=True)
        calls.append(title)
        return title

    tasks = [
        {"page_id": "good-1", "html": "<h1>First</h1>"},
        {"page_id": "broken", "html": "<div>no heading here</div>"},
        {"page_id": "good-2", "html": "<h1>Second</h1>"},
    ]

    summary = crawl_pages(tasks, extractor)

    # Both healthy pages were still extracted.
    assert calls == ["First", "Second"]
    assert summary["good-1"].ok
    assert summary["good-2"].ok
    assert summary["good-1"].result == "First"
    assert summary["good-2"].result == "Second"

    broken = summary["broken"]
    assert broken.status is PageStatus.FAILED
    assert not broken.ok
    assert broken.result is None
    assert broken.error_type == "AttributeError"
    assert broken.error_message  # the failure message is preserved
    assert summary.failed_page_ids == ["broken"]
    assert summary.failures == [broken]
    assert summary.failed_count == 1
    assert summary.succeeded_count == 2


def test_extraction_exception_message_is_recorded():
    class MyBoom(Exception):
        pass

    def boom(tree):
        raise MyBoom("selector exploded")

    summary = crawl_pages([{"page_id": "p", "html": "<p>x</p>"}], boom)

    result = summary["p"]
    assert not result.ok
    assert result.error_type == "MyBoom"
    assert result.error_message == "selector exploded"


def test_returning_none_is_recorded_as_failure_not_silently_ignored():
    summary = crawl_pages(
        [{"page_id": "empty", "html": "<div>nothing</div>"}],
        lambda tree: tree.css_first("h1") and tree.css_first("h1").text(),
    )

    result = summary["empty"]
    assert result.status is PageStatus.FAILED
    assert result.error_type == EmptyExtractionResultError.__name__
    assert "None" in result.error_message
    assert summary.failed_page_ids == ["empty"]


def test_malformed_html_does_not_break_the_batch():
    # Lexbor is forgiving, so broken markup still parses; the damage shows up
    # as a missing element that the extractor requires. That page fails on its
    # own while the well-formed neighbour keeps working.
    def extract_article(tree):
        heading = tree.css_first(".article h2")
        if heading is None:
            raise AttributeError("'.article h2' did not match any node")
        return heading.text(strip=True)

    summary = crawl_pages(
        [
            {"page_id": "truncated", "html": "<div class='article'><p>cut off"},
            {"page_id": "fine", "html": "<div class='article'><h2>Fine</h2></div>"},
        ],
        extract_article,
    )

    assert summary["fine"].result == "Fine"
    assert summary.successful_page_ids == ["fine"]
    assert summary.failed_page_ids == ["truncated"]
    assert summary["truncated"].error_type == "AttributeError"


def test_resume_skips_successful_pages_and_reruns_failures():
    tasks = [
        {"page_id": "ok-1", "html": "<h1>One</h1>"},
        {"page_id": "flaky", "html": "<div>missing heading</div>"},
        {"page_id": "ok-2", "html": "<h1>Two</h1>"},
    ]

    first = crawl_pages(tasks, extract_title)
    assert first.processed == 3
    assert first.skipped == 0
    assert first.failed_page_ids == ["flaky"]

    extracted_ids = []

    def counting_extractor(tree):
        result = extract_title(tree)
        extracted_ids.append(result)
        return result

    # Same batch, previous summary attached: successes must not be re-extracted.
    second = crawl_pages(tasks, counting_extractor, previous=first)

    assert extracted_ids == []  # the only failed page still fails, no success rerun
    assert second.skipped == 2
    assert second.processed == 1
    assert second["ok-1"].ok and second["ok-2"].ok
    assert second["ok-1"].result == "One"
    assert second["ok-2"].result == "Two"
    assert second.failed_page_ids == ["flaky"]

    # Repair the failing page and rerun with the previous summary again.
    repaired = [
        {"page_id": "ok-1", "html": "<h1>One</h1>"},
        {"page_id": "flaky", "html": "<h1>Now fixed</h1>"},
        {"page_id": "ok-2", "html": "<h1>Two</h1>"},
    ]
    third = crawl_pages(repaired, counting_extractor, previous=second)

    assert extracted_ids == ["Now fixed"]  # only the repaired page ran
    assert third.skipped == 2
    assert third.processed == 1
    assert third.failed_page_ids == []
    assert third["flaky"].result == "Now fixed"
    assert third.successful_page_ids == ["ok-1", "flaky", "ok-2"]


def test_resume_processes_new_tasks_and_drops_vanished_ones():
    first = crawl_pages([{"page_id": "old", "html": "<h1>Old</h1>"}], extract_title)

    second = crawl_pages(
        [
            {"page_id": "old", "html": "<h1>Old</h1>"},
            {"page_id": "new", "html": "<h1>New</h1>"},
        ],
        extract_title,
        previous=first,
    )

    assert second.skipped == 1
    assert second.processed == 1
    assert second["old"].result == "Old"
    assert second["new"].result == "New"

    # A page that disappeared from the task list is not carried over.
    third = crawl_pages(
        [{"page_id": "new", "html": "<h1>New</h1>"}], extract_title, previous=second
    )
    assert "old" not in third
    assert third.skipped == 1
    assert third.processed == 0


def test_empty_task_sequence_is_rejected():
    with pytest.raises(CrawlValidationError, match="at least one page"):
        crawl_pages([], extract_title)


def test_task_missing_page_id_is_rejected():
    with pytest.raises(CrawlValidationError, match="page_id"):
        crawl_pages([{"html": "<h1>x</h1>"}], extract_title)

    with pytest.raises(CrawlValidationError, match="page_id"):
        crawl_pages([{"page_id": None, "html": "<h1>x</h1>"}], extract_title)


def test_task_missing_html_is_rejected():
    with pytest.raises(CrawlValidationError, match="html"):
        crawl_pages([{"page_id": "p"}], extract_title)


def test_malformed_task_objects_are_rejected():
    with pytest.raises(CrawlValidationError):
        crawl_pages(["not-a-task"], extract_title)

    with pytest.raises(CrawlValidationError):
        crawl_pages([("only-one-element",)], extract_title)

    with pytest.raises(CrawlValidationError):
        crawl_pages([{"page_id": "p", "html": 123}], extract_title)


def test_duplicate_page_ids_are_rejected():
    with pytest.raises(CrawlValidationError, match="duplicate"):
        crawl_pages(
            [
                {"page_id": "p", "html": "<h1>a</h1>"},
                {"page_id": "p", "html": "<h1>b</h1>"},
            ],
            extract_title,
        )


def test_non_iterable_tasks_and_bad_arguments_are_rejected():
    with pytest.raises(CrawlValidationError):
        crawl_pages("not-an-iterable-of-tasks", extract_title)

    with pytest.raises(CrawlValidationError):
        crawl_pages([{"page_id": "p", "html": "<h1>x</h1>"}], extractor="nope")

    with pytest.raises(CrawlValidationError):
        crawl_pages(
            [{"page_id": "p", "html": "<h1>x</h1>"}],
            extract_title,
            previous={"not": "a summary"},
        )
