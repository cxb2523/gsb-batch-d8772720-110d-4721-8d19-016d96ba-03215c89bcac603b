# -*- coding: utf-8 -*-
"""Stop-and-wait outcome records: captcha, login, cookie reinjection, gaps."""
import ast
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from src.crawler.stopwait_records import RECORD_FILE, StopWaitRecords


SOURCE = Path(__file__).resolve().parents[1] / "src" / "crawler" / "taobao_crawler.py"


def _read_records(staging_dir):
    path = Path(staging_dir) / RECORD_FILE
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _crawler_namespace(tmp_path, records=None):
    """Exec captcha/login helpers with a controllable clock and recorder."""
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
    names = {"wait_for_human_captcha", "reinject_login", "wait_for_manual_login"}
    funcs = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]

    class Clock:
        def __init__(self):
            self.now = 0.0
            self.stop = False
            self.logged_in = False

        def monotonic(self):
            return self.now

        def sleep(self, seconds):
            self.now += max(0.0, seconds)

    clock = Clock()
    ns = {
        "time": clock,
        "status_data": {"live_id": "123"},
        "STOPWAIT": records,
        "publish_status": lambda *args, **kwargs: None,
        "process_pending_command": lambda: None,
        "stop_requested": lambda: clock.stop,
        "logged_in": lambda: clock.logged_in,
        "log": lambda *args: None,
    }
    exec(compile(ast.Module(body=funcs, type_ignores=[]), str(SOURCE), "exec"), ns)
    return ns, clock


class _CaptchaPage:
    """Returns captcha-present for N checks, then absent unless always present."""

    def __init__(self, present_checks=None, always=False):
        self.remaining = present_checks
        self.always = always

    def ele(self, *args, **kwargs):
        if self.always:
            return object()
        if self.remaining is None:
            return None
        if self.remaining > 0:
            self.remaining -= 1
            return object()
        return None


def _fixed_clock(value=1_700_000_000.0):
    return lambda: value


# ---- captcha paths -------------------------------------------------------

def test_captcha_completed_records_start_and_outcome(tmp_path):
    records = StopWaitRecords(tmp_path / "staging", 9223, "run-a", 1,
                              clock=_fixed_clock())
    ns, clock = _crawler_namespace(tmp_path, records)
    # First ele() sees the captcha, then it clears on the next poll.
    page = _CaptchaPage(present_checks=1)
    clock.sleep = lambda seconds: setattr(clock, "now", clock.now + seconds)
    result = ns["wait_for_human_captcha"](page, timeout=10)
    assert result is True

    rows = _read_records(tmp_path / "staging")
    assert [row["record"] for row in rows] == ["captcha_wait_started", "captcha_wait_finished"]
    started, finished = rows
    assert started["live_id"] == "123" and started["port"] == 9223
    assert started["wait_limit_seconds"] == 10
    assert started["wait_started_at"] == started["occurred_at"]
    assert finished["outcome"] == "completed"
    assert finished["outcome_label"] == "验证码已完成"
    assert finished["wait_limit_seconds"] == 10
    assert finished["port"] == 9223 and finished["live_id"] == "123"
    assert finished["occurred_at"].endswith("Z")


def test_captcha_timeout_records_timeout_outcome(tmp_path):
    records = StopWaitRecords(tmp_path / "staging", 9224, "run-a", 2,
                              clock=_fixed_clock())
    ns, clock = _crawler_namespace(tmp_path, records)
    page = _CaptchaPage(always=True)
    result = ns["wait_for_human_captcha"](page, timeout=3)
    assert result is False
    rows = _read_records(tmp_path / "staging")
    assert [row["record"] for row in rows] == ["captcha_wait_started", "captcha_wait_finished"]
    assert rows[-1]["outcome"] == "timeout"
    assert rows[-1]["outcome_label"] == "验证码等待超时"
    # Wait did not extend beyond the configured limit.
    assert rows[-1]["waited_seconds"] >= 3


def test_captcha_stop_request_records_stop_outcome(tmp_path):
    records = StopWaitRecords(tmp_path / "staging", 9225, "run-a", 3,
                              clock=_fixed_clock())
    ns, clock = _crawler_namespace(tmp_path, records)
    page = _CaptchaPage(always=True)

    def stop_after_one_poll():
        return clock.now >= 1.0

    ns["stop_requested"] = stop_after_one_poll
    result = ns["wait_for_human_captcha"](page, timeout=180)
    assert result is False
    rows = _read_records(tmp_path / "staging")
    assert [row["record"] for row in rows] == ["captcha_wait_started", "captcha_wait_finished"]
    assert rows[-1]["outcome"] == "stop_requested"
    assert rows[-1]["outcome_label"] == "收到停止请求"
    # Stop interrupted before the timeout limit.
    assert rows[-1]["waited_seconds"] < 180


