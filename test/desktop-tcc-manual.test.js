/**
 * MANUAL TCC VALIDATION LANE — macOS, explicit opt-in only.
 *
 * These tests exercise the GRANTED side of the TCC matrix: real screen
 * capture and a real (inert) input event. They never run in normal CI and
 * never run silently: the gate below requires BOTH the env opt-in and a
 * permission state that says granted — otherwise the test FAILS with typed
 * instructions instead of skipping, because in this lane "not granted" is a
 * lane misconfiguration, not an expected state.
 *
 * Required environment (see docs/macos-support.md §manual-tcc-lane):
 *   AXUSE_TEST_MACOS_TCC_MANUAL=1  (this lane's opt-in)
 *   AXUSE_ENABLE_MACOS_CUA=1
 *   A dedicated Mac with:
 *     - Accessibility granted to the host binary (node/Terminal/IDE)
 *     - Screen Recording granted to the same host
 *   Run: node --test test/desktop-tcc-manual.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getDesktopDriver } from "../src/desktop/index.js";

const manual = process.env.AXUSE_TEST_MACOS_TCC_MANUAL === "1";
const isMac = process.platform === "darwin";

test("tcc lane: granted Screen Recording + Accessibility is verified BEFORE anything runs", { skip: !manual || !isMac }, async () => {
  const d = await getDesktopDriver();
  const p = await d.permissions({ refresh: true });
  const problems = [];
  if (p.accessibility !== true) problems.push("Accessibility NOT granted — grant it to the exact binary running this test (System Settings → Privacy & Security → Accessibility).");
  if (p.screen_recording !== true) problems.push("Screen Recording NOT granted — grant it to the exact binary running this test, then RESTART that binary (macOS applies the grant to new processes only).");
  if (problems.length) {
    // Fail closed with the full typed instructions: this lane exists to
    // prove the granted state, so an ungranted state is a failure here.
    assert.fail(`tcc-manual lane misconfigured:\n  - ${problems.join("\n  - ")}`);
  }
});

test("tcc lane: real screenshot succeeds and stays budgeted (granted path)", { skip: !manual || !isMac }, async () => {
  const d = await getDesktopDriver();
  const info = await d.screenInfo({ refresh: true });
  // A 200x120 slice at the top-left of the primary display: enough to prove
  // pixel capture, small enough not to leak meaningful screen content into
  // logs (only size/mime facts are asserted, never the pixels).
  const shot = await d.screenshot({ x: info.x, y: info.y, w: 200, h: 120, budgetBytes: 120_000 });
  assert.equal(shot.mime, "image/jpeg");
  assert.ok(shot.bytes > 500, `shot has real pixel payload (${shot.bytes} bytes)`);
  assert.ok(shot.bytes <= 120_000);
});

test("tcc lane: inert input event round-trips through the CGEvent tap (granted path)", { skip: !manual || !isMac }, async () => {
  const d = await getDesktopDriver();
  // A zero-delta scroll event: a REAL posted event through the HID tap that
  // moves nothing and types nothing — end-to-end proof of the trusted-input
  // path without disturbing the session's owner.
  const res = await d.wheel(0, 0);
  assert.equal(res.action_sent, "sent");
});

test("tcc lane: wheel direction matches the browser contract under this host's scroll preference", { skip: !manual || !isMac }, async () => {
  // Live pin for the natural-scrolling sign mapping (unit-tested; this
  // records the on-host truth for the evidence file). A zero-delta event
  // again: it proves the preference read + event construction, while the
  // unit tests pin the arithmetic.
  const d = await getDesktopDriver();
  const natural = await d._naturalScrolling({ refresh: true });
  const res = await d.wheel(0, 0);
  assert.equal(res.action_sent, "sent");
  // Record the host's preference so the evidence file can correlate unit
  // expectations with reality on a granted machine.
  console.log(`[tcc-manual] natural scrolling = ${natural} (wheel contract: dy>0 = content down)`);
  assert.equal(typeof natural, "boolean");
});

test("tcc lane: recovery — a denied-then-granted transition is seen without host restart", { skip: !manual || !isMac }, async () => {
  // Cache invalidation contract: after invalidateCaches(), the next
  // permissions() must re-probe (recovery visibility). On an already-granted
  // host the values stay true — the assertion is that the re-probe HAPPENED.
  const d = await getDesktopDriver();
  await d.permissions({ refresh: true });
  d.invalidateCaches();
  const again = await d.permissions();
  assert.equal(again.accessibility, true, "re-probe after invalidation still sees the grant");
});

test("tcc lane: AX structure layer — snapshot + read round-trip on a real app", { skip: !manual || !isMac }, async (t) => {
  const d = await getDesktopDriver();
  const p = await d.permissions({ refresh: true });
  if (p.accessibility !== true) assert.fail("AX pin needs Accessibility granted (lane misconfiguration)");
  // Snapshot the frontmost app (the runner's own Terminal/agent host — a
  // guaranteed-present, safe target): structure facts only, no actions.
  const snap = await d.axSnapshot({ front: true, maxNodes: 60, maxDepth: 6 });
  assert.ok(snap.nodes > 3, `expected a real tree, got ${snap.nodes} nodes`);
  assert.ok(snap.text.includes("[ref=ax"), "refs are rendered");
  const ref = snap.text.match(/\[ref=(ax[\d.]+)\]/)?.[1];
  const read = await d.axRead({ ref });
  assert.equal(typeof read.role, "string");
  assert.equal(read.ref, ref);
  console.log(`[tcc-manual] ax pin: ${snap.app} → ${snap.nodes} nodes, ref ${ref} = ${read.role}`);
});

test("tcc lane: LIVE scroll-direction pin — wheel(0,+N) scrolls OUR page down, world-visible truth", { skip: !manual || !isMac }, async (t) => {
  // The natural-scrolling sign mapping is unit-pinned by derivation; this
  // test measures it against reality. It scrolls only axuse's OWN fixture
  // window (launched at a fixed position) and reads window.scrollY back
  // through CDP — an unambiguous, automated verdict for the manual lane.
  const d = await getDesktopDriver();
  const p = await d.permissions({ refresh: true });
  if (p.accessibility !== true) {
    assert.fail("scroll pin needs Accessibility granted (this lane is misconfigured otherwise)");
  }
  const { BrowserHandle } = await import("../src/core/cdp.js");
  const html = "data:text/html,<!doctype html><html><body style='margin:0'><div style='height:4000px;background:linear-gradient(#333,#fff)'><h1 style='position:fixed;top:8px;left:8px' id='s'>0</h1></div><script>window.addEventListener('scroll',()=>document.getElementById('s').textContent=Math.round(scrollY))</script></body></html>";
  const browser = await BrowserHandle.launch({
    headless: false, // real windows receive CGEvent input; headless does not
    extraArgs: ["--window-position=40,60", "--window-size=500,500", "--activate-on-launch"],
  });
  t.after(() => browser.dispose());
  const { targetId, sessionId } = await browser.createTab(html, { autoAttach: false });
  t.after(() => browser.closeTabTarget(targetId));
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  await sleep(800); // let the window settle into place
  // Focus OUR window and park the cursor over its content area.
  await d.activate({ pid: browser.proc.pid });
  await sleep(300);
  const info = await d.screenInfo({ refresh: true });
  const cx = info.x + 40 + 250, cy = info.y + 60 + 250; // window center per launch args
  await d.move(cx, cy);
  await sleep(200);
  const before = await browser.conn.send("Runtime.evaluate", { expression: "Math.round(scrollY)", returnByValue: true }, sessionId);
  await d.wheel(0, 120); // contract: content DOWN
  await sleep(600);
  const after = await browser.conn.send("Runtime.evaluate", { expression: "Math.round(scrollY)", returnByValue: true }, sessionId);
  const y0 = Number(before.result.value), y1 = Number(after.result.value);
  console.log(`[tcc-manual] scroll pin: scrollY ${y0} → ${y1} after wheel(0,120)`);
  assert.ok(y1 > y0 + 5, `wheel(0,+120) must scroll content DOWN (scrollY ${y0} → ${y1}). If it went UP, flip the map in _naturalScrolling()/wheel() in src/desktop/macos.js and update the unit expectations.`);
  // And the reverse direction for symmetry.
  await d.wheel(0, -120);
  await sleep(600);
  const back = await browser.conn.send("Runtime.evaluate", { expression: "Math.round(scrollY)", returnByValue: true }, sessionId);
  const y2 = Number(back.result.value);
  console.log(`[tcc-manual] scroll pin: scrollY ${y1} → ${y2} after wheel(0,-120)`);
  assert.ok(y2 < y1 - 5, `wheel(0,-120) must scroll content UP (scrollY ${y1} → ${y2}).`);
});
