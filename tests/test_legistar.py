"""Tests for Legistar year traversal, retries and pagination.

Every response is built locally and driven through an in-memory request queue, so
these tests never contact a real Legistar site.
"""

from collections import deque
from datetime import datetime
from urllib.parse import parse_qs

import pytest
import scrapy
from scrapy.http import HtmlResponse
from twisted.python.failure import Failure

from city_scrapers_core.spiders.legistar import (
    DEFAULT_LEGISTAR_MAX_RETRIES,
    LEGISTAR_YEAR_FAILED,
    LEGISTAR_YEAR_RETRY_SUCCESS,
    LEGISTAR_YEAR_SUCCESS,
    LegistarSpider,
)

START_URL = "https://example.legistar.com/Calendar.aspx"


class RecordingSpider(LegistarSpider):
    """Legistar spider that records parsed events instead of building meetings."""

    name = "fake_legistar"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.events = []

    def parse_legistar(self, events):
        self.events.extend(list(events))
        return iter(())


class FakeSettings:
    def __init__(self, values):
        self.values = values

    def getint(self, name, default=None):
        return int(self.values.get(name, default))

    def get(self, name, default=None):
        return self.values.get(name, default)


def make_page(viewstate="vs-root", events=(), next_target=None):
    """Render a minimal Legistar events page.

    ``events`` is a sequence of ``(name, ical_id)`` pairs, each rendered as a
    ``rgRow`` with a Name cell and an iCalendar cell.
    """
    rows = "".join(
        '<tr class="rgRow">'
        f'<td><a href="https://example.com/MeetingDetail.aspx?ID={ical_id}">'
        f"{name}</a></td>"
        f'<td><a href="https://example.com/View.ashx?M=IC&amp;ID={ical_id}">'
        "iCal</a></td>"
        "</tr>"
        for name, ical_id in events
    )
    pager = ""
    if next_target is not None:
        pager = (
            '<div class="rgPager">'
            '<a class="rgCurrentPage">1</a>'
            f"<a href=\"javascript:__doPostBack('{next_target}','')\">2</a>"
            "</div>"
        )
    return (
        "<html><body>"
        f'<input type="hidden" name="__VIEWSTATE" value="{viewstate}" />'
        f'<input type="hidden" name="__EVENTVALIDATION" value="ev-{viewstate}" />'
        '<table class="rgMasterTable"><thead><tr>'
        '<th class="rgHeader">Name</th>'
        '<th class="rgHeader"><img alt="ics" src="ical.png" /></th>'
        "</tr></thead><tbody>"
        f"{rows}</tbody></table>"
        f"{pager}"
        "</body></html>"
    )


BROKEN_PAGE = '<html><body><input type="hidden" name="__VIEWSTATE" value="vs-root" /></body></html>'  # noqa: E501


def make_response(request, body):
    return HtmlResponse(
        url=request.url, body=body.encode("utf-8"), encoding="utf-8", request=request
    )


def make_failure(request, message="boom"):
    failure = Failure(Exception(message))
    failure.request = request
    return failure


def request_viewstate(request):
    if not request.body:
        return None
    values = parse_qs(request.body.decode("utf-8")).get("__VIEWSTATE")
    return values[0] if values else None


def run_queue(spider, root_response, responder, max_steps=500):
    """Drive spider output through an in-memory queue.

    ``responder(request)`` returns either a response body or a ``Failure``.
    """
    queue = deque()
    errors = []

    def enqueue(output):
        if output is None:
            return
        for result in output:
            if isinstance(result, scrapy.Request):
                queue.append(result)

    def process(request):
        try:
            result = responder(request)
            if isinstance(result, Failure):
                output = request.errback(result)
            else:
                output = request.callback(make_response(request, result))
            enqueue(list(output) if output is not None else None)
        except Exception as exc:  # pragma: no cover - would surface callback bugs
            errors.append(exc)

    enqueue(list(spider.parse(root_response)))

    steps = 0
    while queue:
        steps += 1
        if steps > max_steps:  # pragma: no cover - guards against runaway loops
            raise AssertionError("request queue did not drain")
        process(queue.popleft())

    return errors


@pytest.fixture
def root_request():
    return scrapy.Request(
        START_URL,
        method="POST",
        body="__VIEWSTATE=vs-root",
        dont_filter=True,
        meta={},
    )


@pytest.fixture
def root_response(root_request):
    return make_response(root_request, make_page("vs-root"))


def test_default_retry_count():
    spider = RecordingSpider(name="fake_legistar", start_urls=[START_URL])
    assert DEFAULT_LEGISTAR_MAX_RETRIES == 3
    assert spider.legistar_max_retries_value() == DEFAULT_LEGISTAR_MAX_RETRIES
    # Nothing is recorded until the crawl actually runs.
    assert spider.legistar_year_outcomes == {}