# ---- cookie reinjection paths -------------------------------------------

def _login_namespace(tmp_path, *, refresh_result):
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
    names = {"reinject_login"}
    funcs = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    calls = []

    def refresh_login():
        calls.append("refresh")
        return refresh_result

    records = StopWaitRecords(tmp_path / "staging", 9226, "run-a", 4, clock=_fixed_clock())
    ns = {"refresh_login": refresh_login, "STOPWAIT": records,
          "log": lambda *args: None}
    exec(compile(ast.Module(body=funcs, type_ignores=[]), str(SOURCE), "exec"), ns)
    return ns, records, calls


def test_cookie_reinjection_success_records_trigger_and_result(tmp_path):
    ns, records, calls = _login_namespace(tmp_path, refresh_result=True)
    assert ns["reinject_login"]("123", trigger_reason="login_expired_response") is True
    assert calls == ["refresh"]
    row = _read_records(tmp_path / "staging")[0]
    assert row["record"] == "cookie_reinjection"
    assert row["live_id"] == "123"
    assert row["trigger_reason"] == "login_expired_response"
    assert row["injection_result"] == "success"
    assert row["manual_login_required"] is False
    assert row["port"] == 9226


def test_cookie_reinjection_failure_records_failed_and_manual_login(tmp_path):
    ns, records, calls = _login_namespace(tmp_path, refresh_result=False)
    assert ns["reinject_login"]("456", trigger_reason="login_expired_response") is False
    row = _read_records(tmp_path / "staging")[0]
    assert row["injection_result"] == "failed"
    assert row["manual_login_required"] is True
    assert row["detail"] == "cookie_reinjection_insufficient_or_failed"


# ---- failure containment -------------------------------------------------

def test_record_write_failure_sets_gap_and_capture_flow_continues(tmp_path):
    gap_calls = []
    records = StopWaitRecords(tmp_path / "staging", 9227, "run-a", 5,
                              clock=_fixed_clock(), on_gap=lambda: gap_calls.append(1))
    # Simulate a broken append.
    def boom(row):
        raise OSError("synthetic append failure")
    records._append = boom

    ns, clock = _crawler_namespace(tmp_path, records)
    page = _CaptchaPage(present_checks=1)
    assert ns["wait_for_human_captcha"](page, timeout=10) is True
    assert records.gap is True
    assert len(gap_calls) == 2  # start + finish both attempted, both contained
    # No partial file written by the failing path.
    assert not (tmp_path / "staging" / RECORD_FILE).exists()


def test_record_write_failure_does_not_change_login_outcome(tmp_path):
    records = StopWaitRecords(tmp_path / "staging", 9227, "run-a", 5, clock=_fixed_clock())
    records._append = lambda row: (_ for _ in ()).throw(OSError("boom"))
    ns, _, _ = _login_namespace(tmp_path, refresh_result=False)
    ns["STOPWAIT"] = records
    assert ns["reinject_login"]("789") is False
    assert records.gap is True


def test_records_are_append_only_and_survive_reexisting_file(tmp_path):
    staging = tmp_path / "staging"
    first = StopWaitRecords(staging, 9223, "run-a", 1, clock=_fixed_clock())
    first.captcha_wait_started(live_id="1", limit_seconds=180)
    second = StopWaitRecords(staging, 9224, "run-a", 2, clock=_fixed_clock())
    second.cookie_reinjection(live_id="2", trigger_reason="r", success=True)
    rows = _read_records(staging)
    assert [row["record"] for row in rows] == ["captcha_wait_started", "cookie_reinjection"]
    assert [row["port"] for row in rows] == [9223, 9224]
    # Sequence continues across a restart instead of restarting at 1.
    assert [row["record_seq"] for row in rows] == [1, 2]
    # Existing content preserved; file appends rather than truncating.
    raw = (staging / RECORD_FILE).read_text(encoding="utf-8")
    assert raw.count("\n") == 2


def test_manual_login_wait_records_start_limit_and_outcome(tmp_path):
    records = StopWaitRecords(tmp_path / "staging", 9223, "run-a", 1, clock=_fixed_clock())
    records.manual_login_wait_started(live_id="123", limit_seconds=300,
                                      trigger_reason="initial_login_required")
    records.manual_login_wait_finished(live_id="123", outcome="timeout",
                                       waited_seconds=300, limit_seconds=300)
    rows = _read_records(tmp_path / "staging")
    assert rows[0]["record"] == "manual_login_wait_started"
    assert rows[0]["wait_limit_seconds"] == 300
    assert rows[0]["wait_started_at"] == rows[0]["occurred_at"]
    assert rows[1]["record"] == "manual_login_wait_finished"
    assert rows[1]["outcome"] == "timeout"
    assert rows[1]["outcome_label"] == "人工登录等待超时"


