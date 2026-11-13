"""Parse plex-backup logs into BackupRun records.

The server has two data sources:
1. /var/log/plex-backup-tracking.log - lightweight daily results (YYYY-MM-DD:success|failed)
2. /var/log/plex-backup.log - full rsync output (15GB+, impractical to parse fully)

Strategy:
- Primary: Parse the tracking file for historical backup records
- Detail: For the most recent backup(s), read the tail of the main log
  to extract transfer stats (sent/received bytes, total size)
- The tracking file is the reliable source; the main log adds optional detail

Every import returns an ImportReport: one outcome per date line (imported,
skipped because that local day already has a record, or ignored because the
date is invalid) with the statistics state of that day's record. The latest
report is stored in app settings for the Logs page, and a failed statistics
extraction is reported without rolling back the imported records.
"""

import json
import re
import shlex
import subprocess
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

from sqlalchemy.orm import Session as DBSession

from app.models.backup import BackupRun
from app.services import timefmt

IMPORT_REPORT_KEY = "log_import_report"

# The four statistics the main log can add to a day imported from the tracking file.
STATS_FIELDS = {
    "total_size": "total size",
    "transferred": "transferred bytes",
    "duration": "duration",
    "db_safe": "db_safe",
}

# Patterns for the main log file
BACKUP_START_RE = re.compile(r"=== Plex Backup Started: (.+?) ===")
BACKUP_SUCCESS_RE = re.compile(r"=== Plex Backup Completed Successfully: (.+?) ===")
BACKUP_FAILED_RE = re.compile(r"=== Plex Backup FAILED with code (\d+): (.+?) ===")
CLEANUP_START_RE = re.compile(r"=== Plex Snapshot Cleanup - (.+?) ====")
SNAPSHOT_RE = re.compile(r"Sunday detected - creating weekly snapshot")
SENT_BYTES_RE = re.compile(r"sent ([\d,]+) bytes\s+received ([\d,]+) bytes")
TOTAL_SIZE_RE = re.compile(r"total size is ([\d,]+)\s+speedup is")
DB_SAFE_RE = re.compile(r"--- Safe database snapshot: complete")

# Date format from the bash `date` command output
# e.g. "Mon Feb 23 03:13:23 AM EST 2026"
DATE_FORMATS = [
    "%a %b %d %I:%M:%S %p %Z %Y",
    "%a %b %d %H:%M:%S %Z %Y",
    "%a %b %d %I:%M:%S %p %Y",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d",
]


def _parse_date(date_str: str) -> Optional[datetime]:
    """Try multiple date formats to parse a date string."""
    date_str = date_str.strip()
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(date_str, fmt)
        except ValueError:
            continue
    return None


def _parse_comma_int(s: str) -> int:
    """Parse a comma-separated integer string like '24,265,611'."""
    return int(s.replace(",", ""))


# ---------- import report ----------

TRACKING_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


@dataclass
class DayOutcome:
    """What happened to one date line from the tracking file."""

    date_text: str
    day: Optional[date] = None
    outcome: str = "invalid"  # imported | skipped | invalid
    status: Optional[str] = None  # success | failure
    detail: str = ""  # why it was skipped or ignored
    records_created: int = 0  # the day's record plus attached snapshot/cleanup entries
    attached: List[str] = field(default_factory=list)  # snapshot, cleanup
    stats: Optional[Dict[str, bool]] = None  # total_size, transferred, duration, db_safe
    stats_added: bool = False  # this import run filled some of them
    stats_note: str = ""  # why statistics are missing or incomplete
    run_ref: Optional[BackupRun] = field(default=None, repr=False, compare=False)  # the day's record

    def to_dict(self) -> Dict:
        return {
            "date": self.date_text,
            "day": self.day.isoformat() if self.day else None,
            "outcome": self.outcome,
            "status": self.status,
            "detail": self.detail,
            "records_created": self.records_created,
            "attached": list(self.attached),
            "stats": self.stats,
            "stats_added": self.stats_added,
            "stats_note": self.stats_note,
        }


