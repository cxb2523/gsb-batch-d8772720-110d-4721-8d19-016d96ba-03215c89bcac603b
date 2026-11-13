/**
 * Repeatable tests for job cancellation on the Puppeteer queue.
 *
 * No real Chromium is launched: browser-pool is stubbed via Bun's module
 * mocks. A "gate" promise keeps jobs stuck in the 'processing' state until
 * the test releases it, which gives deterministic control over which jobs
 * are pending vs. executing.
 *
 * Run with:  bun test tests/test-queue-cancel.ts
 */
import { mock, describe, test, expect, beforeEach } from 'bun:test';
import { NextRequest } from 'next/server';

// ── Stub browser pool (replaces real Chromium) ─────────────────────────────

let releaseGate: (() => void) | null = null;
let gate: Promise<void> | null = null;
let acquiredBrowsers = 0;

function resetGate() {
  gate = new Promise<void>(resolve => {
    releaseGate = resolve;
  });
}

const fakePage = {
  setDefaultNavigationTimeout: () => {},
  setDefaultTimeout: () => {},
};

const fakeBrowser = { id: 'stub-browser' };

mock.module('../app/api/puppeteer/browser-pool', () => ({
  browserPool: {
    // Resolves only when the test opens the gate, so jobs stay 'processing'
    // (past the pending stage) until we deliberately let them proceed.
    getBrowser: async () => {
      acquiredBrowsers++;
      await gate;
      return {
        browser: fakeBrowser,
        browserId: 'stub-browser',
        release: () => {},
      };
    },
    getPage: async () => ({
      page: fakePage,
      release: async () => {},
    }),
    enforceRateLimitForDomain: async () => {},
    getStats: () => ({ activeBrowsers: 0, totalPages: 0, busyPages: 0, browserDetails: [] }),
  },
}));

// Imported after the mock is registered so queue.ts picks up the stub.
import { puppeteerQueue } from '../app/api/puppeteer/queue';
import { POST, GET, DELETE } from '../app/api/puppeteer/route';
import { GET as getStatus } from '../app/api/puppeteer/status/[id]/route';

// ── Helpers ────────────────────────────────────────────────────────────────

const validConfig = { timeout: 5000, headless: true };

function deleteRequest(jobId?: string): NextRequest {
  const url = jobId
    ? `http://localhost/api/puppeteer?jobId=${encodeURIComponent(jobId)}`
    : 'http://localhost/api/puppeteer';
  return new NextRequest(url, { method: 'DELETE' });
}

