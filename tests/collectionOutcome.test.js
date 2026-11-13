/*
 * ======= • ======= • ======= • ======= • =======• =======
 * AniKotoAPI — tests/collectionOutcome.test.js
 *
 * @description
 *   Local, hermetic tests for the `collectionOutcome` field on
 *   GET /api/search and GET /api/filter. Every scenario is driven by a fake
 *   upstream running on 127.0.0.1 and a freshly spawned API server whose
 *   MIRROR_DOMAINS point at it — no real external site is ever contacted.
 *
 *   Coverage (the four mandated cases):
 *     1. Successful scrape            — mirror/proxy/attempt order reported
 *     2. Mirror fallback              — a dead primary falls over to mirror 2
 *     3. Terminal 4xx                 — 400 and page-3 404 keep their status,
 *                                       mark terminated=true and name the page
 *     4. Cache hit                    — second identical request is stamped
 *                                       fromCache=true with the stored trace
 *
 *   Run: npm run test:outcome
 *
 * @license MIT
 * ======= • ======= • ======= • ======= • =======• =======
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { startFakeUpstream } from "./helpers/fakeUpstream.js";
import { spawnApiServer, getFreePort } from "./helpers/testServer.js";

let fake;
let deadPort;

before(async () => {
  fake = await startFakeUpstream();
  // A port nothing listens on — connecting to it fails fast with ECONNREFUSED,
  // which is exactly the "primary mirror is down" condition we need.
  deadPort = await getFreePort();
});

after(async () => {
  await fake.close();
});

// ---- FEATURE: Shared assertion helpers for the outcome contract ----
const assertOutcomeShape = (outcome) => {
  assert.ok(outcome && typeof outcome === "object", "collectionOutcome must be an object");
  assert.equal(typeof outcome.fromCache, "boolean");
  assert.ok(
    outcome.proxy === null || ["direct", "scraperapi", "flaresolverr", "direct-retry"].includes(outcome.proxy),
    `unexpected proxy channel: ${outcome.proxy}`
  );
  assert.ok(Array.isArray(outcome.mirrorAttempts), "mirrorAttempts must be an array");
  assert.equal(typeof outcome.terminated, "boolean");
  assert.ok(
    outcome.terminalStatus === null || Number.isInteger(outcome.terminalStatus),
    "terminalStatus must be null or an integer status code"
  );
};

const assertLegacyShapeUntouched = (payload) => {
  assert.equal(payload.success, true, "success must stay true");
  assert.ok(payload.results && typeof payload.results === "object", "results must be preserved");
  assert.ok(Array.isArray(payload.results.data), "results.data array must be preserved");
  assert.ok(payload.results.pagination, "pagination object must be preserved");
  assert.equal(payload.results.pagination.currentPage, payload.collectionOutcome.page);
};

// ══════════════════════════════════════════════════════════════
// 1. SUCCESS — a healthy primary serves the page directly
// ══════════════════════════════════════════════════════════════

test("success: /api/search reports the real mirror, direct proxy and attempt order", async () => {
  const mirrorA = `http://127.0.0.1:${fake.port}`;
  const mirrorB = `http://127.0.0.1:${deadPort}`;
  const api = await spawnApiServer({ mirrorDomains: [mirrorA, mirrorB] });

  try {
    const res = await fetch(`${api.baseUrl}/api/search?keyword=naruto&page=1`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assertLegacyShapeUntouched(body);
    assertOutcomeShape(body.collectionOutcome);

    const outcome = body.collectionOutcome;
    assert.equal(outcome.fromCache, false);
    assert.equal(outcome.mirror, mirrorA, "mirror must be the domain that answered");
    assert.equal(outcome.proxy, "direct", "proxy must be direct");
    assert.deepEqual(outcome.mirrorAttempts, [mirrorA], "only the healthy mirror was contacted");
    assert.deepEqual(outcome.proxyAttempts, []);
    assert.equal(outcome.terminated, false);
    assert.equal(outcome.terminalStatus, null);
    assert.equal(outcome.failedPage, null);
    assert.equal(outcome.page, 1);

    // Real extraction still happened against the fake HTML
    assert.ok(body.results.data.length > 0);
    assert.equal(body.results.data[0].title, "Test Anime 0");
  } finally {
    await api.stop();
  }
});

test("success: /api/filter carries the same verifiable outcome", async () => {
  const mirrorA = `http://127.0.0.1:${fake.port}`;
  const api = await spawnApiServer({ mirrorDomains: [mirrorA] });

  try {
    const res = await fetch(`${api.baseUrl}/api/filter?keyword=naruto&page=1`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assertLegacyShapeUntouched(body);
    assertOutcomeShape(body.collectionOutcome);
    assert.equal(body.collectionOutcome.mirror, mirrorA);
    assert.equal(body.collectionOutcome.proxy, "direct");
    assert.deepEqual(body.collectionOutcome.mirrorAttempts, [mirrorA]);
    assert.equal(body.collectionOutcome.terminated, false);
  } finally {
    await api.stop();
  }
});

// ══════════════════════════════════════════════════════════════
// 2. MIRROR FALLBACK — dead primary, healthy second mirror
// ══════════════════════════════════════════════════════════════

test("mirror fallback: /api/search falls over from the dead primary to mirror 2", async () => {
  const dead = `http://127.0.0.1:${deadPort}`;
  const alive = `http://127.0.0.1:${fake.port}`;
  const api = await spawnApiServer({ mirrorDomains: [dead, alive] });

  try {
    const res = await fetch(`${api.baseUrl}/api/search?keyword=onepiece&page=1`);
    assert.equal(res.status, 200, "fallback must still produce a 200");
    const body = await res.json();

    assertLegacyShapeUntouched(body);
    const outcome = body.collectionOutcome;
    assertOutcomeShape(outcome);

    assert.deepEqual(
      outcome.mirrorAttempts,
      [dead, alive],
      "both mirrors must be recorded in the order they were tried"
    );
    assert.equal(outcome.mirror, alive, "the mirror that answered must be the second one");
    assert.equal(outcome.proxy, "direct");
    assert.equal(outcome.terminated, false);
    assert.equal(outcome.fromCache, false);
  } finally {
    await api.stop();
  }
});

test("mirror fallback: /api/filter records the same fallback chain", async () => {
  const dead = `http://127.0.0.1:${deadPort}`;
  const alive = `http://127.0.0.1:${fake.port}`;
  const api = await spawnApiServer({ mirrorDomains: [dead, alive] });

  try {
    const res = await fetch(`${api.baseUrl}/api/filter?keyword=onepiece`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.deepEqual(body.collectionOutcome.mirrorAttempts, [dead, alive]);
    assert.equal(body.collectionOutcome.mirror, alive);
    assert.equal(body.collectionOutcome.terminated, false);
  } finally {
    await api.stop();
  }
});

// ══════════════════════════════════════════════════════════════
// 3. TERMINAL 4xx — upstream rejects the request outright
// ══════════════════════════════════════════════════════════════

test("terminal 400: /api/search stays 400 JSON, marks terminated and records the status", async () => {
  const mirrorA = `http://127.0.0.1:${fake.port}`;
  const mirrorB = `http://127.0.0.1:${deadPort}`;
  const api = await spawnApiServer({ mirrorDomains: [mirrorA, mirrorB] });

  try {
    const res = await fetch(`${api.baseUrl}/api/search?keyword=boom400`);
    assert.equal(res.status, 400, "upstream 400 must map to 400, never 500");
    const contentType = res.headers.get("content-type") || "";
    assert.ok(contentType.includes("application/json"), "error body must be JSON, not HTML");

    const body = await res.json();
    assert.equal(body.success, false);
    assert.ok(typeof body.message === "string");

    const outcome = body.collectionOutcome;
    assert.ok(outcome, "terminal error response must still carry collectionOutcome");
    assertOutcomeShape(outcome);
    assert.equal(outcome.terminated, true);
    assert.equal(outcome.terminalStatus, 400);
    assert.ok(outcome.terminalReason, "a terminal reason must be recorded");
    // A 400 is a path-level fault: the first mirror rejects it and the chain
    // stops immediately — mirror 2 must never be contacted.
    assert.deepEqual(outcome.mirrorAttempts, [mirrorA]);
    assert.equal(outcome.mirror, mirrorA);
    assert.equal(outcome.failedPage, 1);
  } finally {
    await api.stop();
  }
});

test("terminal 404: page=3 failure names page 3, not a generic error", async () => {
  const mirrorA = `http://127.0.0.1:${fake.port}`;
  const api = await spawnApiServer({ mirrorDomains: [mirrorA] });

  try {
    // The fake upstream answers 404 for any page >= 3
    const res = await fetch(`${api.baseUrl}/api/search?keyword=naruto&page=3`);
    assert.equal(res.status, 404, "upstream page rejection must stay 404");
    const contentType = res.headers.get("content-type") || "";
    assert.ok(contentType.includes("application/json"), "must be JSON, never the HTML error page");

    const body = await res.json();
    assert.equal(body.success, false);
    const outcome = body.collectionOutcome;
    assert.ok(outcome, "404 response must carry collectionOutcome");
    assertOutcomeShape(outcome);
    assert.equal(outcome.terminated, true);
    assert.equal(outcome.terminalStatus, 404);
    assert.equal(outcome.page, 3, "the requested page must be recorded");
    assert.equal(outcome.failedPage, 3, "the failed page must explicitly be page 3");
  } finally {
    await api.stop();
  }
});

test("terminal 404: /api/filter page=3 failure is reported per page as well", async () => {
  const mirrorA = `http://127.0.0.1:${fake.port}`;
  const api = await spawnApiServer({ mirrorDomains: [mirrorA] });

  try {
    const res = await fetch(`${api.baseUrl}/api/filter?keyword=naruto&page=3`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.collectionOutcome.terminated, true);
    assert.equal(body.collectionOutcome.terminalStatus, 404);
    assert.equal(body.collectionOutcome.failedPage, 3);
    assert.deepEqual(body.collectionOutcome.mirrorAttempts, [mirrorA]);
  } finally {
    await api.stop();
  }
});

// ══════════════════════════════════════════════════════════════
// 4. CACHE HIT — the second identical request replays the stored trace
// ══════════════════════════════════════════════════════════════

test("cache hit: the second /api/search response is stamped fromCache=true", async () => {
  const mirrorA = `http://127.0.0.1:${fake.port}`;
  const api = await spawnApiServer({ mirrorDomains: [mirrorA] });

  try {
    const first = await fetch(`${api.baseUrl}/api/search?keyword=cached&page=1`);
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.collectionOutcome.fromCache, false, "first request is a fresh scrape");
    assert.equal(first.headers.get("x-cache"), "MISS");
    assert.equal(firstBody.collectionOutcome.mirror, mirrorA);

    const second = await fetch(`${api.baseUrl}/api/search?keyword=cached&page=1`);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get("x-cache"), "HIT");
    const secondBody = await second.json();

    assertLegacyShapeUntouched(secondBody);
    const outcome = secondBody.collectionOutcome;
    assertOutcomeShape(outcome);
    assert.equal(outcome.fromCache, true, "cache replay must be explicitly marked");
    // The stored trace stays attached so operators know its provenance
    assert.equal(outcome.mirror, mirrorA, "original scrape mirror must be preserved");
    assert.equal(outcome.proxy, "direct");
    assert.deepEqual(outcome.mirrorAttempts, [mirrorA]);
    assert.equal(outcome.terminated, false);
    assert.equal(outcome.page, 1);

    // Results payloads must be byte-equivalent between miss and hit
    assert.deepEqual(secondBody.results, firstBody.results);
  } finally {
    await api.stop();
  }
});

test("cache hit: /api/filter replays the stored outcome with fromCache=true", async () => {
  const mirrorA = `http://127.0.0.1:${fake.port}`;
  const api = await spawnApiServer({ mirrorDomains: [mirrorA] });

  try {
    const url = `${api.baseUrl}/api/filter?keyword=filtercache&type=tv&page=1`;

    const first = await fetch(url);
    const firstBody = await first.json();
    assert.equal(firstBody.collectionOutcome.fromCache, false);

    const second = await fetch(url);
    const secondBody = await second.json();
    assert.equal(secondBody.collectionOutcome.fromCache, true);
    assert.equal(secondBody.collectionOutcome.mirror, mirrorA);
    assert.deepEqual(secondBody.results, firstBody.results);
  } finally {
    await api.stop();
  }
});
