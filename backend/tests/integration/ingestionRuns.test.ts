import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";

// The production scraper rate limiter allows only 2 calls per 15 minutes;
// these tests exercise the orchestration many times, so replace it with a
// pass-through. Must be mocked before the app/router modules are imported.
vi.mock("../../src/shared/middlewares/rateLimiter.ts", () => ({
  scraperRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  apiRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  authRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  searchRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  emailRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  passwordResetRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  joinCodeRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// No real Redis in tests: count invalidation calls instead.
const mocks = vi.hoisted(() => ({
  invalidateCalls: 0,
}));

vi.mock("../../src/infrastructure/cache/redis.ts", () => ({
  invalidateHackathonCache: vi.fn(async () => {
    mocks.invalidateCalls += 1;
  }),
  connectRedis: vi.fn(async () => undefined),
  default: { isOpen: false },
}));

import { app } from "../../src/app.ts";
import {
  withScrapers,
  resetRunRegistry,
  getRun,
  type ScraperDefinition,
} from "../../src/modules/ingestion/index.ts";

const CRON_SECRET = "your-secret-key-change-in-production";
const BASE = "/api/v1/scrape";

const PLATFORM_NAMES = ["Devfolio", "Unstop", "Devpost", "MLH", "Hack2Skill"];

const okScraper = (name: string): ScraperDefinition => ({
  name,
  run: vi.fn(async () => [{ name }]),
});

const failingScraper = (name: string, message: string): ScraperDefinition => ({
  name,
  run: vi.fn(async () => {
    throw new Error(message);
  }),
});

const waitForRunCompletion = async (runId: string, attempts = 50): Promise<void> => {
  for (let i = 0; i < attempts; i += 1) {
    const run = getRun(runId);
    if (run && run.status === "completed") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Run ${runId} did not complete in time`);
};

describe("Ingestion orchestration run summaries", () => {
  beforeEach(() => {
    mocks.invalidateCalls = 0;
    resetRunRegistry();
  });

  afterEach(() => {
    withScrapers();
    vi.clearAllMocks();
  });

  it("refresh: all five platforms succeed, returns 200 with a full summary and invalidates cache once", async () => {
    withScrapers(PLATFORM_NAMES.map((name) => okScraper(name)));

    const res = await request(app)
      .post(`${BASE}/refresh`)
      .set("x-cron-secret", CRON_SECRET);

    expect(res.status).toBe(200);
    const summary = res.body.data;
    expect(res.body.success).toBe(true);
    expect(summary.runId).toEqual(expect.any(String));
    expect(summary.status).toBe("completed");
    expect(summary.startedAt).toEqual(expect.any(String));
    expect(summary.finishedAt).toEqual(expect.any(String));
    expect(new Date(summary.finishedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(summary.startedAt).getTime(),
    );
    expect(summary.total).toBe(5);
    expect(summary.successful).toBe(5);
    expect(summary.failed).toBe(0);
    expect(summary.cacheInvalidated).toBe(true);
    expect(summary.results.map((r: { name: string }) => r.name)).toEqual(PLATFORM_NAMES);
    expect(summary.results.every((r: { status: string }) => r.status === "success")).toBe(true);
    expect(mocks.invalidateCalls).toBe(1);
  });

  it("refresh: partial failures still run every platform, keep going, and invalidate cache exactly once", async () => {
    withScrapers([
      okScraper("Devfolio"),
      failingScraper("Unstop", "Unstop boom"),
      okScraper("Devpost"),
      failingScraper("MLH", "MLH boom"),
      okScraper("Hack2Skill"),
    ]);

    const res = await request(app)
      .post(`${BASE}/refresh`)
      .set("x-cron-secret", CRON_SECRET);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    const summary = res.body.data;
    expect(summary.total).toBe(5);
    expect(summary.successful).toBe(3);
    expect(summary.failed).toBe(2);
    expect(summary.results.map((r: { name: string }) => r.name)).toEqual(PLATFORM_NAMES);
    expect(summary.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Unstop", status: "failed", error: "Unstop boom" }),
        expect.objectContaining({ name: "MLH", status: "failed", error: "MLH boom" }),
      ]),
    );
    // Platforms after a failure were still attempted.
    expect(summary.results[4]).toMatchObject({ name: "Hack2Skill", status: "success" });
    expect(summary.cacheInvalidated).toBe(true);
    expect(mocks.invalidateCalls).toBe(1);
  });

  it("refresh: when every platform fails, returns 200 marked failed and never invalidates the cache", async () => {
    withScrapers(
      PLATFORM_NAMES.map((name) => failingScraper(name, `${name} is down`)),
    );

    const res = await request(app)
      .post(`${BASE}/refresh`)
      .set("x-cron-secret", CRON_SECRET);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    const summary = res.body.data;
    expect(summary.successful).toBe(0);
    expect(summary.failed).toBe(5);
    expect(summary.results.every((r: { status: string }) => r.status === "failed")).toBe(true);
    expect(summary.cacheInvalidated).toBe(false);
    expect(mocks.invalidateCalls).toBe(0);
  });

  it("cron/trigger: accepts immediately with a run id, runs in background, and a duplicate trigger is rejected without starting a second run", async () => {
    let releaseGate: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    let callCount = 0;
    withScrapers(
      PLATFORM_NAMES.map((name, index) => ({
        name,
        run: vi.fn(async () => {
          if (index === 0) {
            callCount += 1;
            await gate;
          }
        }),
      })),
    );

    const first = await request(app)
      .post(`${BASE}/cron/trigger`)
      .set("x-cron-secret", CRON_SECRET);

    expect(first.status).toBe(200);
    expect(first.body.runId).toEqual(expect.any(String));
    expect(first.body.status).toBe("running");
    expect(first.body.success).toBe(true);
    const firstRunId = first.body.runId;

    // While the first run is blocked at the gate, the status endpoint shows running.
    const running = await request(app)
      .get(`${BASE}/runs/${firstRunId}`)
      .set("x-cron-secret", CRON_SECRET);
    expect(running.status).toBe(200);
    expect(running.body.data.status).toBe("running");
    expect(running.body.data.finishedAt).toBeNull();

    // Duplicate trigger must be answered "already running" and must not create a second run.
    const duplicate = await request(app)
      .post(`${BASE}/cron/trigger`)
      .set("x-cron-secret", CRON_SECRET);
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.success).toBe(false);
    expect(duplicate.body.runId).toBe(firstRunId);
    expect(duplicate.body.message).toContain("已在运行");

    // Release the gate and wait for the single background run to finish.
    if (releaseGate) releaseGate();
    await waitForRunCompletion(firstRunId);

    // Only one execution of the gated scraper happened => no concurrent second run.
    expect(callCount).toBe(1);

    const finished = await request(app)
      .get(`${BASE}/runs/${firstRunId}`)
      .set("x-cron-secret", CRON_SECRET);
    expect(finished.status).toBe(200);
    expect(finished.body.data.status).toBe("completed");
    expect(finished.body.data.successful).toBe(5);
    expect(finished.body.data.runId).toBe(firstRunId);
    expect(mocks.invalidateCalls).toBe(1);

    // After completion, a new trigger is accepted again.
    const second = await request(app)
      .post(`${BASE}/cron/trigger`)
      .set("x-cron-secret", CRON_SECRET);
    expect(second.status).toBe(200);
    expect(second.body.success).toBe(true);
    expect(second.body.runId).not.toBe(firstRunId);
    await waitForRunCompletion(second.body.runId);
  });

  it("status endpoint: returns the latest run via /runs/latest and 404 for an unknown run id", async () => {
    withScrapers(PLATFORM_NAMES.map((name) => okScraper(name)));

    const refresh = await request(app)
      .post(`${BASE}/refresh`)
      .set("x-cron-secret", CRON_SECRET);
    const runId = refresh.body.data.runId;

    const latest = await request(app)
      .get(`${BASE}/runs/latest`)
      .set("x-cron-secret", CRON_SECRET);
    expect(latest.status).toBe(200);
    expect(latest.body.data.runId).toBe(runId);
    expect(latest.body.data.status).toBe("completed");
    expect(latest.body.data.total).toBe(5);

    const unknown = await request(app)
      .get(`${BASE}/runs/does-not-exist-id`)
      .set("x-cron-secret", CRON_SECRET);
    expect(unknown.status).toBe(404);
    expect(unknown.body.success).toBe(false);
  });

  it("cron secret: missing or wrong x-cron-secret is rejected with 401 on every protected endpoint", async () => {
    withScrapers(PLATFORM_NAMES.map((name) => okScraper(name)));

    const noSecretRefresh = await request(app).post(`${BASE}/refresh`);
    expect(noSecretRefresh.status).toBe(401);

    const wrongSecretTrigger = await request(app)
      .post(`${BASE}/cron/trigger`)
      .set("x-cron-secret", "nope");
    expect(wrongSecretTrigger.status).toBe(401);

    const wrongSecretStatus = await request(app)
      .get(`${BASE}/runs/latest`)
      .set("x-cron-secret", "nope");
    expect(wrongSecretStatus.status).toBe(401);

    const noSecretSpecific = await request(app).get(`${BASE}/runs/abc`);
    expect(noSecretSpecific.status).toBe(401);

    // No run should have been started by rejected requests.
    expect(mocks.invalidateCalls).toBe(0);
  });
});
