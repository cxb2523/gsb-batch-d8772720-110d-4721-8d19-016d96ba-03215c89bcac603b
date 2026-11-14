"""Tests for the `partialZim` flag reported in the zimit progress file.

Crawler, warc2zim and the inotify-based progress watcher are all replaced by local
stubs: these tests must not depend on any real crawl, conversion or network access.
"""

import json
import subprocess
from pathlib import Path

import pytest

from zimit import zimit as app
from zimit.constants import (
    EXIT_CODE_CRAWLER_SIZE_LIMIT_HIT,
    EXIT_CODE_CRAWLER_TIME_LIMIT_HIT,
    NORMAL_WARC2ZIM_EXIT_CODE,
)


class FakeProgressWatcher:
    """Replace the inotify-based watcher, unavailable / not wanted in tests."""

    # simulate a progress update already written to the zimit progress file
    writes_progress = True

    def __init__(self, crawl_stats_path, warc2zim_stats_path, zimit_stats_path):
        self.crawl_stats_path = crawl_stats_path
        self.warc2zim_stats_path = warc2zim_stats_path
        self.zimit_stats_path = zimit_stats_path
        self.stopped = False

    def watch(self):
        self.crawl_stats_path.touch()
        self.warc2zim_stats_path.touch()
        if self.writes_progress:
            self.zimit_stats_path.write_text(json.dumps({"done": 4, "total": 8}))

    def stop(self):
        self.stopped = True


class FakeProgressWatcherWithoutFile(FakeProgressWatcher):
    """Watcher which never creates the zimit progress file."""

    writes_progress = False


def make_fake_warc2zim(conversion_result=None, conversion_error=None):
    """Build a warc2zim replacement.

    First call is zimit's argument validation (must return the "valid" exit code),
    second one is the actual conversion, whose outcome is what we want to simulate.
    """
    calls = []

    def fake_warc2zim(raw_args):
        calls.append(list(raw_args))
        if len(calls) == 1:
            return NORMAL_WARC2ZIM_EXIT_CODE
        if conversion_error is not None:
            raise conversion_error
        return conversion_result

    fake_warc2zim.calls = calls
    return fake_warc2zim


def make_fake_crawler(returncode):
    """Build a crawler replacement producing the expected WARC directory."""

    def fake_crawler(args, check=False):  # noqa: ARG001, FBT002
        cwd = Path(args[args.index("--cwd") + 1])
        (cwd / "collections" / "crawl-test" / "archive").mkdir(parents=True)
        return subprocess.CompletedProcess(args, returncode)

    return fake_crawler


def setup_run(
    monkeypatch,
    tmp_path,
    *,
    crawler_returncode=0,
    conversion_result=None,
    conversion_error=None,
    watcher_class=FakeProgressWatcher,
):
    progress_file = tmp_path / "task_progress.json"
    fake_warc2zim = make_fake_warc2zim(conversion_result, conversion_error)
    monkeypatch.setattr(app, "warc2zim", fake_warc2zim)
    monkeypatch.setattr(app, "ProgressFileWatcher", watcher_class)
    if crawler_returncode is not None:
        monkeypatch.setattr(
            app.subprocess, "run", make_fake_crawler(crawler_returncode)
        )
    return progress_file, fake_warc2zim


def run_zimit(tmp_path, *extra_args):
    return app.run(
        [
            "--seeds",
            "https://example.com",
            "--output",
            str(tmp_path),
            "--zimit-progress-file",
            str(tmp_path / "task_progress.json"),
            *extra_args,
        ]
    )


def read_progress(progress_file: Path):
    return json.loads(progress_file.read_text())


@pytest.mark.parametrize(
    "returncode,soft_limit_arg",
    [
        pytest.param(
            EXIT_CODE_CRAWLER_SIZE_LIMIT_HIT,
            ["--sizeSoftLimit", "1024"],
            id="size-soft-limit",
        ),
        pytest.param(
            EXIT_CODE_CRAWLER_TIME_LIMIT_HIT,
            ["--timeSoftLimit", "10"],
            id="time-soft-limit",
        ),
    ],
)
def test_partial_zim_soft_limit(monkeypatch, tmp_path, returncode, soft_limit_arg):
    """Soft limit hit: conversion continues and the ZIM is flagged as partial."""
    progress_file, fake_warc2zim = setup_run(
        monkeypatch, tmp_path, crawler_returncode=returncode
    )

    assert run_zimit(tmp_path, *soft_limit_arg) in (None, 0)

    # conversion did happen
    assert len(fake_warc2zim.calls) == 2
    content = read_progress(progress_file)
    assert content["partialZim"] is True
    # progress values are preserved
    assert content["done"] == 4
    assert content["total"] == 8


