import asyncio
from datetime import UTC, datetime, timedelta

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from loguru import logger
from sqlalchemy import or_

from app.config import settings
from app.database import (
    LOCK_DISCOVER,
    LOCK_ENRICH,
    LOCK_INGEST,
    advisory_lock,
    get_session,
)
from app.enrichment import enrich_company
from app.ingestion import INGESTERS
from app.ingestion.batch import (
    BatchStatus,
    IngestionBatchSummary,
    run_ingestion_batch,
)
from app.models import Company

scheduler = AsyncIOScheduler(timezone="UTC")


async def run_ingestion(batch_size: int | None = None) -> IngestionBatchSummary:
    """Crawl the least recently crawled batch of active companies and report every outcome.

    Ordering by last_crawled_at makes the company table a rotating queue, so a bounded
    batch per tick still reaches every company. Companies that fail keep their old
    last_crawled_at (the ingester never reaches the success-path timestamp update), so
    they are picked up first next time; successful companies advance as usual. Pass
    batch_size=0 for a full pass, as the seed scripts do.
    """
    limit = settings.INGEST_BATCH_SIZE if batch_size is None else batch_size
    return await run_ingestion_batch(
        batch_size=limit,
        session_factory=get_session,
        ingesters=INGESTERS,
    )


async def run_ingestion_tick() -> IngestionBatchSummary:
    """Scheduler entry point: skip cleanly when another replica holds the advisory lock.

    A lock-skipped tick returns a summary with status ``lock_unavailable`` and no
    records, which callers can distinguish from a run where individual companies
    failed. No company timestamp is touched in that case.
    """
    with advisory_lock(LOCK_INGEST) as acquired:
        if not acquired:
            logger.info("[scheduler] ingest already running elsewhere; skipping tick")
            return IngestionBatchSummary(
                status=BatchStatus.LOCK_UNAVAILABLE,
                batch_size=settings.INGEST_BATCH_SIZE,
            )
        return await run_ingestion()


async def run_ingestion_locked(batch_size: int) -> IngestionBatchSummary:
    """Run an ingestion batch under the advisory lock, for one-off scripted runs.

    Same lock semantics as the scheduled tick (a held lock yields a ``lock_unavailable``
    summary instead of waiting), but lets callers such as the seed script override the
    per-tick batch cap -- notably batch_size=0 for a full pass.
    """
    with advisory_lock(LOCK_INGEST) as acquired:
        if not acquired:
            return IngestionBatchSummary(
                status=BatchStatus.LOCK_UNAVAILABLE,
                batch_size=batch_size,
            )
        return await run_ingestion(batch_size=batch_size)


async def run_enrichment() -> None:
    """Enrich pending companies with Wikidata/Wikipedia data; re-enriches after ENRICH_REFRESH_DAYS."""
    logger.info("[scheduler] enrichment run started")
    enriched = 0
    errors = 0
    cutoff = datetime.now(UTC) - timedelta(days=settings.ENRICH_REFRESH_DAYS)

    with get_session() as db:
        slugs = [
            company.slug
            for company in db.query(Company)
            .filter(
                Company.is_active.is_(True),
                or_(
                    Company.enriched_at.is_(None),
                    Company.enriched_at < cutoff,
                ),
            )
            .order_by(Company.enriched_at.asc().nullsfirst(), Company.name)
            .all()
        ]

    if not slugs:
        logger.info("[scheduler] enrichment complete: nothing pending")
        return

    for slug in slugs:
        try:
            with get_session() as db:
                await enrich_company(slug, db)
            enriched += 1
        except Exception as exc:
            logger.warning(f"[scheduler] enrichment failed for {slug}: {exc}")
            errors += 1
        await asyncio.sleep(settings.ENRICHMENT_STEP_DELAY)

    logger.info(f"[scheduler] enrichment complete: enriched={enriched} errors={errors}")


async def run_discovery() -> None:
    """Register new companies from ingesters that support bulk discovery."""
    logger.info("[scheduler] discovery run started")
    added = 0
    skipped = 0

    for ats_name, ingester in INGESTERS.items():
        logger.info(f"[scheduler] discovering from {ats_name}")
        try:
            stubs = await ingester.discover()
        except Exception as exc:
            logger.warning(f"[scheduler] discovery failed for {ats_name}: {exc}")
            continue

        if not stubs:
            logger.info(f"[scheduler] {ats_name}: no stubs returned")
            continue

        stub_slugs = [s.slug for s in stubs]
        with get_session() as db:
            existing_slugs = {
                row.slug
                for row in db.query(Company.slug).filter(Company.slug.in_(stub_slugs)).all()
            }
            new_stubs = [s for s in stubs if s.slug not in existing_slugs]
            for stub in new_stubs:
                db.add(stub)
            db.commit()
        added += len(new_stubs)
        skipped += len(stubs) - len(new_stubs)
        logger.info(
            f"[scheduler] {ats_name}: {len(stubs)} found  "
            f"{len(new_stubs)} new  {len(stubs) - len(new_stubs)} skipped"
        )

    logger.info(f"[scheduler] discovery complete: added={added} skipped={skipped}")


async def _run_locked(name: str, key: int, job) -> None:
    """Run a scheduled job only if no other replica currently holds its advisory lock.

    max_instances=1 only guards against overlap inside one process. Every replica runs
    its own scheduler, so without this each tick would fire once per replica and the
    concurrent writes would collide on the unique dedup_hash index.
    """
    with advisory_lock(key) as acquired:
        if not acquired:
            logger.info(f"[scheduler] {name} already running elsewhere; skipping tick")
            return
        await job()


def start() -> None:
    """Register scheduled jobs and start the background scheduler."""
    scheduler.add_job(
        run_ingestion_tick,
        "interval",
        minutes=settings.INGEST_INTERVAL_MINUTES,
        id="ingest_all",
        max_instances=1,
    )
    scheduler.add_job(
        _run_locked,
        "interval",
        hours=settings.ENRICH_INTERVAL_HOURS,
        args=["enrich", LOCK_ENRICH, run_enrichment],
        id="enrich_pending",
        max_instances=1,
    )
    scheduler.add_job(
        _run_locked,
        "interval",
        hours=settings.DISCOVER_INTERVAL_HOURS,
        args=["discover", LOCK_DISCOVER, run_discovery],
        id="discover_companies",
        max_instances=1,
    )
    scheduler.start()
    logger.info(
        f"[scheduler] started: ingest every {settings.INGEST_INTERVAL_MINUTES}m "
        f"({settings.INGEST_BATCH_SIZE or 'all'} companies per tick), "
        f"enrich every {settings.ENRICH_INTERVAL_HOURS}h, "
        f"discover every {settings.DISCOVER_INTERVAL_HOURS}h"
    )


def stop() -> None:
    """Shut down the scheduler cleanly."""
    if scheduler.running:
        scheduler.shutdown(wait=False)
        logger.info("[scheduler] stopped")