def test_retry_count_from_spider_attribute():
    class TwoRetrySpider(RecordingSpider):
        legistar_max_retries = 2

    spider = TwoRetrySpider(name="fake_legistar", start_urls=[START_URL])
    assert spider.legistar_max_retries_value() == 2

    spider = RecordingSpider(
        name="fake_legistar", start_urls=[START_URL], legistar_max_retries="4"
    )
    assert spider.legistar_max_retries_value() == 4


def test_retry_count_from_settings():
    spider = RecordingSpider(name="fake_legistar", start_urls=[START_URL])
    spider.settings = FakeSettings({"LEGISTAR_MAX_RETRIES": 5})
    assert spider.legistar_max_retries_value() == 5

    # An explicit spider attribute wins over the setting.
    spider.legistar_max_retries = 1
    assert spider.legistar_max_retries_value() == 1

    # Invalid values fall back to the default instead of raising.
    spider.legistar_max_retries = "not-a-number"
    assert spider.legistar_max_retries_value() == DEFAULT_LEGISTAR_MAX_RETRIES


def test_parse_requests_one_per_year(root_response):
    spider = RecordingSpider(
        name="fake_legistar", start_urls=[START_URL], since_year=2018
    )
    requests = list(spider.parse(root_response))
    expected_years = list(range(2018, datetime.now().year + 1))
    assert [request.meta["legistar_year"] for request in requests] == expected_years
    for request in requests:
        assert request.method == "POST"
        assert request.meta["legistar_attempt"] == 1
        assert request.url == START_URL


def test_multi_page_walk_to_last_page(root_response):
    """Each year's pager is followed until there is no next link."""
    spider = RecordingSpider(name="fake_legistar", start_urls=[START_URL])
    pages = {
        2025: [
            make_page("vs-2025-1", [("A", 1)], next_target="gv$Page2"),
            make_page("vs-2025-2", [("B", 2)], next_target="gv$Page3"),
            make_page("vs-2025-3", [("C", 3)]),
        ],
        2026: [make_page("vs-2026-1", [("D", 4)])],
    }

    def responder(request):
        year = request.meta["legistar_year"]
        viewstate = request_viewstate(request)
        index = 0 if viewstate == "vs-root" else int(viewstate.rsplit("-", 1)[1])
        return pages[year][index]

    errors = run_queue(spider, root_response, responder)

    assert errors == []
    assert sorted(event["Name"]["label"] for event in spider.events) == [
        "A",
        "B",
        "C",
        "D",
    ]
    assert spider.legistar_year_outcomes == {
        2025: LEGISTAR_YEAR_SUCCESS,
        2026: LEGISTAR_YEAR_SUCCESS,
    }
    assert spider.legistar_failed_pages == []


def test_next_page_carries_body_secrets_and_event_target():
    spider = RecordingSpider(name="fake_legistar", start_urls=[START_URL])
    request = scrapy.Request(
        START_URL,
        method="POST",
        body="__VIEWSTATE=vs-2025-1&__EVENTTARGET=year&Extra=keep",
        dont_filter=True,
        meta={"legistar_year": 2025, "legistar_attempt": 1},
    )
    response = make_response(
        request, make_page("vs-2025-1", [("A", 1)], next_target="gv$Page2")
    )

    requests = list(spider._parse_next_page(response))

    assert len(requests) == 1
    next_request = requests[0]
    assert next_request.method == "POST"
    assert next_request.meta["legistar_year"] == 2025
    body = parse_qs(next_request.body.decode("utf-8"))
    assert body["__VIEWSTATE"] == ["vs-2025-1"]
    assert body["__EVENTVALIDATION"] == ["ev-vs-2025-1"]
    assert body["__EVENTTARGET"] == ["gv$Page2"]
    # Original body parameters are carried over as well (values keep the same
    # urlencoding the pre-existing pagination code used).
    assert "keep" in body["Extra"][0]


def test_next_page_absent_ends_pagination():
    spider = RecordingSpider(name="fake_legistar", start_urls=[START_URL])
    request = scrapy.Request(
        START_URL,
        method="POST",
        body="__VIEWSTATE=vs-1",
        dont_filter=True,
        meta={"legistar_year": 2026, "legistar_attempt": 1},
    )
    response = make_response(request, make_page("vs-2026-1", [("A", 1)]))
    assert list(spider._parse_next_page(response)) == []


def test_year_retry_succeeds_without_affecting_other_years(root_response):
    spider = RecordingSpider(
        name="fake_legistar", start_urls=[START_URL], since_year=2025
    )
    attempts = {}

    def responder(request):
        year = request.meta["legistar_year"]
        attempts[year] = attempts.get(year, 0) + 1
        if year == 2026 and attempts[year] == 1:
            return make_failure(request, "transient error")
        return make_page(f"vs-{year}-1", [(f"Meeting {year}", year)])

    errors = run_queue(spider, root_response, responder)

    assert errors == []
    assert attempts == {2025: 1, 2026: 2}
    assert spider.legistar_year_outcomes == {
        2025: LEGISTAR_YEAR_SUCCESS,
        2026: LEGISTAR_YEAR_RETRY_SUCCESS,
    }
    assert sorted(event["Name"]["label"] for event in spider.events) == [
        "Meeting 2025",
        "Meeting 2026",
    ]