@dataclass(eq=False)
class ImportReport:
    """Per-day outcome of a tracking-file import, plus any statistics error."""

    days: List[DayOutcome] = field(default_factory=list)
    tracking_path: str = ""
    tracking_present: bool = True
    tracking_error: str = ""
    stats_path: Optional[str] = None
    stats_error: Optional[str] = None
    generated_at: str = ""

    @property
    def records_created(self) -> int:
        return sum(d.records_created for d in self.days)

    @property
    def imported_days(self) -> int:
        return sum(1 for d in self.days if d.outcome == "imported")

    @property
    def skipped_days(self) -> int:
        return sum(1 for d in self.days if d.outcome == "skipped")

    @property
    def ignored_lines(self) -> int:
        return sum(1 for d in self.days if d.outcome == "invalid")

    @property
    def stats_days(self) -> int:
        """Days whose record has at least one statistic."""
        return sum(1 for d in self.days if d.stats and any(d.stats.values()))

    @property
    def stats_added_days(self) -> int:
        """Days this import run filled statistics for (from the main log)."""
        return sum(1 for d in self.days if d.stats_added)

    @property
    def stats_complete_days(self) -> int:
        """Days whose record has all four statistics."""
        return sum(1 for d in self.days if d.stats and all(d.stats.values()))

    def summary(self) -> Dict:
        return {
            "imported": self.records_created,  # records created, attached entries included
            "imported_days": self.imported_days,
            "skipped": self.skipped_days,
            "ignored": self.ignored_lines,
            "stats_added": self.stats_added_days,
            "stats_days": self.stats_days,
            "stats_complete_days": self.stats_complete_days,
        }

    def to_dict(self) -> Dict:
        return {
            "days": [d.to_dict() for d in self.days],
            "summary": self.summary(),
            "tracking_path": self.tracking_path,
            "tracking_present": self.tracking_present,
            "tracking_error": self.tracking_error,
            "stats_path": self.stats_path,
            "stats_error": self.stats_error,
            "generated_at": self.generated_at,
        }

    def __bool__(self) -> bool:
        return bool(self.records_created)


def import_from_tracking_file(db: DBSession, tracking_path: str) -> ImportReport:
    """Import backup history from the lightweight tracking file.

    Format: YYYY-MM-DD:success|failed (one per line, last 30 days)
    These are daily backups that run at 3 AM via cron.

    Every date line gets an outcome: imported, skipped (that local day already
    has a daily_mirror/manual record), or invalid (the date is not YYYY-MM-DD).
    Sunday snapshot and cleanup rows are attached to the day's outcome rather
    than counted as separate dates.
    """
    path = Path(tracking_path)
    report = ImportReport(tracking_path=str(path))
    if not path.exists():
        report.tracking_present = False
        report.tracking_error = f"tracking file not found: {path}"
        return report

    tz = timefmt.zone(db)  # the tracking file and log lines are in local time; we store UTC
    days: Dict[date, DayOutcome] = {}  # one outcome per date (a duplicate line joins it)

    try:
        text = path.read_text(errors="replace")
    except OSError as exc:
        report.tracking_error = f"could not read the tracking file: {exc}"
        return report

    for raw_line in text.splitlines():
        line = raw_line.strip().lstrip("﻿")  # noqa: the tracking file may carry a BOM
        if not line:
            continue  # blank lines are not dates

        if ":" not in line:
            report.days.append(DayOutcome(
                date_text=line, detail=f"expected YYYY-MM-DD:success|failed, got {line!r}"))
            continue

        date_str, result = line.rsplit(":", 1)
        date_str = date_str.strip()
        if not TRACKING_DATE_RE.match(date_str):
            report.days.append(DayOutcome(
                date_text=date_str, detail=f"invalid date {date_str!r}; expected YYYY-MM-DD"))
            continue
        try:
            backup_date = datetime.strptime(date_str, "%Y-%m-%d")
        except ValueError:
            report.days.append(DayOutcome(
                date_text=date_str, detail=f"invalid date {date_str!r}"))
            continue

        local_start = backup_date.replace(hour=3, minute=0, second=0)
        started_at = timefmt.to_utc_naive(local_start, tz)
        status = "success" if result.strip() == "success" else "failure"

        outcome = DayOutcome(date_text=date_str, day=backup_date.date(), status=status)

        # A repeated line for a date already handled in this file is a duplicate.
        if backup_date.date() in days:
            prior = days[backup_date.date()]
            note = f"duplicate tracking line for {date_str} ignored"
            prior.detail = f"{prior.detail}; {note}" if prior.detail else note
            continue

        # Skip dates that already have a run (imported earlier, or launched by RePlexOn itself)
        day_start, day_end = timefmt.day_bounds_utc(backup_date.date(), tz)
        existing = (
            db.query(BackupRun)
            .filter(
                BackupRun.started_at >= day_start,
                BackupRun.started_at < day_end,
                BackupRun.backup_type.in_(("daily_mirror", "manual")),
            )
            .first()
        )
        if existing:
            outcome.outcome = "skipped"
            outcome.detail = (
                f"local day already has a {existing.backup_type} record (#{existing.id}, "
                f"{existing.status})"
            )
            outcome.run_ref = existing
            days[backup_date.date()] = outcome
            report.days.append(outcome)
            continue

        run = BackupRun(
            backup_type="daily_mirror",
            status=status,
            started_at=started_at,
            triggered_by="cron",
        )
        db.add(run)
        outcome.outcome = "imported"
        outcome.records_created = 1
        outcome.run_ref = run

        # If Sunday, also create a snapshot entry
        if local_start.weekday() == 6 and status == "success":
            snap_at = timefmt.to_utc_naive(local_start.replace(minute=30), tz)
            cleanup_at = timefmt.to_utc_naive(local_start.replace(hour=4), tz)
            snap_existing = (
                db.query(BackupRun)
                .filter(
                    BackupRun.started_at == snap_at,
                    BackupRun.backup_type == "snapshot",
                )
                .first()
            )
            if not snap_existing:
                snap = BackupRun(
                    backup_type="snapshot",
                    status="success",
                    started_at=snap_at,
                    triggered_by="cron",
                )
                db.add(snap)
                outcome.records_created += 1
                outcome.attached.append("snapshot")

            # Also a cleanup entry at 4 AM
            cleanup_existing = (
                db.query(BackupRun)
                .filter(
                    BackupRun.started_at == cleanup_at,
                    BackupRun.backup_type == "cleanup",
                )
                .first()
            )
            if not cleanup_existing:
                cleanup = BackupRun(
                    backup_type="cleanup",
                    status="success",
                    started_at=cleanup_at,
                    triggered_by="cron",
                )
                db.add(cleanup)
                outcome.records_created += 1
                outcome.attached.append("cleanup")

        days[backup_date.date()] = outcome
        report.days.append(outcome)

    if report.records_created:
        db.commit()
    return report


