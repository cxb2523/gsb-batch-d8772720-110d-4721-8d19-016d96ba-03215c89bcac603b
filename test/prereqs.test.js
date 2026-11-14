/**
 * Core prerequisite unit tests (the engineering prompt's own requirement:
 * "each ships with its own unit test in test/plugin.test.js style").
 *
 * - R0: loadSolvers skips `_`-prefixed dirs (the shared paid library).
 * - R1: download lifecycle events land in the ring + per-tab download map.
 * - R2: cdpBroadcast reaches the tab + every frame session and REPLAYS on
 *   a later frame attach.
 * - R3/R4: cdpSend is the typed passthrough lever (WebAuthn/Storage route
 *   with the tab's session by default, an explicit one when given).
 * - A2: profile_dir launches a PERSISTENT profile that survives dispose
 *   (browser-gated — the ephemeral default is deleted, the persistent one
 *   is not; that difference is the whole point).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSolvers } from "../src/plugins/index.js";
import { Controller } from "../src/core/controller.js";
import { locateBrowser } from "../src/core/cdp.js";

const hasBrowser = !!locateBrowser();

/* ------------------------------------------------------------------- R0 */

test("R0: the loader skips `_`-prefixed dirs (shared paid library is never a plugin)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "axuse-r0-"));
  try {
    mkdirSync(join(dir, "good"));
    writeFileSync(join(dir, "good", "index.js"),
      `export const solver = { id: "good", version: "1.0.0", providers: ["p"], solve: async (p, c) => ({}) };`);
    mkdirSync(join(dir, "_shared"));
    writeFileSync(join(dir, "_shared", "index.js"),
      `export const solver = { id: "should-never-load", version: "1.0.0", providers: ["x"], solve: async (p, c) => ({}) };`);
    const { solvers, errors } = await loadSolvers([dir]);
    assert.deepEqual(errors, []);
    assert.deepEqual(solvers.map((s) => s.id), ["good"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------------------------------- fake conn / tab plumbing */

function fakeControllerWithTab() {
  const c = new Controller();
  const sends = [];
  const conn = { send: async (method, params, sessionId) => (sends.push({ method, params, sessionId }), {}) };
  const tab = {
    tabId: "t1", browserId: "b1", targetId: "tgt1", sessionId: "sess-tab",
    url: "https://x/", title: "", stateId: 0, lastSnapshot: null,
    events: [], eventSeq: 0, dialog: null, closed: false,
    frames: new Map(), frameSeq: 0, downloads: new Map(), cdpBroadcasts: [],
    browser: { browserId: "b1", handle: { conn }, tabs: new Set(["t1"]) },
  };
  c.tabs.set("t1", tab);
  c.activeTabId = "t1";
  return { c, tab, sends, conn };
}

/* ------------------------------------------------------------------- R1 */

test("R1: downloadWillBegin/Progress land in the event ring + the tab download map", () => {
  const { c, tab } = fakeControllerWithTab();
  c.recordEvent(tab, "Page.downloadWillBegin", { guid: "g1", suggestedFilename: "invoice.pdf", url: "https://x/invoice.pdf" });
  assert.equal(tab.downloads.get("g1").suggestedFilename, "invoice.pdf");
  assert.equal(tab.downloads.get("g1").state, "inProgress");
  c.recordEvent(tab, "Page.downloadProgress", { guid: "g1", state: "completed", receivedBytes: 42, totalBytes: 42 });
  const dl = tab.downloads.get("g1");
  assert.equal(dl.state, "completed");
  assert.equal(dl.receivedBytes, 42);
  // Ring entries carry the lifecycle facts, sequenced.
  assert.equal(tab.events.length, 2);
  assert.equal(tab.events[0].method, "Page.downloadWillBegin");
  assert.deepEqual(tab.events[1].data, { guid: "g1", state: "completed", receivedBytes: 42, totalBytes: 42 });
});

/* ------------------------------------------------------------------- R2 */

test("R2: cdpBroadcast reaches the tab + every frame session and replays on later attaches", async () => {
  const { c, tab, sends } = fakeControllerWithTab();
  // Two attached frames (as if OOPIFs registered earlier).
  tab.frames.set("sess-f1", { slot: 1, sessionId: "sess-f1", targetId: "f1", url: "https://frame1/" });
  tab.frames.set("sess-f2", { slot: 2, sessionId: "sess-f2", targetId: "f2", url: "https://frame2/" });

  const r = await c.cdpBroadcast("t1", "Fetch.enable", { patterns: [] });
  assert.deepEqual(r, { sent: 3, sessions: 3, replayedOnAttach: true });
  // Sent once to the tab session and once per frame session.
  assert.deepEqual(sends.map((s) => s.sessionId), ["sess-tab", "sess-f1", "sess-f2"]);
  // Deduped registration.
  await c.cdpBroadcast("t1", "Fetch.enable", { patterns: [] });
  assert.equal(tab.cdpBroadcasts.length, 1);

  // A NEW frame attaches later → the broadcast REPLAYS onto it (the R2 rule:
  // enables must survive cross-origin frame churn).
  sends.length = 0;
  await c.registerFrame(tab, { sessionId: "sess-f3", targetInfo: { targetId: "f3", url: "https://frame3/" } });
  const replay = sends.find((s) => s.method === "Fetch.enable" && s.sessionId === "sess-f3");
  assert.ok(replay, "broadcast did not replay on the newly attached frame");
  assert.deepEqual(replay.params, { patterns: [] });
});

/* ------------------------------------------------------------- R3 / R4 */

test("R3/R4: cdpSend is the typed passthrough (tab session by default, explicit when given)", async () => {
  const { c, sends } = fakeControllerWithTab();
  // R4 shape: Storage.getCookies routes on the tab's session.
  await c.cdpSend("t1", "Storage.getCookies", {});
  assert.equal(sends.at(-1).method, "Storage.getCookies");
  assert.equal(sends.at(-1).sessionId, "sess-tab");
  // R3 shape: WebAuthn.addVirtualAuthenticator with an explicit session.
  await c.cdpSend("t1", "WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2" } }, "sess-f9");
  assert.equal(sends.at(-1).method, "WebAuthn.addVirtualAuthenticator");
  assert.equal(sends.at(-1).sessionId, "sess-f9");
  assert.deepEqual(sends.at(-1).params, { options: { protocol: "ctap2" } });
  // No tab → typed NO_TAB (fail closed).
  const fresh = new Controller();
  await assert.rejects(() => fresh.cdpSend(null, "Storage.getCookies", {}), (e) => e.code === "NO_TAB");
});

/* ------------------------------------------------------------------- A2 */

test("A2: profile_dir is persistent — survives dispose; the ephemeral default does not", { skip: !hasBrowser }, async () => {
  const profileDir = mkdtempSync(join(tmpdir(), "axuse-a2-profile-"));
  const c = new Controller();
  try {
    const opened = await c.execute("open", { url: "about:blank", headless: true, profile_dir: profileDir, settle_ms: 200 });
    assert.ok(opened.tab_id);
    // The persistent profile accumulates state while alive.
    await c.execute("navigate", { url: "data:text/html,<h1>aged</h1>", settle_ms: 100 });
  } finally {
    await c.dispose();
  }
  try {
    assert.ok(existsSync(profileDir), "A2 profile was DELETED on dispose — persistent profiles must survive");
  } finally {
    // Windows: Chrome can hold profile-file locks briefly after dispose
    // (process teardown) — retry the cleanup before failing the test.
    for (let i = 0; ; i++) {
      try {
        rmSync(profileDir, { recursive: true, force: true });
        break;
      } catch (e) {
        if ((e.code === "EPERM" || e.code === "EBUSY" || e.code === "ENOTEMPTY") && i < 20) {
          await new Promise((ok) => setTimeout(ok, 250));
          continue;
        }
        throw e;
      }
    }
  }

  // Contrast: the ephemeral default profile IS cleaned up on dispose.
  const c2 = new Controller();
  let ephemeralDir = null;
  try {
    await c2.execute("open", { url: "about:blank", headless: true, settle_ms: 200 });
    const b = [...c2.browsers.values()][0];
    ephemeralDir = b.handle.userDataDir;
    assert.ok(ephemeralDir && b.handle.ephemeral === true);
  } finally {
    await c2.dispose();
  }
  await new Promise((ok) => setTimeout(ok, 300));
  assert.ok(!existsSync(ephemeralDir), "ephemeral profile leaked (should be deleted on dispose)");
});
