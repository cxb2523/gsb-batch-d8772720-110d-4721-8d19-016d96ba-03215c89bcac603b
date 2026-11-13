
"""Local tests for the resumable, retrying movie-review pipeline."""

import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import httpx
import pytest
from groq import (
    APIConnectionError,
    RateLimitError,
)

from llm_sampling_lab import cli, movie_reviews
from llm_sampling_lab.movie_reviews import (
    DEFAULT_MOVIE,
    DEFAULT_SCENARIOS,
    STATUS_FAILED,
    STATUS_SUCCESS,
    run_movie_review_experiment,
)

VALID_REVIEW = DEFAULT_MOVIE.title + " " + "hikaye " * 80

# Title present but the word count is deliberately out of range.
SHORT_REVIEW = DEFAULT_MOVIE.title + " kisa bir inceleme."


def _request() -> httpx.Request:
    return httpx.Request(
        "POST",
        "https://api.groq.com/openai/v1/chat/completions",
    )


def rate_limit_error(message: str = "Rate limit exceeded") -> RateLimitError:
    return RateLimitError(
        message,
        response=httpx.Response(429, request=_request()),
        body=None,
    )


def connection_error() -> APIConnectionError:
    return APIConnectionError(request=_request())


class FakeGroqClient:
    """Minimal Groq-shaped client driven by a scripted response list.

    Each script entry is either a string (used as message content) or an
    exception instance to raise. When the script is exhausted, its last
    entry is repeated.
    """

    def __init__(self, script: list[object]) -> None:
        if not script:
            raise ValueError("script cannot be empty")

        self.script = script
        self.requests: list[dict] = []

        completions = SimpleNamespace(create=self._create)

        self.chat = SimpleNamespace(completions=completions)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def _create(self, **kwargs):
        index = len(self.requests)
        self.requests.append(kwargs)

        action = self.script[
            min(index, len(self.script) - 1)
        ]

        if isinstance(action, BaseException):
            raise action

        return SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(content=action),
                )
            ],
        )


@pytest.fixture
def no_sleep(monkeypatch):
    """Capture backoff waits instead of actually sleeping."""

    delays: list[float] = []
    monkeypatch.setattr(
        movie_reviews.time,
        "sleep",
        delays.append,
    )
    return delays


def test_rate_limit_then_success_retries_with_increasing_backoff(
    no_sleep,
):
    """Transient errors are retried and the eventual review is kept."""

    client = FakeGroqClient([
        rate_limit_error(),
        connection_error(),
        VALID_REVIEW,
    ])

    results = run_movie_review_experiment(
        client=client,
        model="test-model",
        scenarios=[(0.3, 1)],
        retry_backoff_seconds=0.5,
    )

    assert len(client.requests) == 3
    assert no_sleep == [0.5, 1.0]

    assert len(results) == 1
    result = results[0]

    assert result.status == STATUS_SUCCESS
    assert result.attempts == 3
    assert result.review == VALID_REVIEW
    assert result.error_type is None


def test_retries_exhausted_records_failure_and_continues(no_sleep):
    """A scenario that keeps failing is marked failed and later ones run."""

    client = FakeGroqClient([rate_limit_error("still limited")])

    results = run_movie_review_experiment(
        client=client,
        model="test-model",
        scenarios=[(0.3, 1), (1.0, 3)],
        max_attempts=3,
        retry_backoff_seconds=0.25,
    )

    # 3 attempts per scenario, both scenarios attempted.
    assert len(client.requests) == 6
    assert no_sleep == [0.25, 0.5, 0.25, 0.5]

    assert [item.scenario for item in results] == [1, 2]

    for result in results:
        assert result.status == STATUS_FAILED
        assert result.attempts == 3
        assert result.review is None
        assert result.error_type == "RateLimitError"
        assert result.error_message == "still limited"


def test_empty_response_fails_without_retry_and_never_stores_body(
    no_sleep,
):
    """Empty or whitespace-only content is a failure, not a retry."""

    scenarios = [(0.3, 1), (1.0, 1)]

    for empty_content in (None, "", "   \n\t "):
        client = FakeGroqClient([empty_content])

        results = run_movie_review_experiment(
            client=client,
            model="test-model",
            scenarios=scenarios,
            max_attempts=3,
            retry_backoff_seconds=0.5,
        )

        # One attempt per scenario: empty output is not transient.
        assert len(client.requests) == len(scenarios)
        assert no_sleep == []

        for result in results:
            assert result.status == STATUS_FAILED
            assert result.attempts == 1
            assert result.review is None
            assert result.error_type == "EmptyResponseError"
            assert result.validation_issues == ()


