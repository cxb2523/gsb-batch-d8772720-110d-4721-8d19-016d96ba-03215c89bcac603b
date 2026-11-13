import { scrapeDevfolioData } from "../adapters/devfolio.adapter.ts";
import { scrapeUnstopData } from "../adapters/unstop.adapter.ts";
import { scrapeDevpostData } from "../adapters/devpost.adapter.ts";
import { scrapeMLHData } from "../adapters/mlh.adapter.ts";
import { scrapeHack2SkillData } from "../adapters/hack2skill.adapter.ts";
import { invalidateHackathonCache } from "../../../infrastructure/cache/redis.ts";
import {
  beginRun,
  completeRun,
  type IngestionRunSummary,
  type PlatformRunResult,
} from "./runRegistry.ts";

export type { IngestionRunSummary, PlatformRunResult } from "./runRegistry.ts";
export { RunInProgressError } from "./runRegistry.ts";

export interface ScraperDefinition {
  name: string;
  run: () => Promise<unknown>;
}

/**
 * Fixed platform order: Devfolio, Unstop, Devpost, MLH, Hack2Skill.
 * Tests (and any custom orchestration) may replace individual entries via
 * {@link withScrapers}.
 */
export const SCRAPERS: ScraperDefinition[] = [
  { name: "Devfolio", run: scrapeDevfolioData },
  { name: "Unstop", run: scrapeUnstopData },
  { name: "Devpost", run: scrapeDevpostData },
  { name: "MLH", run: scrapeMLHData },
  { name: "Hack2Skill", run: scrapeHack2SkillData },
];

let configuredScrapers: ScraperDefinition[] = SCRAPERS;

/**
 * Replace the scraper set used by the orchestrator (e.g. with fakes in
 * tests). Pass nothing or an empty list to restore the production scrapers.
 */
export function withScrapers(scrapers?: ScraperDefinition[]): void {
  configuredScrapers = scrapers && scrapers.length > 0 ? scrapers : SCRAPERS;
}

export function getConfiguredScrapers(): ScraperDefinition[] {
  return configuredScrapers;
}

const toErrorMessage = (err: unknown): string => {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return String(err);
};

/**
 * Execute the scrapers for an already-registered run id. Every configured
 * scraper is attempted exactly once; a throwing scraper is recorded as
 * failed but never aborts the remaining ones. The hackathon cache is
 * invalidated only when at least one scraper succeeded, so an all-failed
 * run leaves the existing cache untouched. The run lock is always released,
 * even on unexpected errors.
 */
async function executeRun(runId: string): Promise<IngestionRunSummary> {
  const scrapers = getConfiguredScrapers();
  const results: PlatformRunResult[] = [];
  let successfulScrapers = 0;

  try {
    for (const scraper of scrapers) {
      try {
        console.log(`[CRON] Starting ${scraper.name} scraper (runId=${runId})...`);
        await scraper.run();
        successfulScrapers += 1;
        results.push({ name: scraper.name, status: "success" });
        console.log(`[CRON] ${scraper.name} scraper completed successfully.`);
      } catch (err) {
        const error = toErrorMessage(err);
        console.error(`[CRON] ${scraper.name} scraper failed:`, error);
        results.push({ name: scraper.name, status: "failed", error });
      }
    }

    const failedScrapers = scrapers.length - successfulScrapers;
    let cacheInvalidated = false;

    console.log(
      `[CRON] All scrapers processed (runId=${runId}): ${successfulScrapers} succeeded, ${failedScrapers} failed.`,
    );

    if (successfulScrapers > 0) {
      await invalidateHackathonCache();
      cacheInvalidated = true;
    } else {
      console.warn(
        `[CRON] Every scraper failed (runId=${runId}); keeping the existing cache untouched.`,
      );
    }

    return completeRun(runId, {
      total: scrapers.length,
      successful: successfulScrapers,
      failed: failedScrapers,
      results,
      cacheInvalidated,
    });
  } catch (unexpected) {
    // Defensive: never leave the single-flight lock stuck.
    console.error(
      `[CRON] Unexpected orchestrator error (runId=${runId}):`,
      toErrorMessage(unexpected),
    );
    return completeRun(runId, {
      total: scrapers.length,
      successful: successfulScrapers,
      failed: scrapers.length - successfulScrapers,
      results,
      cacheInvalidated: false,
    });
  }
}

/**
 * Synchronously run every scraper and resolve with the auditable run
 * summary. Throws {@link RunInProgressError} if another run (for example a
 * background cron trigger) is currently active.
 */
export async function runAllScrapers(): Promise<IngestionRunSummary> {
  const registered = beginRun(getConfiguredScrapers().length);
  return executeRun(registered.runId);
}

/**
 * Acquire the single-flight lock synchronously and start the run in the
 * background. Returns the new run id immediately; the caller can poll the
 * status endpoint while the scrapers execute. Throws
 * {@link RunInProgressError} when a run is already active, in which case no
 * second run is created.
 */
export function startBackgroundScraperRun(): string {
  const registered = beginRun(getConfiguredScrapers().length);
  const runId = registered.runId;

  void executeRun(runId).catch((error) => {
    console.error(`[CRON] Background run ${runId} failed:`, toErrorMessage(error));
  });

  return runId;
}