def test_manual_login_wait_completed_records_outcome(tmp_path):
    records = StopWaitRecords(tmp_path / "staging", 9223, "run-a", 1, clock=_fixed_clock())
    ns, clock = _crawler_namespace(tmp_path, records)
    clock.sleep = lambda seconds: setattr(clock, "now", clock.now + seconds)
    clock.logged_in = True
    assert ns["wait_for_manual_login"](timeout=300) == "completed"
    rows = _read_records(tmp_path / "staging")
    assert [row["record"] for row in rows] == ["manual_login_wait_started", "manual_login_wait_finished"]
    assert rows[0]["wait_limit_seconds"] == 300
    assert rows[1]["outcome"] == "completed"
    assert rows[1]["outcome_label"] == "登录已完成"


def test_manual_login_wait_timeout_exits_with_timeout_outcome(tmp_path):
    records = StopWaitRecords(tmp_path / "staging", 9224, "run-a", 2, clock=_fixed_clock())
    ns, clock = _crawler_namespace(tmp_path, records)
    outcome = ns["wait_for_manual_login"](timeout=6)
    assert outcome == "timeout"
    # Wait never exceeded the configured limit.
    assert clock.now <= 6
    rows = _read_records(tmp_path / "staging")
    assert rows[-1]["outcome"] == "timeout"
    assert rows[-1]["waited_seconds"] >= 6


def test_manual_login_wait_stop_request_does_not_extend_wait(tmp_path):
    records = StopWaitRecords(tmp_path / "staging", 9225, "run-a", 3, clock=_fixed_clock())
    ns, clock = _crawler_namespace(tmp_path, records)
    ns["stop_requested"] = lambda: True
    assert ns["wait_for_manual_login"](timeout=300) == "stop_requested"
    assert clock.now == 0  # stop was honored immediately
    rows = _read_records(tmp_path / "staging")
    assert rows[-1]["outcome"] == "stop_requested"
    assert rows[-1]["wait_limit_seconds"] == 300


def test_record_is_synced_before_return_so_abrupt_exit_keeps_it(tmp_path, monkeypatch):
    synced = []
    real_fsync = os.fsync
    monkeypatch.setattr(os, "fsync", lambda fd: (synced.append(fd), real_fsync(fd))[1])
    records = StopWaitRecords(tmp_path / "staging", 9223, "run-a", 1, clock=_fixed_clock())
    records.captcha_wait_started(live_id="123", limit_seconds=180)
    assert len(synced) == 1
    assert _read_records(tmp_path / "staging")[0]["record"] == "captcha_wait_started"


def test_gap_marker_keeps_existing_status_fields(tmp_path):
    status_file = tmp_path / "status.json"
    status_file.write_text(json.dumps({"phase": "recording", "live_id": "123",
                                       "stopwait_record_gap": False}), encoding="utf-8")
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
    fn = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
              and node.name == "_mark_stopwait_gap")
    from src.utils.safe_io import atomic_json
    ns = {"status_data": {"stopwait_record_gap": False}, "STATUS_FILE": str(status_file),
          "atomic_json": atomic_json, "json": json, "os": os}
    exec(compile(ast.Module(body=[fn], type_ignores=[]), str(SOURCE), "exec"), ns)
    ns["_mark_stopwait_gap"]()
    saved = json.loads(status_file.read_text(encoding="utf-8"))
    assert saved["stopwait_record_gap"] is True
    assert saved["phase"] == "recording" and saved["live_id"] == "123"
    assert ns["status_data"]["stopwait_record_gap"] is True


def test_captcha_records_carry_required_identity_fields(tmp_path):
    records = StopWaitRecords(tmp_path / "staging", 9333, "run-a", 11, clock=_fixed_clock())
    records.captcha_wait_started(live_id="live-abc", limit_seconds=42)
    row = _read_records(tmp_path / "staging")[0]
    assert row["live_id"] == "live-abc"
    assert row["port"] == 9333
    assert row["occurred_at"].endswith("Z")
    assert row["occurred_epoch"] == 1_700_000_000.0
    assert row["run_id"] == "run-a" and row["instance_id"] == 11


def test_login_timeout_keeps_original_exit_code_and_wait_limit():
    """Recording must not change the exit path or the 5-minute login wait."""
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
    exit_calls = [node for node in ast.walk(tree)
                  if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                  and node.func.attr == "exit" and node.args
                  and isinstance(node.args[0], ast.Constant) and node.args[0].value == 3]
    assert exit_calls, "login timeout must still exit with code 3"
    bounded = [node for node in ast.walk(tree) if isinstance(node, ast.Constant)
               and node.value == 300]
    assert bounded, "manual login wait limit of 300 seconds must be preserved"
