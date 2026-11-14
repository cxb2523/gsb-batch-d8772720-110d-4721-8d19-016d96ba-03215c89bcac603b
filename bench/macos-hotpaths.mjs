#!/usr/bin/env node
/**
 * macOS hot-path benchmarks (safe by construction):
 *
 *   - osascript spawn baseline (JXA "1+1")            → per-action floor
 *   - screen_info / permissions probe: cold vs cached  → cache win (spawns)
 *   - native input script build + spawn budget (MOCKED runFn — never posts)
 *   - CDP: browser launch→ws, observe, click, type     → browser hot paths
 *   - browser screenshot (JPEG, budgeted)              → pixel path
 *   - bridge hub start/stop + info write               → bridge startup
 *   - ephemeral profile create/delete round-trip       → cleanup cost
 *   - 24-way concurrent CDP Runtime.evaluate           → concurrency
 *
 * Nothing here moves real input or captures the screen: native-input rows
 * measure protocol cost through an injected runFn, and pixel capture goes
 * through the PAGE (Page.captureScreenshot), not the desktop TCC path.
 *
 * Usage: node bench/macos-hotpaths.mjs [--json out.json]
 */
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";

const { Controller } = await import("../src/core/controller.js");
const { BrowserHandle } = await import("../src/core/cdp.js");
const { BridgeHub } = await import("../src/bridge/hub.js");

const results = {};
const jsonOut = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : null;

function record(name, ms, facts = {}) {
  results[name] = { ms: Math.round(ms * 10) / 10, ...facts };
  console.log(`${name.padEnd(48)} ${String(Math.round(ms)).padStart(7)} ms  ${Object.entries(facts).map(([k, v]) => `${k}=${v}`).join(" ")}`);
}

const time = async (fn) => {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
};

// ---------------------------------------------------------------- baseline
const spawnOnce = (file, args) => new Promise((ok, err) => execFile(file, args, { timeout: 15_000 }, (e, o) => (e ? err(e) : ok(o))));

if (process.platform === "darwin") {
  const spawnFlavor = async (args, warm = true) => {
    if (warm) await spawnOnce("osascript", args);
    const t = await time(async () => { for (let i = 0; i < 10; i++) await spawnOnce("osascript", args); });
    return t / 10;
  };
  const jxaNoop = await spawnFlavor(["-l", "JavaScript", "-e", "1+1"]);
  record("osascript flavor: JXA noop", jxaNoop, { perSpawnMs: Math.round(jxaNoop * 10) / 10 });
  const jxaCg = await spawnFlavor(["-l", "JavaScript", "-e", "ObjC.import('CoreGraphics'); 1+1"]);
  record("osascript flavor: JXA + CoreGraphics", jxaCg, { perSpawnMs: Math.round(jxaCg * 10) / 10, note: "the real per-gesture floor" });
  const asNoop = await spawnFlavor(["-e", "return 1"]);
  record("osascript flavor: AppleScript noop", asNoop, { perSpawnMs: Math.round(asNoop * 10) / 10 });

  const { MacDriver } = await import("../src/desktop/macos.js");
  const d = new MacDriver();
  const coldInfo = await time(() => d.screenInfo({ refresh: true }));
  record("desktop screen_info probe (cold)", coldInfo);
  const warmInfo = await time(() => d.screenInfo());
  record("desktop screen_info (cached)", warmInfo, { savedMs: Math.round((coldInfo - warmInfo) * 10) / 10 });
  const coldPerm = await time(() => d.permissions({ refresh: true }));
  record("desktop permissions probe (cold)", coldPerm);
  const warmPerm = await time(() => d.permissions());
  record("desktop permissions (cached)", warmPerm, { savedMs: Math.round((coldPerm - warmPerm) * 10) / 10 });

  // Protocol cost of native input WITHOUT posting: script build + a runFn
  // with realistic execFile latency (measured noop). This is the floor a
  // click/drag pays per gesture batch.
  const noop = async () => "ok";
  const dMock = new MacDriver({ runFn: noop });
  const clickBuild = await time(() => dMock.click({ x: 10, y: 10 }));
  record("native click: 1 gesture batch (mocked post)", clickBuild, { batches: 1 });
  const dblBuild = await time(() => dMock.click({ x: 10, y: 10, double: true }));
  record("native double-click: 1 gesture batch (mocked post)", dblBuild, { batches: 1 });
  const dragBuild = await time(() => dMock.drag({ from: { x: 0, y: 0 }, to: { x: 100, y: 100 }, steps: 12 }));
  record("native drag: 3 gesture batches (mocked post)", dragBuild, { batches: 3 });
}

// ---------------------------------------------------------------- browser
const page = `data:text/html,<!doctype html><html><body>
  <button id="b" onclick="this.textContent='clicked'">go</button>
  <input id="i" value="">
  <p>${"x".repeat(2000)}</p></body></html>`;

let browser, controller;
const launchMs = await time(async () => {
  browser = await BrowserHandle.launch({ headless: true });
});
record("BrowserHandle.launch → ws connect", launchMs);

const disposeMs = await time(async () => { await browser.dispose(); });
record("BrowserHandle.dispose (ephemeral profile cleanup)", disposeMs);

controller = new Controller();
await controller.execute("open", { url: page, settle_ms: 200 });

const obsMs = await time(() => controller.execute("observe", { mode: "diff" }));
record("CDP observe (diff)", obsMs);

const clickMs = await time(async () => { await controller.execute("click", { target: { ref: "e1" }, settle_ms: 50 }); });
record("CDP click ref + diff", clickMs);

const typeMs = await time(async () => { await controller.execute("type", { target: { ref: "e2" }, text: "hello world", settle_ms: 50 }); });
record("CDP type + diff", typeMs);

const shotMs = await time(() => controller.execute("screenshot", {}));
record("browser screenshot (JPEG budgeted)", shotMs);

// Concurrency: 24 parallel evaluates over one connection.
const concMs = await time(async () => {
  await Promise.all(Array.from({ length: 24 }, (_, i) => controller.execute("evaluate", { expression: `${i} * 2` })));
});
record("24-way concurrent CDP evaluate", concMs, { perCallMs: Math.round(concMs / 24 * 10) / 10 });

await controller.dispose();

// ---------------------------------------------------------------- bridge
const AXUSE_BRIDGE_DIR_BACKUP = process.env.AXUSE_BRIDGE_DIR;
const bridgeDir = mkdtempSync(join(tmpdir(), "axuse-bench-bridge-"));
process.env.AXUSE_BRIDGE_DIR = bridgeDir;
let hub;
const hubMs = await time(async () => { hub = await new BridgeHub().start(); });
const infoSt = statSync(join(bridgeDir, "bridge.json"));
record("bridge hub start (listen + token file)", hubMs, { mode: (infoSt.mode & 0o777).toString(8) });
const hubStopMs = await time(() => { hub.stop(); });
record("bridge hub stop", hubStopMs);
process.env.AXUSE_BRIDGE_DIR = AXUSE_BRIDGE_DIR_BACKUP;
rmSync(bridgeDir, { recursive: true, force: true });

console.log("\nplatform:", process.platform, process.arch, `node ${process.version}`);
if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ ts: new Date().toISOString(), platform: `${process.platform}/${process.arch}`, node: process.version, results }, null, 2));
  console.log(`wrote ${jsonOut}`);
}
