# -*- coding: utf-8 -*-
"""Append-only stop-and-wait outcome records for one collector instance.

Each record is a single JSON line appended to ``stop_wait_outcomes.jsonl`` in
the instance staging directory.  Every line is written with ``O_APPEND`` and
synced with ``fsync`` before the call returns, so records written before an
abnormal process exit survive.  Recording is strictly best-effort: an I/O
error sets ``gap`` (and calls the optional ``on_gap`` callback) and never
propagates to the capture flow.
"""
import datetime
import json
import os
from pathlib import Path
import threading
import time

RECORD_FILE = "stop_wait_outcomes.jsonl"

CAPTCHA_OUTCOME_LABELS = {
    "completed": "验证码已完成",
    "timeout": "验证码等待超时",
    "stop_requested": "收到停止请求",
    "failed": "验证码等待异常结束",
}
LOGIN_OUTCOME_LABELS = {
    "completed": "登录已完成",
    "timeout": "人工登录等待超时",
    "stop_requested": "收到停止请求",
    "failed": "人工登录等待异常结束",
}


def utc_time(epoch):
    """Local helper kept here so record timestamps are always UTC with millis."""
    return datetime.datetime.fromtimestamp(
        epoch, datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class StopWaitRecords:
    """One writer per instance; failures are contained and surfaced as ``gap``."""

    def __init__(self, staging_dir, port, run_id=None, instance_id=None, *,
                 clock=None, on_gap=None):
        self.directory = Path(staging_dir)
        self.path = self.directory / RECORD_FILE
        self.port = int(port)
        self.run_id = None if run_id is None else str(run_id)
        self.instance_id = instance_id
        self.clock = clock or time.time
        self.on_gap = on_gap
        self.gap = False
        self._lock = threading.Lock()
        self._sequence = 0
        self._sequence_loaded = False
        self._directory_ready = False

    def _next_sequence(self):
        """Continue numbering across restarts so appended lines stay traceable."""
        if self._sequence_loaded:
            return self._sequence
        self._sequence_loaded = True
        try:
            with self.path.open("rb") as stream:
                self._sequence = sum(1 for line in stream if line.strip())
        except OSError:
            self._sequence = 0
        return self._sequence

    def _emit(self, record, *, live_id=None, fields=None):
        with self._lock:
            self._sequence = self._next_sequence() + 1
            occurred = self.clock()
            row = {
                "schema_version": 1,
                "record": record,
                "record_seq": self._sequence,
                "run_id": self.run_id,
                "instance_id": self.instance_id,
                "port": self.port,
                "live_id": None if live_id is None else str(live_id),
                "occurred_at": utc_time(occurred),
                "occurred_epoch": round(float(occurred), 3),
            }
            row.update(fields or {})
            if record in ("captcha_wait_started", "manual_login_wait_started"):
                # Start time is the record occurrence; keep an explicit field
                # so consumers do not have to interpret generic field names.
                row["wait_started_at"] = row["occurred_at"]
                row["wait_started_epoch"] = row["occurred_epoch"]
            try:
                self._append(row)
            except Exception:
                # A missing outcome record must never break capture or waiting.
                self.gap = True
                self._notify_gap()
                return None
            return row

    def _append(self, row):
        data = (json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        if not self._directory_ready:
            self.directory.mkdir(parents=True, exist_ok=True)
            self._directory_ready = True
        fd = os.open(str(self.path), os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
        try:
            view = memoryview(data)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    raise OSError("append made no progress")
                view = view[written:]
            # Flush to disk now: the record must survive an abrupt process exit.
            os.fsync(fd)
        finally:
            os.close(fd)

    def _notify_gap(self):
        if self.on_gap:
            try:
                self.on_gap()
            except Exception:
                pass

    def cookie_reinjection(self, *, live_id=None, trigger_reason=None, success,
                           manual_login_required=None, manual_login_wait=False,
                           follow_up_action=None, detail=None):
        """Record one reinjection attempt and what the flow did next.

        ``manual_login_wait`` only says whether a blocking human-login wait was
        actually entered; ``manual_login_required`` records that a human login
        is still needed even when the loop keeps retrying.
        """
        required = (not success) if manual_login_required is None else bool(manual_login_required)
        return self._emit(
            "cookie_reinjection", live_id=live_id,
            fields={
                "trigger_reason": trigger_reason,
                "injection_result": "success" if success else "failed",
                "manual_login_required": required,
                "manual_login_wait": bool(manual_login_wait),
                "follow_up_action": follow_up_action,
                "detail": detail,
            })

    def captcha_wait_started(self, *, live_id=None, limit_seconds):
        return self._emit(
            "captcha_wait_started", live_id=live_id,
            fields={"wait_limit_seconds": limit_seconds})

    def captcha_wait_finished(self, *, live_id=None, outcome,
                              waited_seconds=None, limit_seconds=None):
        return self._emit(
            "captcha_wait_finished", live_id=live_id,
            fields={
                "outcome": str(outcome),
                "outcome_label": CAPTCHA_OUTCOME_LABELS.get(outcome, str(outcome)),
                "waited_seconds": waited_seconds,
                "wait_limit_seconds": limit_seconds,
            })

    def manual_login_wait_started(self, *, live_id=None, limit_seconds,
                                  trigger_reason="login_required"):
        return self._emit(
            "manual_login_wait_started", live_id=live_id,
            fields={
                "trigger_reason": trigger_reason,
                "wait_limit_seconds": limit_seconds,
            })

    def manual_login_wait_finished(self, *, live_id=None, outcome,
                                   waited_seconds=None, limit_seconds=None):
        return self._emit(
            "manual_login_wait_finished", live_id=live_id,
            fields={
                "outcome": str(outcome),
                "outcome_label": LOGIN_OUTCOME_LABELS.get(outcome, str(outcome)),
                "waited_seconds": waited_seconds,
                "wait_limit_seconds": limit_seconds,
            })