async function enqueueJob(code = "return 'ok';"): Promise<string> {
  const req = new NextRequest('http://localhost/api/puppeteer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, config: validConfig, rowData: {} }),
  });
  const res = await POST(req);
  const body = await res.json();
  return body.jobId as string;
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 3000
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for: ${description}`);
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/**
 * Recreate the queue's internal state for each test:
 *  - 10 jobs fill every processing slot and block on the gated browser stub
 *  - 2 further jobs stay pending behind them
 */
async function seedQueue(): Promise<{ processing: string[]; pending: string[] }> {
  resetGate();
  acquiredBrowsers = 0;

  const processing: string[] = [];
  for (let i = 0; i < 10; i++) {
    processing.push(await enqueueJob(`return 'done-${i}';`));
  }
  await waitFor(() => puppeteerQueue.getQueueStats().processing === 10, '10 jobs processing');
  expect(puppeteerQueue.getQueueStats().pending).toBe(0);

  const pending: string[] = [];
  for (let i = 0; i < 2; i++) {
    pending.push(await enqueueJob(`return 'pending-${i}';`));
  }
  await waitFor(() => puppeteerQueue.getQueueStats().pending === 2, '2 jobs pending');

  return { processing, pending };
}

beforeEach(() => {
  // Fresh queue state per test (the singleton otherwise persists across cases).
  (puppeteerQueue as unknown as { jobs: Map<string, unknown> }).jobs.clear();
  (puppeteerQueue as unknown as { processingJobs: Set<string> }).processingJobs.clear();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('DELETE /api/puppeteer — job cancellation', () => {
  test('cancelling a pending job decrements pending and the job never executes', async () => {
    const { pending } = await seedQueue();
    const target = pending[0];

    const before = puppeteerQueue.getQueueStats().pending;
    const res = await DELETE(deleteRequest(target));
    const body = await res.json();

    // 200 with the contract body
    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, jobId: target, status: 'cancelled' });

    // Pending count dropped by exactly one and job is no longer pending
    const stats = puppeteerQueue.getQueueStats();
    expect(stats.pending).toBe(before - 1);
    expect(puppeteerQueue.getJob(target)?.status).toBe('cancelled');

    // CORS headers are preserved on the success response
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('DELETE');

    // Release the blocked jobs and let the queue drain
    releaseGate!();
    await waitFor(
      () =>
        puppeteerQueue.getQueueStats().processing === 0 &&
        puppeteerQueue.getQueueStats().pending === 0,
      'queue drained'
    );

    // The cancelled job never entered executeJob (startedAt is only set
    // there) and never changed state after cancellation.
    expect(puppeteerQueue.getJob(target)?.startedAt).toBeUndefined();
    expect(puppeteerQueue.getJob(target)?.status).toBe('cancelled');

    // The other (non-cancelled) pending job did execute and complete
    const survivor = pending[1];
    await waitFor(
      () => puppeteerQueue.getJob(survivor)?.status === 'completed',
      'survivor completes'
    );
    expect(puppeteerQueue.getJob(survivor)?.status).toBe('completed');
  });

  test('cancelling a processing job returns 409', async () => {
    const { processing } = await seedQueue();
    const target = processing[0];
    expect(puppeteerQueue.getJob(target)?.status).toBe('processing');

    const res = await DELETE(deleteRequest(target));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.success).toBe(false);
    expect(body.jobId).toBe(target);
    expect(body.status).toBe('processing');
    expect(puppeteerQueue.getJob(target)?.status).toBe('processing');

    releaseGate!();
    await waitFor(
      () => puppeteerQueue.getJob(target)?.status === 'completed',
      'job completes'
    );
  });

  test('repeating a cancellation returns 404', async () => {
    const { pending } = await seedQueue();
    const target = pending[0];

    const first = await DELETE(deleteRequest(target));
    expect(first.status).toBe(200);

    const second = await DELETE(deleteRequest(target));
    const secondBody = await second.json();

    expect(second.status).toBe(404);
    expect(secondBody.success).toBe(false);
    expect(secondBody.jobId).toBe(target);

    // Still reported as cancelled (not resurrected)
    expect(puppeteerQueue.getJob(target)?.status).toBe('cancelled');

    releaseGate!();
  });

  test('missing jobId returns 400', async () => {
    await seedQueue();
    const res = await DELETE(deleteRequest());
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');

    releaseGate!();
  });

  test('unknown jobId returns 404', async () => {
    await seedQueue();
    const res = await DELETE(deleteRequest('job_does_not_exist'));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.jobId).toBe('job_does_not_exist');

    releaseGate!();
  });

  test('a completed job cannot be cancelled (409)', async () => {
    const { processing } = await seedQueue();
    const target = processing[0];
    releaseGate!();
    await waitFor(
      () =>
        puppeteerQueue.getQueueStats().processing === 0 &&
        puppeteerQueue.getQueueStats().pending === 0,
      'queue drained'
    );
    expect(puppeteerQueue.getJob(target)?.status).toBe('completed');

    const res = await DELETE(deleteRequest(target));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.status).toBe('completed');
  });
});

describe('GET /api/puppeteer — cancelled listing', () => {
  test('cancelled jobs appear in the cancelled field with jobId and cancellation time', async () => {
    const { pending } = await seedQueue();

    const res1 = await DELETE(deleteRequest(pending[0]));
    expect(res1.status).toBe(200);
    const res2 = await DELETE(deleteRequest(pending[1]));
    expect(res2.status).toBe(200);

    const res = await GET();
    const body = await res.json();

    expect(Array.isArray(body.cancelled)).toBe(true);
    expect(body.cancelled).toHaveLength(2);

    const entry = body.cancelled.find((c: { jobId: string }) => c.jobId === pending[0]);
    expect(entry).toBeDefined();
    expect(typeof entry.cancelledAt).toBe('string');
    expect(Number.isNaN(Date.parse(entry.cancelledAt))).toBe(false);

    // Sorted newest-first (non-increasing; equal timestamps keep insertion order)
    const times = body.cancelled.map((c: { cancelledAt: string }) => Date.parse(c.cancelledAt));
    expect(times[0]).toBeGreaterThanOrEqual(times[1]);
    expect(body.cancelled.map((c: { jobId: string }) => c.jobId).sort())
      .toEqual([...pending].sort());

    // Pending stats exclude cancelled jobs
    expect(body.queue.pending).toBe(0);
    expect(body.queue.cancelled).toBe(2);
    expect(body.recentJobs).toBeDefined();

    releaseGate!();
  });
});

describe('GET /api/puppeteer/status/[id] — cancelled status', () => {
  test('a cancelled job reports status "cancelled", not "pending"', async () => {
    const { pending } = await seedQueue();
    const target = pending[0];

    await DELETE(deleteRequest(target));

    const res = await getStatus(
      new NextRequest(`http://localhost/api/puppeteer/status/${target}`),
      { params: Promise.resolve({ id: target }) }
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.id).toBe(target);
    expect(body.status).toBe('cancelled');
    expect(body.message).toMatch(/cancelled/i);

    releaseGate!();
  });
});