@dataclass
class StatsExtraction:
    """Result of extract_stats_file(): a cache path or the reason there is none."""

    path: Optional[str]
    error: Optional[str] = None

    def __bool__(self) -> bool:
        return self.path is not None

    def __str__(self) -> str:
        return str(self.path) if self.path else (self.error or "")


def extract_stats_file(log_path: str, timeout: int = 300) -> StatsExtraction:
    """Extract marker/stats lines from the main log into a small cache file.

    Uses grep -F with multiple fixed-string patterns to quickly scan the
    15GB+ log file. The result is cached in the app's data directory.
    Returns a StatsExtraction carrying the cache path, or why extraction failed.
    """
    from app.config import settings
    data_dir = Path(settings.data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    extract_path = str(data_dir / "plex-backup-stats.txt")

    if not Path(log_path).exists():
        return StatsExtraction(None, f"main log not found: {log_path}")

    # Use grep with fixed strings piped through grep -E for speed.
    # grep -F is much faster than grep -E on large files.
    # We grep for lines containing any of our marker strings.
    # pipefail surfaces a missing/erroring first grep (a bare pipeline would
    # report only the last grep's status).
    try:
        result = subprocess.run(
            ["bash", "-c",
             "set -o pipefail; "
             f"grep -F -e '=== Plex Backup' -e 'total size is' -e 'sent ' -e 'Safe database snapshot: complete' {shlex.quote(str(log_path))} "
             f"| grep -E '=== Plex Backup (Started|Completed|FAILED)|sent .* bytes.*received|total size is .* speedup|Safe database snapshot: complete' "
             f"> {shlex.quote(extract_path)}"],
            capture_output=True, text=True, timeout=timeout,
            encoding="utf-8", errors="replace",  # log paths/locale must not break decoding
        )
        # grep returns 1 if no matches - that's ok, but it must still have
        # created the (possibly empty) extract. A broken shell also exits 1.
        if result.returncode not in (0, 1):
            return StatsExtraction(None, _grep_reason(result))
        if not Path(extract_path).exists():
            stderr = (result.stderr or "").strip()
            reason = f"grep produced no extract file (exit {result.returncode})"
            if stderr:
                reason += f": {stderr.splitlines()[-1][:200]}"
            return StatsExtraction(None, reason)
        return StatsExtraction(extract_path, None)
    except subprocess.TimeoutExpired:
        return StatsExtraction(None, f"grep timed out after {timeout}s")
    except FileNotFoundError:
        return StatsExtraction(None, "bash not available (command missing: bash)")
    except OSError as exc:
        return StatsExtraction(None, f"could not run grep: {exc}")


def _grep_reason(result) -> str:
    stderr = (result.stderr or "").strip()
    if result.returncode == 127 or "not found" in stderr or "command not found" in stderr:
        reason = f"grep command not found (exit {result.returncode})"
    else:
        reason = f"grep failed (exit {result.returncode})"
    if stderr:
        reason += f": {stderr.splitlines()[-1][:200]}"
    return reason


def parse_marker_lines(text: str) -> List[Dict]:
    """Backup entries (start, end, status, sent, total_size, db_safe) from log marker lines."""
    entries = []  # type: List[Dict]
    current = {}  # type: Dict

    for line in text.splitlines():
        m = BACKUP_START_RE.search(line)
        if m:
            current = {"start": _parse_date(m.group(1))}
            continue

        if not current:
            continue

        if DB_SAFE_RE.search(line):
            current["db_safe"] = True
            continue

        m = SENT_BYTES_RE.search(line)
        if m:
            # Keep the last sent/total pair (Sunday has 2 rsync runs)
            current["sent"] = _parse_comma_int(m.group(1))

        m = TOTAL_SIZE_RE.search(line)
        if m:
            current["total_size"] = _parse_comma_int(m.group(1))

        m = BACKUP_SUCCESS_RE.search(line)
        if m:
            current["end"] = _parse_date(m.group(1))
            current["status"] = "success"
            entries.append(current)
            current = {}

        m = BACKUP_FAILED_RE.search(line)
        if m:
            current["end"] = _parse_date(m.group(2))
            current["status"] = "failure"
            entries.append(current)
            current = {}
    return entries


def enrich_from_stats(db: DBSession, stats_path: str, report: Optional[ImportReport] = None) -> int:
    """Read an extracted stats file and enrich backup records.

    The stats file contains just the marker lines from the main log,
    produced by extract_stats_file() or the import-logs CLI command.

    With a report, each of its day outcomes gets the per-field statistics
    state of that day's record, and the reason when they are missing.
    """
    path = Path(stats_path)
    if not path.exists():
        if report is not None and not report.stats_error:
            report.stats_error = f"stats extract not found: {path}"
        _annotate_stats(report, None)
        return 0

    text = path.read_text()
    if not text.strip():
        if report is not None:
            report.stats_error = "stats extract is empty"
        _annotate_stats(report, {})
        return 0

    entries = parse_marker_lines(text)
    by_day: Dict[date, Dict] = {}
    for entry in entries:
        start = entry.get("start")
        if start:
            by_day[start.date()] = entry  # last entry for a day wins

    # Now enrich database records with the extracted data (log lines are local time)
    tz = timefmt.zone(db)
    updated = 0
    for entry in entries:
        start = entry.get("start")
        if not start:
            continue

        # Find matching daily_mirror record for this local date
        local_date = start.date()
        day_start, day_end = timefmt.day_bounds_utc(local_date, tz)
        start = timefmt.to_utc_naive(start.replace(tzinfo=None), tz)
        run = (
            db.query(BackupRun)
            .filter(
                BackupRun.backup_type == "daily_mirror",
                BackupRun.started_at >= day_start,
                BackupRun.started_at < day_end,
            )
            .first()
        )
        if not run:
            continue

        total_size = entry.get("total_size")
        sent = entry.get("sent")
        end = entry.get("end")
        end = timefmt.to_utc_naive(end.replace(tzinfo=None), tz) if end else None

        before = (run.total_size_bytes, run.transferred_bytes, run.duration_seconds, run.db_safe)
        if total_size and not run.total_size_bytes:
            run.total_size_bytes = total_size
        if sent and not run.transferred_bytes:
            run.transferred_bytes = sent
        if start and end and not run.duration_seconds:
            run.duration_seconds = (end - start).total_seconds()
            run.finished_at = end
        if run.db_safe is None:
            run.db_safe = entry.get("db_safe", False)
        after = (run.total_size_bytes, run.transferred_bytes, run.duration_seconds, run.db_safe)
        if after != before:
            updated += 1
            if report is not None:
                _mark_stats_added(report, local_date)  # the day is the local date, not the UTC one

    if updated:
        db.commit()

    if report is not None:
        _annotate_stats(report, by_day)
    return updated


def _mark_stats_added(report: ImportReport, day: date) -> None:
    for outcome in report.days:
        if outcome.day == day and outcome.outcome in ("imported", "skipped"):
            outcome.stats_added = True


def _annotate_stats(report: Optional[ImportReport], by_day: Optional[Dict[date, Dict]]) -> None:
    """Fill each day's statistics state (and the reason when incomplete).

    ``by_day`` is the log entry per local date, or None when extraction failed.
    """
    if report is None:
        return
    for outcome in report.days:
        run = outcome.run_ref
        if outcome.outcome == "invalid":
            outcome.stats = None
            outcome.stats_note = ""
            continue
        if outcome.day is None or run is None:
            outcome.stats = None
            outcome.stats_note = "no statistics (no record for this date)"
            continue

        entry = by_day.get(outcome.day) if by_day is not None else None
        # Enrichment writes db_safe=False when the log has no DB-safe marker, so only
        # the marker itself proves it was supplied. A skipped day keeps a record made
        # by a live run, where db_safe=True was set by the runner.
        db_safe = bool(entry.get("db_safe")) if entry is not None else run.db_safe is not None
        if not db_safe and outcome.outcome == "skipped" and run.db_safe is True:
            db_safe = True
        stats = {
            "total_size": run.total_size_bytes is not None,
            "transferred": run.transferred_bytes is not None,
            "duration": run.duration_seconds is not None,
            "db_safe": db_safe,
        }
        outcome.stats = stats
        if all(stats.values()):
            outcome.stats_note = ""
        elif by_day is None:
            outcome.stats_note = report.stats_error or "statistics extraction failed"
        elif entry is None:
            outcome.stats_note = "no matching marker lines for this date in the main log"
        else:
            missing = [label for key, label in STATS_FIELDS.items() if not stats[key]]
            outcome.stats_note = "not filled from the main log: " + ", ".join(missing)


def _tracking_path(log_path: str) -> str:
    return log_path.replace("plex-backup.log", "plex-backup-tracking.log")


def _cached_stats_path() -> str:
    from app.config import settings
    return str(Path(settings.data_dir) / "plex-backup-stats.txt")


def save_report(db: DBSession, report: ImportReport) -> None:
    """Keep the latest per-day result for the Logs page (settings table, one JSON value)."""
    from app.models.setting import AppSetting
    payload = json.dumps(report.to_dict(), ensure_ascii=False)
    row = db.query(AppSetting).filter(AppSetting.key == IMPORT_REPORT_KEY).first()
    if row:
        row.value = payload
    else:
        db.add(AppSetting(key=IMPORT_REPORT_KEY, value=payload))
    db.commit()


def load_report(db: DBSession) -> Optional[Dict]:
    """The latest import report as a dict, or None before the first import."""
    from app.services.app_settings import get_setting
    raw = get_setting(db, IMPORT_REPORT_KEY)
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None


def run_import(
    db: DBSession,
    log_path: str,
    extraction: Optional[StatsExtraction] = None,
    report: Optional[ImportReport] = None,
    save: bool = True,
) -> ImportReport:
    """Import the tracking file and add statistics, returning the per-day result.

    ``extraction`` is a result from extract_stats_file(). Without it, a
    previously extracted cache file is used, and its absence (or the
    extraction's failure) is recorded as the statistics error. ``save=False``
    keeps the per-day result in memory but leaves the stored report alone
    (the background poller does this when it found nothing new).

    A failed statistics extraction never rolls back imported day records: the
    tracking import commits first and the report says why statistics are missing.
    """
    if report is None:
        report = import_from_tracking_file(db, _tracking_path(log_path))

    if extraction is not None:
        report.stats_path = extraction.path
        report.stats_error = extraction.error
    else:
        cached = _cached_stats_path()
        if Path(cached).exists():
            report.stats_path = cached
        else:
            report.stats_error = (
                "statistics were not extracted yet "
                "(run the import-logs command or wait for the next poll)"
            )

    try:
        if report.stats_path:
            enrich_from_stats(db, report.stats_path, report)
        else:
            _annotate_stats(report, None)
    except Exception as exc:  # never lose the imported days over a stats problem
        db.rollback()
        report.stats_error = f"statistics enrichment failed: {exc}"
        _annotate_stats(report, None)

    report.generated_at = datetime.now(timezone.utc).isoformat()
    # Store the result when it is new information: records or statistics were added,
    # or this is the first report. A repeated poll over the same days would only
    # replace the useful report with a page full of "skipped" rows, and installs
    # without a tracking file get no empty report card.
    if save and report.tracking_present and (
        report.records_created or report.stats_added_days or load_report(db) is None
    ):
        try:
            save_report(db, report)
        except Exception:  # the report is diagnostic; the import itself stands
            db.rollback()
    return report


def parse_full_log(db: DBSession, log_path: str, extraction: Optional[StatsExtraction] = None) -> ImportReport:
    """Full import: use tracking file + enrich from extracted stats.

    This is the main entry point called on startup.
    Enrichment uses a pre-extracted stats file if available.
    """
    return run_import(db, log_path, extraction=extraction)


def parse_incremental(db: DBSession, log_path: str) -> ImportReport:
    """Incremental update: re-read tracking file for new entries.

    Called periodically by the background poller. Statistics are re-extracted
    only when there are new entries (grep on a 15GB log is slow). With nothing
    new, the stored per-day report is left as it is, so the Logs page keeps
    showing the last real import rather than a page full of "skipped" days.
    """
    report = import_from_tracking_file(db, _tracking_path(log_path))
    if report.records_created:
        return run_import(db, log_path, extraction=extract_stats_file(log_path), report=report)
    return run_import(db, log_path, report=report, save=False)


IMPORT_TIMES_FLAG = "import_times_utc_v1"
_STORED_FMT = "%Y-%m-%d %H:%M:%S.%f"


def migrate_import_times(db: DBSession) -> int:
    """One-time fix: 1.x-imported rows stored local wall-clock time as if it were UTC.

    Those rows are triggered_by='cron' with whole-second times ('... 03:00:00.000000'); 2.x rows
    have real microseconds. Converts them local -> UTC in the zone in effect now, in one
    transaction, after copying the SQLite file to <db>.pre-tzfix. Returns the rows converted.
    """
    from sqlalchemy import text
    from app.services.app_settings import get_setting, set_setting

    if get_setting(db, IMPORT_TIMES_FLAG):
        return 0
    rows = db.execute(text(
        "SELECT id, started_at, finished_at FROM backup_runs "
        "WHERE triggered_by = 'cron' AND started_at LIKE '%.000000'")).all()
    if not rows:
        set_setting(db, IMPORT_TIMES_FLAG, "1")
        return 0

    _backup_sqlite(db, ".pre-tzfix")
    tz = timefmt.zone(db)

    def fix(value):
        if not isinstance(value, str) or not value.endswith(".000000"):
            return value
        try:
            local = datetime.strptime(value, _STORED_FMT)
        except ValueError:
            return value  # odd value: leave it alone
        return timefmt.to_utc_naive(local, tz).strftime(_STORED_FMT)  # fold=0 for DST edge times

    try:
        for row_id, started, finished in rows:
            db.execute(text("UPDATE backup_runs SET started_at = :s, finished_at = :f WHERE id = :i"),
                       {"s": fix(started), "f": fix(finished), "i": row_id})
        from app.models.setting import AppSetting
        db.merge(AppSetting(key=IMPORT_TIMES_FLAG, value="1"))
        db.commit()
    except Exception:
        db.rollback()
        raise
    return len(rows)


def _backup_sqlite(db: DBSession, suffix: str) -> None:
    """Consistent copy (WAL included) of the SQLite file next to itself, once."""
    import sqlite3
    path = db.get_bind().url.database
    if not path or path == ":memory:" or Path(path + suffix).exists():
        return
    src, dst = sqlite3.connect(path), sqlite3.connect(path + suffix)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