def test_resume_skips_completed_scenarios_and_merges_report(
    monkeypatch,
    tmp_path,
    no_sleep,
):
    """A second run only requests failed scenarios and merges results."""

    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(
        cli,
        "create_groq_client",
        lambda: MagicMock(),
    )

    # First run: scenario 1 warns on validation, scenario 2 exhausts its
    # retries, and scenarios 3 and 4 succeed.
    first_client = FakeGroqClient([
        SHORT_REVIEW,        # scenario 1 (validation warning)
        rate_limit_error(),  # scenario 2, attempt 1
        rate_limit_error(),  # scenario 2, attempt 2
        rate_limit_error(),  # scenario 2, attempt 3 -> failed
        VALID_REVIEW,        # scenario 3
        VALID_REVIEW,        # scenario 4
    ])

    monkeypatch.setattr(
        cli,
        "create_groq_client",
        lambda: first_client,
    )

    cli.run_movie_reviews_cli(
        settings={"groq": {"model": "test-model"}},
    )

    reports = list(
        (tmp_path / "results" / "movie_reviews").glob("*.json")
    )
    assert len(reports) == 1
    report_path = reports[0]

    first_report = json.loads(
        report_path.read_text(encoding="utf-8")
    )

    # Scenario 1, 3, 4 = 3 requests; scenario 2 = 3 attempts.
    assert len(first_client.requests) == 6
    assert first_report["summary"]["completed_scenarios"] == 3
    assert first_report["summary"]["failed_scenarios"] == 1
    assert first_report["summary"]["validation_warning_count"] == 1

    # Second run: a fresh client that succeeds for the single retry.
    second_client = FakeGroqClient([VALID_REVIEW])

    monkeypatch.setattr(
        cli,
        "create_groq_client",
        lambda: second_client,
    )

    cli.run_movie_reviews_cli(
        settings={"groq": {"model": "test-model"}},
    )

    # Only the previously failed scenario issued a request.
    assert len(second_client.requests) == 1

    # The same report file was updated, not duplicated.
    reports = list(
        (tmp_path / "results" / "movie_reviews").glob("*.json")
    )
    assert reports == [report_path]

    merged = json.loads(
        report_path.read_text(encoding="utf-8")
    )

    assert merged["status"] == "completed"
    assert merged["summary"]["completed_scenarios"] == 4
    assert merged["summary"]["failed_scenarios"] == 0
    # The validation warning from the reused successful entry survives.
    assert merged["summary"]["validation_warning_count"] == 1

    assert [item["scenario"] for item in merged["results"]] == [
        1,
        2,
        3,
        4,
    ]

    assert all(
        item["status"] == STATUS_SUCCESS
        for item in merged["results"]
    )
    assert all(
        item["review"] and item["review"].strip()
        for item in merged["results"]
    )

    # Scenario 2 was overwritten with the successful retry.
    assert merged["results"][1]["attempts"] == 1
    assert merged["results"][1]["review"] == VALID_REVIEW

    # Reused entries keep their original attempt counts.
    assert merged["results"][0]["attempts"] == 1
    assert merged["results"][0]["validation_issues"] == [
        "word_count_out_of_range",
    ]


def test_resume_with_no_pending_scenarios_sends_no_requests(
    monkeypatch,
    tmp_path,
    no_sleep,
):
    """A fully completed report is not queried again."""

    monkeypatch.chdir(tmp_path)

    first_client = FakeGroqClient([VALID_REVIEW])

    monkeypatch.setattr(
        cli,
        "create_groq_client",
        lambda: first_client,
    )

    cli.run_movie_reviews_cli(
        settings={"groq": {"model": "test-model"}},
    )

    assert len(first_client.requests) == len(DEFAULT_SCENARIOS)

    second_client = FakeGroqClient([VALID_REVIEW])

    def fail_if_called():
        raise AssertionError("A client should not be created.")

    monkeypatch.setattr(
        cli,
        "create_groq_client",
        fail_if_called,
    )

    cli.run_movie_reviews_cli(
        settings={"groq": {"model": "test-model"}},
    )

    assert second_client.requests == []

    reports = list(
        (tmp_path / "results" / "movie_reviews").glob("*.json")
    )
    assert len(reports) == 1

    data = json.loads(
        reports[0].read_text(encoding="utf-8")
    )

    assert data["status"] == "completed"
    assert data["summary"]["completed_scenarios"] == 4
    assert data["summary"]["failed_scenarios"] == 0
