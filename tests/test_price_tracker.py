"""Offline tests for web_scraping.price_tracker.tracker.

No real network access happens here: every transport is a fake request
callable returning fixed HTML or raising an exception, and the retry wait is
replaced by a recorder.
"""

import os
import sys

import pytest
import requests

current_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.join(current_dir, "..")
sys.path.insert(0, project_root)

from web_scraping.price_tracker.tracker import (  # noqa: E402
    OUTCOME_ELEMENT_NOT_FOUND,
    OUTCOME_HTTP_ERROR,
    OUTCOME_NETWORK_ERROR,
    OUTCOME_PARSE_ERROR,
    OUTCOME_SUCCESS,
    WebScraper,
    get_web_data,
)


class FakeResponse:
    """Minimal stand-in for a requests.Response: only status_code/content."""

    def __init__(self, status_code, content):
        self.status_code = status_code
        self.content = content


def make_fake_request(scripted):
    """Build a fake request function from a list of scripted outcomes.

    Each entry is either a FakeResponse (returned) or an Exception instance
    (raised). Entries are consumed in order, one per attempt.
    """
    calls = []
    remaining = list(scripted)

    def fake_request(url, headers=None):
        calls.append({"url": url, "headers": headers})
        outcome = remaining.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    fake_request.calls = calls
    return fake_request


def make_scraper(scripted, max_attempts=3):
    """Scraper wired to a fake transport and a wait that never really sleeps."""
    fake_request = make_fake_request(scripted)
    waits = []
    scraper = WebScraper(
        request_func=fake_request,
        wait_func=waits.append,
        max_attempts=max_attempts,
        retry_delay=0.0,
    )
    return scraper, fake_request, waits


VALID_HTML = b"""
<html>
  <body>
    <h1 id="firstHeading">  Python (programming language)  </h1>
    <p>Some price info</p>
  </body>
</html>
"""


# ---------------------------------------------------------------------------
# 1. Happy path: target text is found and trimmed on the first attempt
# ---------------------------------------------------------------------------
def test_success_returns_trimmed_title_text():
    scraper, fake_request, waits = make_scraper(
        [FakeResponse(200, VALID_HTML)]
    )

    result = scraper.get_web_data(
        "https://example.test/page", "h1", "id", "firstHeading"
    )

    assert result.outcome == OUTCOME_SUCCESS
    assert result.success is True
    # Surrounding whitespace must be stripped.
    assert result.text == "Python (programming language)"
    assert result.status_code == 200
    assert len(result.attempts) == 1
    assert result.attempts[0].outcome == OUTCOME_SUCCESS
    assert result.attempts[0].status_code == 200
    # No retry, so no waiting.
    assert waits == []
    # The browser User-Agent header is still sent through the transport.
    assert "User-Agent" in fake_request.calls[0]["headers"]
    # Structured serialization contains every required field.
    serialized = result.to_dict()
    assert set(serialized) == {
        "outcome",
        "text",
        "status_code",
        "reason",
        "attempts",
    }
    assert set(serialized["attempts"][0]) == {
        "attempt_number",
        "outcome",
        "status_code",
        "reason",
    }


# ---------------------------------------------------------------------------
# 2. Missing target element: settled immediately, no exception raised
# ---------------------------------------------------------------------------
def test_missing_element_is_not_an_exception():
    scraper, _fake_request, waits = make_scraper(
        [FakeResponse(200, b"<html><body><h1 id='other'>Nope</h1></body></html>")]
    )

    result = scraper.get_web_data(
        "https://example.test/page", "h1", "id", "firstHeading"
    )

    assert result.outcome == OUTCOME_ELEMENT_NOT_FOUND
    assert result.text is None
    assert result.status_code == 200
    assert "firstHeading" in result.reason
    assert len(result.attempts) == 1
    assert result.attempts[0].outcome == OUTCOME_ELEMENT_NOT_FOUND
    assert result.attempts[0].status_code == 200
    assert waits == []


def test_blank_text_after_stripping_counts_as_missing_element():
    scraper, _fake_request, _waits = make_scraper(
        [FakeResponse(200, b"<h1 id='firstHeading'>   </h1>")]
    )

    result = scraper.get_web_data(
        "https://example.test/page", "h1", "id", "firstHeading"
    )

    assert result.outcome == OUTCOME_ELEMENT_NOT_FOUND
    assert result.text is None
    assert len(result.attempts) == 1


# ---------------------------------------------------------------------------
# 3. 404: tried exactly once, status code preserved, no retry
# ---------------------------------------------------------------------------
def test_http_404_tries_once_and_keeps_status_code():
    scraper, fake_request, waits = make_scraper(
        [FakeResponse(404, b"<html><body>Not Found</body></html>")]
    )

    result = scraper.get_web_data(
        "https://example.test/missing", "h1", "id", "firstHeading"
    )

    assert result.outcome == OUTCOME_HTTP_ERROR
    assert result.text is None
    assert result.status_code == 404
    assert "404" in result.reason
    assert len(result.attempts) == 1
    assert result.attempts[0].outcome == OUTCOME_HTTP_ERROR
    assert result.attempts[0].status_code == 404
    assert len(fake_request.calls) == 1
    assert waits == []


