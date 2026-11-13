# Scraper System

## Navigation

- [Architecture](Architecture.md)
- [API](API.md)
- [Database](Database.md)
- [Deployment](Deployment.md)

## Overview

HackDekh uses a modular scraper system to normalize hackathon listings from supported external sources and store them in MongoDB.

## Supported Sources

| Source | Notes |
| --- | --- |
| Devfolio | Supported scraper and manual trigger route |
| Unstop | Supported scraper and manual trigger route |
| Devpost | Supported scraper and manual trigger route |
| MLH | Supported scraper and manual trigger route |
| Hack2Skill | Supported scraper and manual trigger route |

## Refresh Flow

1. A scraper fetches source-specific listings.
2. The scraper normalizes the data into the hackathon schema.
3. Existing records are deduplicated using the model-level uniqueness constraints.
4. The nightly cron job refreshes the full set at 3:00 AM.

## Trigger Paths

| Trigger | Purpose |
| --- | --- |
| Individual scrape route | Run one source scraper on demand |
| `/api/v1/scrape/refresh` | Run all five scrapers synchronously and return the full run summary (HTTP 200 even with partial failures) |
| `/api/v1/scrape/cron/trigger` | Protected manual trigger for the scheduled refresh path; accepted immediately with a run id and executed in the background |
| `/api/v1/scrape/runs/latest` | Fetch status and summary of the most recent run |
| `/api/v1/scrape/runs/:runId` | Fetch status and summary of a specific run (404 for unknown ids) |
| Internal cron scheduler | Automatic nightly refresh |

All orchestration endpoints require the `x-cron-secret` header; missing or
wrong secrets are rejected with `401`.

## Run Orchestration & Auditable Summaries

Every run receives a unique `runId` tracked in an in-memory run registry and
produces a summary containing:

- `runId`, `status` (`running` / `completed`), `startedAt`, `finishedAt`
- `total`, `successful`, `failed` counters
- `cacheInvalidated` — whether the hackathon cache was cleared
- `results` — per-platform entries in the fixed order Devfolio, Unstop,
  Devpost, MLH, Hack2Skill, each marked `success` or `failed` with the error
  message on failure

Guarantees:

- All five platforms are always attempted; a throwing platform is recorded
  as failed and never aborts the remaining platforms.
- `invalidateHackathonCache` is called at most once per run and only when at
  least one platform succeeded. When every platform fails the cache is left
  untouched.
- At most one run (synchronous or background) is active at any time. A
  duplicate `cron/trigger` while a run is active returns "already running"
  together with the active run id and does not start a second run.

## Maintenance Notes

- Keep each scraper isolated so failures in one source do not block the others.
- Preserve the normalized hackathon shape used by the API and frontend.
- When a new source is added, document it here and in the API reference, and
  register it in `SCRAPERS` inside `ingestion.service.ts` so it is included in
  run summaries and the cache-invalidation decision.
