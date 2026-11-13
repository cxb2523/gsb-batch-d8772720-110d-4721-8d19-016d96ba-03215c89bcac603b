import { randomUUID } from "node:crypto";

export type ScrapeRunStatus = "running" | "completed";

export type PlatformRunStatus = "success" | "failed";

export interface PlatformRunResult {
  name: string;
  status: PlatformRunStatus;
  error?: string;
}

export interface IngestionRunSummary {
  runId: string;
  status: ScrapeRunStatus;
  startedAt: string;
  finishedAt: string | null;
  total: number;
  successful: number;
  failed: number;
  cacheInvalidated: boolean;
  results: PlatformRunResult[];
}

export class RunInProgressError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(`A scraper run is already in progress (runId: ${runId})`);
    this.name = "RunInProgressError";
    this.runId = runId;
  }
}

const MAX_HISTORY = 100;

const runHistory = new Map<string, IngestionRunSummary>();
let activeRunId: string | null = null;
let latestRunId: string | null = null;

function clone(summary: IngestionRunSummary): IngestionRunSummary {
  return {
    ...summary,
    results: summary.results.map((item) => ({ ...item })),
  };
}

/**
 * Begin a new run. At most one run (synchronous refresh or background cron
 * trigger) can be active at any moment.
 */
export function beginRun(platformCount: number): IngestionRunSummary {
  if (activeRunId !== null) {
    throw new RunInProgressError(activeRunId);
  }

  const runId = randomUUID();
  const summary: IngestionRunSummary = {
    runId,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    total: platformCount,
    successful: 0,
    failed: 0,
    cacheInvalidated: false,
    results: [],
  };

  runHistory.set(runId, summary);
  latestRunId = runId;
  activeRunId = runId;

  while (runHistory.size > MAX_HISTORY) {
    const oldestKey = runHistory.keys().next().value;
    if (oldestKey === undefined) break;
    runHistory.delete(oldestKey);
  }

  return clone(summary);
}

export function completeRun(
  runId: string,
  details: Pick<IngestionRunSummary, "total" | "successful" | "failed" | "results" | "cacheInvalidated">,
): IngestionRunSummary {
  const existing = runHistory.get(runId);
  const summary: IngestionRunSummary = {
    runId,
    status: "completed",
    startedAt: existing?.startedAt ?? new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    total: details.total,
    successful: details.successful,
    failed: details.failed,
    cacheInvalidated: details.cacheInvalidated,
    results: details.results,
  };

  runHistory.set(runId, summary);
  if (activeRunId === runId) {
    activeRunId = null;
  }
  latestRunId = runId;

  return clone(summary);
}

export function getActiveRunId(): string | null {
  return activeRunId;
}

export function isRunActive(): boolean {
  return activeRunId !== null;
}

export function getRun(runId: string): IngestionRunSummary | null {
  const summary = runHistory.get(runId);
  return summary ? clone(summary) : null;
}

export function getLatestRun(): IngestionRunSummary | null {
  if (latestRunId === null) return null;
  return getRun(latestRunId);
}

/**
 * Test/maintenance helper: forget every recorded run and release any active
 * lock so runs do not leak across test cases.
 */
export function resetRunRegistry(): void {
  runHistory.clear();
  activeRunId = null;
  latestRunId = null;
}
