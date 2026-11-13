"""Tracking-file import: every date line gets an outcome, with statistics or the reason they are missing."""
from datetime import datetime

import pytest

from app.models.backup import BackupRun
from app.services import app_settings, timefmt
from app.services.log_parser import (
    StatsExtraction,
    extract_stats_file,
    import_from_tracking_file,
    load_report,
    run_import,
)
from tests.test_setup_flow import admin, client, no_lifespan  # noqa: F401  (fixtures)

UTC = "UTC"


@pytest.fixture
def tracking(tmp_path):
    """A tracking file named the way run_import() derives it from the main log path."""
    log = tmp_path / "plex-backup.log"
    path = tmp_path / "plex-backup-tracking.log"
    log.write_text("")  # exists, so a missing-extract reason is not "log not found"
    return log, path


@pytest.fixture
def utc_zone(db):
    app_settings.set_setting(db, "timezone", UTC)
    timefmt.reset()
    return timefmt.zone(db)


def _marker_block(day, start="03:00:00", end="03:15:00", failed=False):
    """The four marker lines parse_marker_lines() knows, in local time."""
    lines = [
        f"=== Plex Backup Started: {day} {start} ===",
        "--- Safe database snapshot: complete (4 databases, 12s) ---",
        "sent 24,265,611 bytes  received 1,004 bytes  161,777.43 bytes/sec",
        "total size is 123,456,789  speedup is 5.08",
    ]
    if failed:
        lines.append(f"=== Plex Backup FAILED with code 23: {day} {end} ===")
    else:
        lines.append(f"=== Plex Backup Completed Successfully: {day} {end} ===")
    return "\n".join(lines) + "\n"


def _by_day(report):
    return {d.day: d for d in report.days}


def test_import_adds_stats_and_attaches_sunday_entries(db, utc_zone, tracking, tmp_path):
    log, path = tracking
    path.write_text("2026-10-08:success\n2026-10-11:success\n")
    stats = tmp_path / "stats.txt"
    stats.write_text(_marker_block("2026-10-08") + _marker_block("2026-10-11"))
    log.write_text(stats.read_text())

    report = run_import(db, str(log), extraction=StatsExtraction(str(stats)))

    days = _by_day(report)
    assert set(days) == {datetime(2026, 10, 8).date(), datetime(2026, 10, 11).date()}
    thursday, sunday = days[datetime(2026, 10, 8).date()], days[datetime(2026, 10, 11).date()]

    assert thursday.outcome == "imported" and thursday.records_created == 1
    assert thursday.stats == {"total_size": True, "transferred": True, "duration": True, "db_safe": True}
    assert thursday.stats_note == ""

    # Sunday's snapshot and cleanup belong to the Sunday row, not separate rows.
    assert sunday.outcome == "imported"
    assert sunday.records_created == 3
    assert sunday.attached == ["snapshot", "cleanup"]

    assert report.summary() == {
        "imported": 4, "imported_days": 2, "skipped": 0, "ignored": 0,
        "stats_added": 2, "stats_days": 2, "stats_complete_days": 2,
    }
    assert report.stats_error is None

    run = db.query(BackupRun).filter(BackupRun.backup_type == "daily_mirror").first()
    assert (run.total_size_bytes, run.transferred_bytes, run.db_safe) == (123456789, 24265611, True)
    assert run.duration_seconds == 900
    assert run.started_at == datetime(2026, 10, 8, 3, 0)
    db.refresh(run)

    # The same result is what the Logs page reads back.
    saved = load_report(db)
    assert saved["summary"]["imported"] == 4
    assert {d["day"] for d in saved["days"]} == {"2026-10-08", "2026-10-11"}
    assert saved["days"][1]["attached"] == ["snapshot", "cleanup"]


def test_day_with_existing_record_is_skipped(db, utc_zone, tracking):
    log, path = tracking
    path.write_text("2026-10-08:success\n2026-10-09:failed\n")
    db.add(BackupRun(backup_type="manual", status="success", started_at=datetime(2026, 10, 9, 12, 0),
                     triggered_by="manual"))
    db.commit()

    report = import_from_tracking_file(db, str(path))

    days = _by_day(report)
    assert days[datetime(2026, 10, 8).date()].outcome == "imported"
    skipped = days[datetime(2026, 10, 9).date()]
    assert skipped.outcome == "skipped"
    assert "already has a manual record" in skipped.detail
    assert report.summary()["imported"] == 1 and report.summary()["skipped"] == 1
    assert db.query(BackupRun).filter(BackupRun.backup_type == "daily_mirror").count() == 1

    # Re-importing changes nothing and reports the already-present day as skipped.
    again = import_from_tracking_file(db, str(path))
    assert again.summary()["imported"] == 0 and again.summary()["skipped"] == 2
    assert db.query(BackupRun).count() == 2


def test_invalid_date_lines_are_ignored(db, utc_zone, tracking):
    log, path = tracking
    path.write_text("2026-10-08:success\nnot-a-date:success\n2026-13-40:failed\n2026/10/09:success\n")

    report = import_from_tracking_file(db, str(path))

    assert report.summary() == {
        "imported": 1, "imported_days": 1, "skipped": 0, "ignored": 3,
        "stats_added": 0, "stats_days": 0, "stats_complete_days": 0,
    }
    invalid = [d for d in report.days if d.outcome == "invalid"]
    assert [d.date_text for d in invalid] == ["not-a-date", "2026-13-40", "2026/10/09"]
    assert all("invalid date" in d.detail or "expected" in d.detail for d in invalid)
    assert db.query(BackupRun).count() == 1