# ---------------------------------------------------------------------------
# 4. Two 5xx responses followed by success on the third attempt
# ---------------------------------------------------------------------------
def test_two_5xx_then_success_retries_and_records_history():
    scraper, fake_request, waits = make_scraper(
        [
            FakeResponse(500, b"Internal Server Error"),
            FakeResponse(503, b"Service Unavailable"),
            FakeResponse(200, VALID_HTML),
        ]
    )

    result = scraper.get_web_data(
        "https://example.test/flaky", "h1", "id", "firstHeading"
    )

    assert result.outcome == OUTCOME_SUCCESS
    assert result.text == "Python (programming language)"
    # Last response actually received is the successful one.
    assert result.status_code == 200
    assert len(fake_request.calls) == 3
    assert len(result.attempts) == 3
    assert [a.attempt_number for a in result.attempts] == [1, 2, 3]
    assert result.attempts[0].outcome == OUTCOME_HTTP_ERROR
    assert result.attempts[0].status_code == 500
    assert result.attempts[1].outcome == OUTCOME_HTTP_ERROR
    assert result.attempts[1].status_code == 503
    assert result.attempts[2].outcome == OUTCOME_SUCCESS
    assert result.attempts[2].status_code == 200
    # Waits happen only before the 2nd and 3rd attempts.
    assert waits == [0.0, 0.0]


def test_5xx_exhausting_attempts_ends_as_http_error():
    scraper, fake_request, waits = make_scraper(
        [FakeResponse(502, b"Bad Gateway")] * 3
    )

    result = scraper.get_web_data(
        "https://example.test/down", "h1", "id", "firstHeading"
    )

    assert result.outcome == OUTCOME_HTTP_ERROR
    assert result.status_code == 502
    assert len(fake_request.calls) == 3
    assert all(a.status_code == 502 for a in result.attempts)
    assert len(result.attempts) == 3
    assert waits == [0.0, 0.0]


# ---------------------------------------------------------------------------
# 5. Connection timeout on every attempt: exhausted, classified network error
# ---------------------------------------------------------------------------
def test_connection_timeout_exhausts_attempts_as_network_error():
    timeout = requests.exceptions.ConnectTimeout("connection timed out")
    scraper, fake_request, waits = make_scraper([timeout] * 3)

    result = scraper.get_web_data(
        "https://example.test/slow", "h1", "id", "firstHeading"
    )

    assert result.outcome == OUTCOME_NETWORK_ERROR
    # HTTP and network failures must stay separate: no response means no code.
    assert result.status_code is None
    assert result.text is None
    assert "ConnectTimeout" in result.reason
    assert len(fake_request.calls) == 3
    assert len(result.attempts) == 3
    assert all(a.outcome == OUTCOME_NETWORK_ERROR for a in result.attempts)
    assert all(a.status_code is None for a in result.attempts)
    assert waits == [0.0, 0.0]


def test_network_error_then_success_retries_once():
    scraper, fake_request, waits = make_scraper(
        [
            requests.exceptions.ConnectionError("dns failure"),
            FakeResponse(200, VALID_HTML),
        ]
    )

    result = scraper.get_web_data(
        "https://example.test/recovered", "h1", "id", "firstHeading"
    )

    assert result.outcome == OUTCOME_SUCCESS
    assert result.text == "Python (programming language)"
    assert result.status_code == 200
    assert len(fake_request.calls) == 2
    assert result.attempts[0].outcome == OUTCOME_NETWORK_ERROR
    assert result.attempts[0].status_code is None
    assert waits == [0.0]


# ---------------------------------------------------------------------------
# 6. Illegal HTML / unparsable body: parse error, no crash, no retry
# ---------------------------------------------------------------------------
def test_unparsable_body_is_parse_error_without_crashing():
    # BeautifulSoup raises TypeError for content that is not bytes/str/file.
    scraper, fake_request, waits = make_scraper(
        [FakeResponse(200, None)]
    )

    result = scraper.get_web_data(
        "https://example.test/broken", "h1", "id", "firstHeading"
    )

    assert result.outcome == OUTCOME_PARSE_ERROR
    assert result.text is None
    assert result.status_code == 200
    assert "TypeError" in result.reason
    assert len(result.attempts) == 1
    assert result.attempts[0].outcome == OUTCOME_PARSE_ERROR
    # Parse errors settle on the first attempt.
    assert len(fake_request.calls) == 1
    assert waits == []


# ---------------------------------------------------------------------------
# Cross-cutting checks
# ---------------------------------------------------------------------------
def test_parse_error_is_not_retried_even_if_attempts_remain():
    scraper, fake_request, _waits = make_scraper(
        [FakeResponse(200, object())], max_attempts=3
    )

    result = scraper.get_web_data(
        "https://example.test/broken", "h1", "id", "firstHeading"
    )

    assert result.outcome == OUTCOME_PARSE_ERROR
    assert len(fake_request.calls) == 1
    assert len(result.attempts) == 1


def test_module_level_entry_keeps_four_parameter_signature():
    import inspect

    signature = inspect.signature(get_web_data)
    assert list(signature.parameters) == ["url", "tag", "attribute", "value"]


def test_injected_wait_receives_configured_delay():
    fake_request = make_fake_request(
        [
            requests.exceptions.ConnectionError("boom"),
            FakeResponse(200, VALID_HTML),
        ]
    )
    waits = []
    scraper = WebScraper(
        request_func=fake_request,
        wait_func=waits.append,
        max_attempts=3,
        retry_delay=0.25,
    )

    result = scraper.get_web_data(
        "https://example.test", "h1", "id", "firstHeading"
    )

    assert result.success is True
    assert waits == [0.25]


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