def test_year_retries_exhausted_other_years_still_requested(root_response):
    spider = RecordingSpider(
        name="fake_legistar",
        start_urls=[START_URL],
        since_year=2024,
        legistar_max_retries=1,
    )
    attempts = {}

    def responder(request):
        year = request.meta["legistar_year"]
        attempts[year] = attempts.get(year, 0) + 1
        if year == 2025:
            return make_failure(request, "year failed")
        return make_page(f"vs-{year}-1", [(f"Meeting {year}", year)])

    errors = run_queue(spider, root_response, responder)

    assert errors == []
    # 2025 was tried twice (initial + one retry); 2024 and 2026 still ran once.
    assert attempts == {2024: 1, 2025: 2, 2026: 1}
    assert spider.legistar_year_outcomes == {
        2024: LEGISTAR_YEAR_SUCCESS,
        2025: LEGISTAR_YEAR_FAILED,
        2026: LEGISTAR_YEAR_SUCCESS,
    }
    assert sorted(event["Name"]["label"] for event in spider.events) == [
        "Meeting 2024",
        "Meeting 2026",
    ]

    summary = spider.legistar_year_summary()
    assert "3 year(s) total" in summary
    assert "2 succeeded" in summary
    assert "1 failed" in summary
    assert "failed years: 2025" in summary


def test_retries_use_default_when_unconfigured(root_response):
    spider = RecordingSpider(
        name="fake_legistar", start_urls=[START_URL], since_year=2026
    )
    attempts = {}

    def responder(request):
        year = request.meta["legistar_year"]
        attempts[year] = attempts.get(year, 0) + 1
        return make_failure(request, "always failing")

    run_queue(spider, root_response, responder)

    assert attempts == {2026: DEFAULT_LEGISTAR_MAX_RETRIES + 1}
    assert spider.legistar_year_outcomes == {2026: LEGISTAR_YEAR_FAILED}


def test_missing_event_table_skipped_and_counted(root_response):
    spider = RecordingSpider(
        name="fake_legistar", start_urls=[START_URL], since_year=2025
    )

    def responder(request):
        year = request.meta["legistar_year"]
        if year == 2025:
            return BROKEN_PAGE
        return make_page(f"vs-{year}-1", [(f"Meeting {year}", year)])

    errors = run_queue(spider, root_response, responder)

    assert errors == []  # no uncaught exception
    assert spider.legistar_year_outcomes == {
        2025: LEGISTAR_YEAR_FAILED,
        2026: LEGISTAR_YEAR_SUCCESS,
    }
    assert len(spider.legistar_failed_pages) == 1
    failed_page = spider.legistar_failed_pages[0]
    assert failed_page["year"] == 2025
    assert "rgMasterTable" in failed_page["reason"]
    # Meetings from the healthy year are still delivered to parse_legistar.
    assert [event["Name"]["label"] for event in spider.events] == ["Meeting 2026"]


def test_malformed_row_does_not_drop_other_events(root_response):
    spider = RecordingSpider(
        name="fake_legistar", start_urls=[START_URL], since_year=2026
    )
    page = make_page("vs-2026-1", [("Good", 1)]).replace(
        "</tbody>",
        '<tr class="rgRow"><td><a href="#">Broken</a></td></tr></tbody>',
    )

    errors = run_queue(spider, root_response, lambda request: page)

    assert errors == []
    assert [event["Name"]["label"] for event in spider.events] == ["Good"]


def test_summary_reports_retry_and_failed_years():
    spider = RecordingSpider(
        name="fake_legistar", start_urls=[START_URL], since_year=2024
    )
    spider.legistar_year_outcomes = {
        2024: LEGISTAR_YEAR_SUCCESS,
        2025: LEGISTAR_YEAR_RETRY_SUCCESS,
        2026: LEGISTAR_YEAR_FAILED,
    }

    summary = spider.legistar_year_summary()

    assert "3 year(s) total" in summary
    assert "2 succeeded" in summary
    assert "after retry: 2025" in summary
    assert "1 failed" in summary
    assert "failed years: 2026" in summary


def test_closed_logs_summary(caplog):
    spider = RecordingSpider(
        name="fake_legistar", start_urls=[START_URL], since_year=2025
    )
    spider.legistar_year_outcomes = {
        2025: LEGISTAR_YEAR_SUCCESS,
        2026: LEGISTAR_YEAR_FAILED,
    }

    with caplog.at_level("INFO"):
        spider.closed("finished")

    assert "Legistar year summary" in caplog.text
    assert "2 year(s) total" in caplog.text
    assert "failed years: 2026" in caplog.text