def test_stats_extraction_failure_keeps_imported_days(db, utc_zone, tracking, monkeypatch):
    import subprocess

    log, path = tracking
    path.write_text("2026-10-08:success\n2026-10-09:failed\n")

    def timeout(*_args, **_kwargs):
        raise subprocess.TimeoutExpired(cmd="grep", timeout=300)

    monkeypatch.setattr(subprocess, "run", timeout)
    extraction = extract_stats_file(str(log))
    assert not extraction
    assert "timed out" in extraction.error

    report = run_import(db, str(log), extraction=extraction)

    assert report.records_created == 2  # the import stands
    assert db.query(BackupRun).count() == 2
    assert report.stats_error and "timed out" in report.stats_error
    for day in report.days:
        assert day.outcome == "imported"
        assert day.stats == {"total_size": False, "transferred": False,
                             "duration": False, "db_safe": False}
        assert "timed out" in day.stats_note


def test_missing_grep_is_reported_per_day(db, utc_zone, tracking, monkeypatch):
    log, path = tracking
    path.write_text("2026-10-08:success\n")

    def missing(*_args, **_kwargs):
        raise FileNotFoundError("bash")

    monkeypatch.setattr("subprocess.run", missing)
    extraction = extract_stats_file(str(log))
    assert "command missing" in extraction.error

    report = run_import(db, str(log), extraction=extraction)
    assert report.records_created == 1
    assert "command missing" in report.stats_error
    assert "command missing" in report.days[0].stats_note
    assert db.query(BackupRun).one().status == "success"


def test_broken_shell_that_exits_one_is_not_mistaken_for_no_matches(db, utc_zone, tracking, monkeypatch):
    """grep exits 1 both for "no matches" and for a broken shell; only the first is fine."""
    import subprocess as sp
    log, path = tracking
    path.write_text("2026-10-08:success\n")

    def broken(cmd, **_kwargs):
        return sp.CompletedProcess(cmd, 1, stdout="", stderr="execvpe(/bin/bash) failed")

    monkeypatch.setattr(sp, "run", broken)
    extraction = extract_stats_file(str(log))
    assert not extraction
    assert "no extract file" in extraction.error and "execvpe" in extraction.error

    report = run_import(db, str(log), extraction=extraction)
    assert report.records_created == 1 and db.query(BackupRun).count() == 1
    assert "no extract file" in report.days[0].stats_note


def test_partial_stats_are_counted_and_explained(db, utc_zone, tracking, tmp_path):
    log, path = tracking
    path.write_text("2026-10-08:success\n")
    # A started block without the rsync total-size line.
    stats = tmp_path / "stats.txt"
    stats.write_text(
        "=== Plex Backup Started: 2026-10-08 03:00:00 ===\n"
        "sent 10 bytes  received 5 bytes  1.00 bytes/sec\n"
        "=== Plex Backup Completed Successfully: 2026-10-08 03:00:30 ===\n"
    )

    report = run_import(db, str(log), extraction=StatsExtraction(str(stats)))

    day = report.days[0]
    assert day.stats == {"total_size": False, "transferred": True,
                         "duration": True, "db_safe": False}
    assert "total size" in day.stats_note and "db_safe" in day.stats_note
    assert report.summary()["stats_days"] == 1
    assert report.summary()["stats_complete_days"] == 0


def test_repeated_import_does_not_duplicate_records(db, utc_zone, tracking, tmp_path):
    log, path = tracking
    path.write_text("2026-10-08:success\n2026-10-11:success\n")
    stats = tmp_path / "stats.txt"
    stats.write_text(_marker_block("2026-10-08") + _marker_block("2026-10-11"))

    first = run_import(db, str(log), extraction=StatsExtraction(str(stats)))
    second = run_import(db, str(log), extraction=StatsExtraction(str(stats)))

    assert first.summary()["imported"] == 4
    assert second.summary()["imported"] == 0
    assert second.summary()["skipped"] == 2
    assert db.query(BackupRun).count() == 4


def test_logs_page_shows_the_per_day_report(client, tmp_path):
    from app.database import SessionLocal

    admin(client)
    db = SessionLocal()
    try:
        app_settings.set_setting(db, "setup_complete", "1")
        app_settings.set_setting(db, "timezone", UTC)
        timefmt.reset()
        log = tmp_path / "plex-backup.log"
        log.write_text("")
        (tmp_path / "plex-backup-tracking.log").write_text(
            "2026-10-08:success\n2026-10-09:failed\nbad-line:success\n")
        db.add(BackupRun(backup_type="daily_mirror", status="success",
                         started_at=datetime(2026, 10, 9, 3, 0), triggered_by="cron"))
        db.commit()
        stats = tmp_path / "stats.txt"
        stats.write_text(_marker_block("2026-10-08"))
        run_import(db, str(log), extraction=StatsExtraction(str(stats)))
    finally:
        db.close()

    page = client.get("/logs").text
    assert "Tracking File Import" in page
    assert "2026-10-08" in page and "2026-10-09" in page and "bad-line" in page
    assert "new" in page and "skipped" in page and "ignored" in page
    # The summary counts: 1 record imported, 1 day skipped, 1 line ignored.
    assert "1 new record" in page and "1 skipped" in page and "1 ignored" in page
    assert "1 day with stats" in page
    assert "stats added" in page or "added now" in page


def test_poll_with_nothing_new_leaves_the_stored_report_alone(db, utc_zone, tracking):
    from app.services.log_parser import parse_incremental

    log, path = tracking
    path.write_text("2026-10-08:success\n")
    first = parse_incremental(db, str(log))
    assert first.records_created == 1
    stored = load_report(db)
    assert stored["summary"]["imported"] == 1

    again = parse_incremental(db, str(log))  # e.g. the 60-second poller
    assert again.records_created == 0 and again.skipped_days == 1
    assert load_report(db) == stored  # the page keeps the last real import
    assert db.query(BackupRun).count() == 1
