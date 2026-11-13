"""Offline tests for the auditable batch pipeline and the ``batch`` CLI.

No real network is ever touched: every test injects a fake session (or a
session factory) into :func:`amazon_captcha.batch.run_fetch_batch`, or patches
``requests.Session`` for CLI-level tests.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import requests

from amazon_captcha.batch import (
    OUTCOME_CAPTCHA_EXHAUSTED,
    OUTCOME_REQUEST_ERROR,
    OUTCOME_SUCCESS,
    asin_to_url,
    run_fetch_batch,
    summarize,
)
from amazon_captcha.cli import main as cli_main


class _FakeResponse:
    def __init__(self, text: str, status_code: int, url: str | None = None):
        self.text = text
        self.status_code = status_code
        self.url = url or "https://www.amazon.com/dp/SR"


CAPTCHA_BODY = "<title>Robot Check</title>type the characters you see in this image"
NORMAL_BODY = "<html><body>normal product page</body></html>"


class _ScriptedSession:
    """Fake session returning scripted responses or raising scripted errors.

    ``script`` maps a URL to either a list of ``_FakeResponse`` instances
    (replayed in order, last one repeats) or an ``Exception`` raised on every
    call. A lock keeps the shared session safe under worker threads.
    """

    def __init__(self, script: dict):
        self._script = script
        self._counters: dict[str, int] = {}
        import threading

        self._lock = threading.Lock()

    def get(self, url, headers=None, timeout=None):
        with self._lock:
            n = self._counters.get(url, 0)
            self._counters[url] = n + 1
        behavior = self._script[url]
        if isinstance(behavior, Exception):
            raise behavior
        idx = min(n, len(behavior) - 1)
        return behavior[idx]


def _captcha_session() -> _ScriptedSession:
    return _ScriptedSession(
        {"https://www.amazon.com/dp/B000CAPTCHA": [_FakeResponse(CAPTCHA_BODY, 503)]}
    )


def _normal_session() -> _ScriptedSession:
    return _ScriptedSession({"https://www.amazon.com/dp/B000OK": [_FakeResponse(NORMAL_BODY, 200)]})


def _error_session() -> _ScriptedSession:
    return _ScriptedSession(
        {"https://www.amazon.com/dp/B000DEAD": requests.ConnectionError("connection refused")}
    )


# ---------------------------------------------------------------------------
# Path 1: normal page retrieval
# ---------------------------------------------------------------------------
def test_batch_success_path_produces_auditable_record():
    url = "https://www.amazon.com/dp/B000OK"
    records = run_fetch_batch(
        [url],
        max_workers=2,
        max_attempts=3,
        session_factory=_normal_session,
        sleep=lambda _: None,
    )
    assert len(records) == 1
    record = records[0]
    assert record.item == url
    assert record.url == url
    assert record.outcome == OUTCOME_SUCCESS
    assert record.ok is True
    assert record.attempts == 1
    assert record.status_code == 200
    assert record.is_captcha is False
    assert record.risk_level == "none"
    assert record.matched_markers == []
    assert record.error is None
    # to_dict exposes every required, checkable field.
    row = record.to_dict()
    assert set(row) == {
        "item",
        "url",
        "attempts",
        "status_code",
        "is_captcha",
        "risk_level",
        "matched_markers",
        "outcome",
        "error",
        "effective_url",
    }
    json.dumps(row)  # serializable


# ---------------------------------------------------------------------------
# Path 2: CAPTCHA / challenge page after retries are exhausted
# ---------------------------------------------------------------------------
def test_batch_captcha_exhausted_path():
    url = "https://www.amazon.com/dp/B000CAPTCHA"
    records = run_fetch_batch(
        [url],
        max_workers=1,
        max_attempts=3,
        session_factory=_captcha_session,
        sleep=lambda _: None,
    )
    assert len(records) == 1
    record = records[0]
    assert record.outcome == OUTCOME_CAPTCHA_EXHAUSTED
    assert record.ok is False
    assert record.attempts == 3
    assert record.status_code == 503
    assert record.is_captcha is True
    assert record.risk_level == "high"
    assert "type the characters you see in this image" in record.matched_markers
    assert record.error is None


# ---------------------------------------------------------------------------
# Path 3: request exception on every attempt — batch must not be interrupted
# ---------------------------------------------------------------------------
def test_batch_request_error_path_keeps_error_message():
    url = "https://www.amazon.com/dp/B000DEAD"
    records = run_fetch_batch(
        [url],
        max_workers=1,
        max_attempts=3,
        session_factory=_error_session,
        sleep=lambda _: None,
    )
    assert len(records) == 1
    record = records[0]
    assert record.outcome == OUTCOME_REQUEST_ERROR
    assert record.ok is False
    assert record.attempts == 3
    assert record.status_code is None
    assert record.is_captcha is False
    assert record.risk_level == "none"
    assert record.matched_markers == []
    assert record.effective_url is None
    assert record.error is not None
    assert "connection refused" in record.error


def test_batch_mixed_inputs_keep_order_and_never_abort():
    ok_url = "https://www.amazon.com/dp/B000OK"
    captcha_url = "https://www.amazon.com/dp/B000CAPTCHA"
    dead_url = "https://www.amazon.com/dp/B000DEAD"
    inputs = [captcha_url, ok_url, dead_url]

    script = {
        ok_url: [_FakeResponse(NORMAL_BODY, 200)],
        captcha_url: [_FakeResponse(CAPTCHA_BODY, 503)],
        dead_url: requests.ConnectionError("connection refused"),
    }
    records = run_fetch_batch(
        inputs,
        max_workers=3,
        max_attempts=2,
        session_factory=lambda: _ScriptedSession(script),
        sleep=lambda _: None,
    )
    # Order preserved despite concurrency, one record per input.
    assert [r.item for r in records] == inputs
    assert [r.outcome for r in records] == [
        OUTCOME_CAPTCHA_EXHAUSTED,
        OUTCOME_SUCCESS,
        OUTCOME_REQUEST_ERROR,
    ]
    summary = summarize(records)
    assert summary["total"] == 3
    assert summary[OUTCOME_SUCCESS] == 1
    assert summary[OUTCOME_CAPTCHA_EXHAUSTED] == 1
    assert summary[OUTCOME_REQUEST_ERROR] == 1


def test_batch_as_asin_converts_urls_per_asin_to_url_rule():
    asin = "B000OK"
    expected = asin_to_url(asin, domain="amazon.co.uk")
    script = {expected: [_FakeResponse(NORMAL_BODY, 200, url=expected)]}
    records = run_fetch_batch(
        [asin],
        as_asin=True,
        domain="amazon.co.uk",
        max_attempts=1,
        session_factory=lambda: _ScriptedSession(script),
        sleep=lambda _: None,
    )
    assert len(records) == 1
    record = records[0]
    assert record.item == asin
    assert record.url == expected
    assert record.outcome == OUTCOME_SUCCESS
    assert record.effective_url == expected


def test_batch_worker_exception_is_captured_not_raised():
    def _boom():
        raise RuntimeError("factory exploded")

    records = run_fetch_batch(
        ["whatever"],
        max_attempts=1,
        session_factory=_boom,
        sleep=lambda _: None,
    )
    assert len(records) == 1
    assert records[0].outcome == OUTCOME_REQUEST_ERROR
    assert "factory exploded" in (records[0].error or "")


# ---------------------------------------------------------------------------
# CLI: `batch` subcommand output file + exit code contract (still offline)
# ---------------------------------------------------------------------------
def _write_input(tmp_path: Path, lines: list[str]) -> Path:
    path = tmp_path / "inputs.txt"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def test_cli_batch_all_success_exits_zero(tmp_path, monkeypatch, capsys):
    url = "https://www.amazon.com/dp/B000OK"
    input_path = _write_input(tmp_path, [url])
    output_path = tmp_path / "out.json"

    fake = _ScriptedSession({url: [_FakeResponse(NORMAL_BODY, 200)]})
    monkeypatch.setattr("amazon_captcha.fetch.requests.Session", lambda: fake)

    exit_code = cli_main(
        [
            "batch",
            str(input_path),
            str(output_path),
            "--workers",
            "1",
            "--max-attempts",
            "1",
            "--timeout",
            "5",
        ]
    )
    assert exit_code == 0

    payload = json.loads(output_path.read_text(encoding="utf-8"))
    assert payload["summary"]["total"] == 1
    assert payload["summary"][OUTCOME_SUCCESS] == 1
    row = payload["records"][0]
    assert row["item"] == url
    assert row["url"] == url
    assert row["attempts"] == 1
    assert row["status_code"] == 200
    assert row["is_captcha"] is False
    assert row["outcome"] == OUTCOME_SUCCESS

    # One JSON line per input on stdout as well.
    stdout = capsys.readouterr().out
    printed = [line for line in stdout.splitlines() if line.startswith("{")]
    assert len(printed) == 1
    assert json.loads(printed[0])["url"] == url


def test_cli_batch_failure_exits_nonzero_and_keeps_all_records(tmp_path, monkeypatch):
    ok_url = "https://www.amazon.com/dp/B000OK"
    captcha_url = "https://www.amazon.com/dp/B000CAPTCHA"
    dead_url = "https://www.amazon.com/dp/B000DEAD"
    input_path = _write_input(tmp_path, [ok_url, captcha_url, dead_url])
    output_path = tmp_path / "out.json"

    script = {
        ok_url: [_FakeResponse(NORMAL_BODY, 200)],
        captcha_url: [_FakeResponse(CAPTCHA_BODY, 503)],
        dead_url: requests.ConnectionError("connection refused"),
    }
    monkeypatch.setattr(
        "amazon_captcha.fetch.requests.Session",
        lambda: _ScriptedSession(script),
    )

    exit_code = cli_main(
        [
            "batch",
            str(input_path),
            str(output_path),
            "--workers",
            "2",
            "--max-attempts",
            "1",
            "--timeout",
            "5",
        ]
    )
    assert exit_code == 1

    payload = json.loads(output_path.read_text(encoding="utf-8"))
    records = payload["records"]
    assert len(records) == 3  # nothing got dropped
    by_item = {row["item"]: row for row in records}
    assert by_item[ok_url]["outcome"] == OUTCOME_SUCCESS
    assert by_item[captcha_url]["outcome"] == OUTCOME_CAPTCHA_EXHAUSTED
    assert by_item[captcha_url]["is_captcha"] is True
    dead = by_item[dead_url]
    assert dead["outcome"] == OUTCOME_REQUEST_ERROR
    assert dead["status_code"] is None
    assert "connection refused" in dead["error"]
    assert payload["summary"][OUTCOME_REQUEST_ERROR] == 1


def test_cli_batch_as_asin_and_domain_flags_are_preserved(tmp_path, monkeypatch):
    asin = "B000OK"
    expected_url = asin_to_url(asin, domain="amazon.de")
    input_path = _write_input(tmp_path, [asin])
    output_path = tmp_path / "out.json"

    fake = _ScriptedSession({expected_url: [_FakeResponse(NORMAL_BODY, 200, url=expected_url)]})
    monkeypatch.setattr("amazon_captcha.fetch.requests.Session", lambda: fake)

    exit_code = cli_main(
        [
            "batch",
            str(input_path),
            str(output_path),
            "--as-asin",
            "--domain",
            "amazon.de",
            "--max-attempts",
            "1",
        ]
    )
    assert exit_code == 0
    payload = json.loads(output_path.read_text(encoding="utf-8"))
    row = payload["records"][0]
    assert row["item"] == asin
    assert row["url"] == expected_url


def test_cli_batch_comments_and_blank_lines_are_skipped(tmp_path, monkeypatch):
    url = "https://www.amazon.com/dp/B000OK"
    input_path = tmp_path / "inputs.txt"
    input_path.write_text(f"# a comment\n\n{url}\n  \n# trailing\n", encoding="utf-8")
    output_path = tmp_path / "out.json"
    fake = _ScriptedSession({url: [_FakeResponse(NORMAL_BODY, 200)]})
    monkeypatch.setattr("amazon_captcha.fetch.requests.Session", lambda: fake)

    exit_code = cli_main(["batch", str(input_path), str(output_path), "--max-attempts", "1"])
    assert exit_code == 0
    payload = json.loads(output_path.read_text(encoding="utf-8"))
    assert payload["summary"]["total"] == 1


@pytest.fixture(autouse=True)
def _no_real_network(monkeypatch):
    """Defensive guard: fail loudly if any test tries a real network call."""

    def _refuse(*args, **kwargs):  # pragma: no cover - safety net only
        raise AssertionError("real network access is not allowed in offline tests")

    monkeypatch.setattr(requests.api, "request", _refuse)
    yield