def test_partial_zim_false_on_success(monkeypatch, tmp_path):
    """Complete success: the ZIM is not flagged as partial."""
    progress_file, fake_warc2zim = setup_run(monkeypatch, tmp_path)

    assert run_zimit(tmp_path) in (None, 0)

    assert len(fake_warc2zim.calls) == 2
    content = read_progress(progress_file)
    assert content["partialZim"] is False
    assert content["done"] == 4
    assert content["total"] == 8


def test_partial_zim_true_on_crawler_failure(monkeypatch, tmp_path):
    """Crawler hard failure: exit code preserved and ZIM flagged as partial."""
    progress_file, fake_warc2zim = setup_run(
        monkeypatch, tmp_path, crawler_returncode=1
    )

    assert run_zimit(tmp_path) == 1

    # conversion is not attempted
    assert len(fake_warc2zim.calls) == 1
    content = read_progress(progress_file)
    assert content["partialZim"] is True


def test_partial_zim_true_on_conversion_failure(monkeypatch, tmp_path):
    """warc2zim failure: exit code preserved and ZIM flagged as partial."""
    progress_file, _ = setup_run(monkeypatch, tmp_path, conversion_result=4)

    assert run_zimit(tmp_path) == 4

    content = read_progress(progress_file)
    assert content["partialZim"] is True


def test_partial_zim_true_on_conversion_exception(monkeypatch, tmp_path):
    """warc2zim raising: exception propagated and ZIM flagged as partial."""
    progress_file, _ = setup_run(
        monkeypatch, tmp_path, conversion_error=RuntimeError("boom")
    )

    with pytest.raises(RuntimeError):
        run_zimit(tmp_path)

    content = read_progress(progress_file)
    assert content["partialZim"] is True


def test_no_error_when_progress_file_missing(monkeypatch, tmp_path):
    """No progress file: nothing is created and the exit code is preserved."""
    progress_file, _ = setup_run(
        monkeypatch,
        tmp_path,
        crawler_returncode=1,
        watcher_class=FakeProgressWatcherWithoutFile,
    )

    assert run_zimit(tmp_path) == 1

    assert not progress_file.exists()


def test_write_failure_does_not_mask_exit_code(monkeypatch, tmp_path):
    """Unreadable progress file: only a warning, exit code is preserved."""
    progress_file, _ = setup_run(monkeypatch, tmp_path, crawler_returncode=1)

    def fake_watch(self):
        # progress file exists but does not contain usable JSON
        self.zimit_stats_path.write_text("not json")

    monkeypatch.setattr(FakeProgressWatcher, "watch", fake_watch)

    assert run_zimit(tmp_path) == 1

    assert progress_file.read_text() == "not json"


def test_signal_sets_partial_zim(tmp_path, monkeypatch):
    """SIGINT/SIGTERM: partialZim is set and the exit code is still 3."""
    progress_file = tmp_path / "task_progress.json"
    progress_file.write_text(json.dumps({"done": 4, "total": 8}))
    monkeypatch.setattr(app, "current_zimit_stats_file", progress_file)

    with pytest.raises(SystemExit) as exc:
        app.sigint_handler(None, None)

    assert exc.value.code == 3
    content = read_progress(progress_file)
    assert content["partialZim"] is True
    assert content["done"] == 4
    assert content["total"] == 8


def test_signal_without_progress_file(tmp_path, monkeypatch):
    """SIGINT/SIGTERM without progress file: no file is created, exit code is 3."""
    progress_file = tmp_path / "task_progress.json"
    monkeypatch.setattr(app, "current_zimit_stats_file", progress_file)

    with pytest.raises(SystemExit) as exc:
        app.sigint_handler(None, None)

    assert exc.value.code == 3
    assert not progress_file.exists()


def test_interrupted_run_sets_partial_zim(monkeypatch, tmp_path):
    """Signal received during the run: partialZim set and exit code still 3."""
    progress_file, _ = setup_run(monkeypatch, tmp_path, crawler_returncode=0)

    def interrupted_crawler(args, check=False):  # noqa: ARG001, FBT002
        # simulate a SIGINT/SIGTERM received while the crawl is running
        app.sigint_handler(None, None)

    monkeypatch.setattr(app.subprocess, "run", interrupted_crawler)

    with pytest.raises(SystemExit) as exc:
        run_zimit(tmp_path)

    assert exc.value.code == 3
    content = read_progress(progress_file)
    assert content["partialZim"] is True
