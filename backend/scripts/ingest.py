"""Ingest job listings for all active companies or a single company board.

Usage:
  python scripts/ingest.py --all                        # all active companies
  python scripts/ingest.py <ats> <slug>                 # single company
  python scripts/ingest.py greenhouse airbnb
  python scripts/ingest.py lever netflix
  python scripts/ingest.py ashby linear

Flags:
  --force   Bypass the server-live check; concurrent runs risk dedup conflicts.
"""

import asyncio
import sys
import urllib.request

from app.config import settings
from app.database import get_session
from app.ingestion import INGESTERS
from app.ingestion.batch import CompanyOutcome
from app.scheduler import run_ingestion_locked


def _abort_if_server_live(*, force: bool) -> None:
    """Exit with a warning when the API server is reachable and --force was not passed."""
    if force:
        return
    try:
        with urllib.request.urlopen(f"{settings.API_URL}/health", timeout=2) as r:
            if r.status == 200:
                print(
                    "\u26a0  A JobDex server is running. Concurrent scripts risk noisy dedup "
                    "errors and double ATS traffic.\n"
                    "   Stop the server first, or pass --force to proceed anyway."
                )
                sys.exit(1)
    except Exception:
        pass  # server not reachable; safe to proceed


async def main() -> None:
    force = "--force" in sys.argv
    args = [a for a in sys.argv[1:] if a != "--force"]

    _abort_if_server_live(force=force)

    if len(args) == 1 and args[0] == "--all":
        # batch_size=0 overrides the scheduler's per-tick cap for a full seed pass. The
        # lock keeps this from overlapping a deployed instance crawling the same rows;
        # a locked-out run exits non-zero with a distinct status instead of doing nothing.
        summary = await run_ingestion_locked(0)
        if summary.lock_unavailable:
            print("Another ingestion run holds the lock. Wait for it to finish.")
            sys.exit(1)
        print(
            f"Batch status: {summary.status.value}  "
            f"targets={summary.total_targets}  succeeded={summary.succeeded}  "
            f"failed={summary.failed}  skipped={summary.skipped}"
        )
        print(
            f"Totals: new={summary.new_jobs} updated={summary.updated_jobs} "
            f"deactivated={summary.deactivated_jobs}"
        )
        if summary.failure_reasons:
            print(f"Failures by reason: {summary.failure_reasons}")
        for record in summary.records:
            if record.outcome is CompanyOutcome.FAILED:
                print(
                    f"  FAIL {record.slug} [{record.ats_type}]: "
                    f"{record.failure_reason.value if record.failure_reason else '?'}"
                )
        if summary.failed:
            sys.exit(1)
        return

    if len(args) == 2:
        ats, slug = args[0].lower(), args[1].lower()
        ingester = INGESTERS.get(ats)
        if not ingester:
            print(f"Unknown ATS '{ats}'. Valid options: {list(INGESTERS)}")
            sys.exit(1)

        print(f"Ingesting {slug} from {ats}...")
        try:
            with get_session() as db:
                result = await ingester.ingest(slug, db)
        except Exception as exc:
            # Transport errors now propagate after crawl_error is persisted; give the
            # operator a readable message instead of a traceback.
            print(f"Failed: {type(exc).__name__}: {exc}")
            sys.exit(1)
        print(
            f"Done: fetched={result.total_fetched} new={result.new_jobs} "
            f"updated={result.updated_jobs} deactivated={result.deactivated_jobs}"
        )
        if result.errors:
            print(f"Errors: {result.errors}")
        return

    print(
        "Usage: python scripts/ingest.py --all  "
        "OR  python scripts/ingest.py <ats> <slug>  "
        "[--force]"
    )
    sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
