/**
 * Extension bridge E2E test — the full Codex-style chain, live:
 *   installBridge (registry/manifest + platform launcher)
 *   → in-process hub (info file with port/token)
 *   → Chromium-family browser launched with --load-extension (the bridge
 *     extension; Edge honors --load-extension where branded Chrome ignores
 *     it, so Edge is preferred on Windows)
 *   → extension service worker connectNative → browser spawns the launcher
 *     → node nm-host.js → hub hello (ext-online)
 *   → Controller ax_open {backend:"extension"} drives the tab through
 *     chrome.debugger (trusted CDP in the user's browser)
 *   → observe / click ref / diff / events / close (tabs, not the browser)
 *
 * Gated on an extension-capable browser. Cleans up the registry entry after.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { accessSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateBrowser, BrowserHandle } from "../src/core/cdp.js";
import { Controller } from "../src/core/controller.js";
import { installBridge, uninstallBridge, nativeMessagingDir, EXTENSION_DIR } from "../src/bridge/install.js";
import { BridgeHub, getBridge } from "../src/bridge/hub.js";

/** Branded Chrome ignores --load-extension (137+); Edge honors it. */
function extensionCapableBrowser() {
  const edgeCandidates = process.platform === "win32"
    ? ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"]
    : process.platform === "darwin"
      ? ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
      : ["/usr/bin/microsoft-edge"];
  for (const c of edgeCandidates) {
    try { accessSync(c); return c; } catch {}
  }
  // Branded Chrome 137+ silently ignores --load-extension (macOS .app builds
  // AND the Linux distro packages — live-verified). The capability probe
  // excludes both; users can still load unpacked extensions manually in
  // their normal Chrome profile.
  return locateBrowser({ extensionCapable: process.platform !== "win32" });
}

function browserKind(executable) {
  if (/Microsoft Edge/i.test(executable)) return "edge";
  if (/Chrome for Testing|google-chrome-for-testing/i.test(executable)) return "chrome-for-testing";
  if (/Chromium|\/chromium$/i.test(executable)) return "chromium";
  return "chrome";
}

const extensionBrowser = extensionCapableBrowser();
const extensionSkip = extensionBrowser ? false : "no extension-capable Edge/Chromium/Chrome-for-Testing binary found";

test("macOS native-host installer writes an executable, isolated registration", { skip: process.platform !== "darwin" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "axuse bridge install-"));
  const stateDir = join(root, "state");
  const manifestDir = join(root, "native-messaging");
  try {
    const installed = await installBridge({ browser: "chrome", stateDir, manifestDir });
    assert.ok(installed.hostPath.startsWith(stateDir));
    assert.ok((statSync(installed.hostPath).mode & 0o111) !== 0, "host launcher is executable");
    const manifestPath = join(manifestDir, "com.axuse.bridge.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.path, installed.hostPath);
    assert.deepEqual(manifest.allowed_extensions, [installed.extensionId]);
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${installed.extensionId}/`]);
    const removed = await uninstallBridge({ browser: "chrome", stateDir, manifestDir });
    assert.ok(removed.removed.includes(manifestPath));
    assert.equal(existsSync(manifestPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS native-host directories match each Chromium-family browser", { skip: process.platform !== "darwin" }, () => {
  assert.match(nativeMessagingDir("chrome"), /Google\/Chrome\/NativeMessagingHosts$/);
  assert.match(nativeMessagingDir("edge"), /Microsoft Edge\/NativeMessagingHosts$/);
  assert.match(nativeMessagingDir("chromium"), /Chromium\/NativeMessagingHosts$/);
  assert.match(nativeMessagingDir("chrome-for-testing"), /Google\/ChromeForTesting\/NativeMessagingHosts$/);
});

test("macOS uninstall preserves a shared launcher while another browser remains registered", { skip: process.platform !== "darwin" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "axuse bridge multi-"));
  const previousHome = process.env.HOME;
  process.env.HOME = join(root, "home");
  const stateDir = join(root, "state");
  try {
    const chrome = await installBridge({ browser: "chrome", stateDir });
    const edge = await installBridge({ browser: "edge", stateDir });
    assert.equal(chrome.hostPath, edge.hostPath);
    const launcher = chrome.hostPath;
    await uninstallBridge({ browser: "chrome", stateDir });
    assert.equal(existsSync(launcher), true, "Edge still references the shared launcher");
    assert.equal(existsSync(join(nativeMessagingDir("edge"), "com.axuse.bridge.json")), true);
    await uninstallBridge({ browser: "edge", stateDir });
    assert.equal(existsSync(launcher), false, "last registration removes the launcher");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS native-host launcher reaches an isolated hub", { skip: process.platform !== "darwin" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "axuse bridge host-"));
  const previousDir = process.env.AXUSE_BRIDGE_DIR;
  process.env.AXUSE_BRIDGE_DIR = root;
  const hub = await new BridgeHub().start();
  const stateDir = join(root, "state");
  const manifestDir = join(root, "native-messaging");
  let child;
  try {
    const installed = await installBridge({ browser: "chrome", stateDir, manifestDir });
    child = spawn(installed.hostPath, [], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, AXUSE_BRIDGE_DIR: root } });
    child.on("error", () => {});
    child.stderr.resume();
    await hub.waitExt(5_000);
    assert.equal(hub.extOnline(), true);
  } finally {
    try { child?.kill(); } catch {}
    hub.stop();
    if (previousDir === undefined) delete process.env.AXUSE_BRIDGE_DIR;
    else process.env.AXUSE_BRIDGE_DIR = previousDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test("native-host launcher survives the installing node binary moving (fallback to PATH node)", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "axuse launcher-"));
  try {
    const { installBridge } = await import("../src/bridge/install.js");
    const installed = await installBridge({ browser: "chrome", stateDir: join(root, "state"), manifestDir: join(root, "nm") });
    const script = readFileSync(installed.hostPath, "utf8");
    assert.match(script, /if \[ -x ".*" \]; then exec ".*" ".*nm-host\.js" "\$@"; fi/, "primary path guarded by an -x existence check");
    assert.match(script, /exec node ".*nm-host\.js" "\$@"/, "PATH-node fallback present — node upgrades cannot orphan the host");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extension backend: a stalled Page.navigate RPC falls back to location.href and reports it", async () => {
  const { ExtensionBrowser } = await import("../src/bridge/backend.js");
  const { AxError, Codes } = await import("../src/core/errors.js");
  const sent = [];
  let timer;
  const bridge = {
    onEvent: () => () => {},
    rpc: (method, params) => new Promise((resolve, reject) => {
      sent.push({ method, params });
      if (method === "cdp" && params.method === "Page.navigate") {
        // Simulate the trunk-Chromium stall: the real hub raises the typed
        // TIMEOUT after its RPC window.
        timer = setTimeout(() => reject(new AxError(Codes.TIMEOUT, `bridge rpc "cdp" timed out`, { retry: "retry" })), 30);
        return;
      }
      resolve({ ok: true, result: { result: { value: params.params.expression.slice(0, 40) } } });
    }),
  };
  const b = new ExtensionBrowser(bridge);
  try {
    const res = await b.conn.send("Page.navigate", { url: "https://example.test/" }, "77");
    assert.match(res.via ?? "", /location\.href/, "the result says how it navigated");
    const fallback = sent.find((s) => s.params.method === "Runtime.evaluate");
    assert.ok(fallback, "the fallback went through Runtime.evaluate");
    assert.match(fallback.params.params.expression, /location\.href = "https:\/\/example\.test\/"/);
  } finally {
    clearTimeout(timer);
    b.dispose();
  }
});

test("extension bridge: install → native messaging → drive the browser", { skip: extensionSkip }, async (t) => {
  const browser = browserKind(extensionBrowser);
  const profileDir = mkdtempSync(join(tmpdir(), "axuse extension profile-"));
  const manifestDir = join(profileDir, "NativeMessagingHosts");
  let chrome;
  // 1. Register the native messaging host in the directory for the binary
  // under test (Edge, Chromium, or Chrome for Testing on macOS).
  // BrowserHandle uses an isolated --user-data-dir; Chromium resolves the
  // user-scoped native-host directory relative to that profile.
  const inst = await installBridge({ browser, manifestDir });
  assert.ok(inst.hostPath, "host path was created");
  assert.match(inst.extensionId, /^[a-p]{32}$/, "extension id derived from the manifest key");

  t.after(async () => {
    try { await chrome?.dispose(); } finally {
      try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
    }
  });
  t.after(async () => {
    try { await uninstallBridge({ browser, manifestDir }); } catch {}
  });

  // 2. Start the hub in-process (the info file is what the spawned nm-host reads).
  const bridge = await getBridge();
  if (typeof bridge.stop === "function") t.after(() => bridge.stop());

  // 3. Launch the browser with the bridge extension loaded.
  const extPath = EXTENSION_DIR.replaceAll("\\", "/");
  chrome = await BrowserHandle.launch({
    executablePath: extensionBrowser,
    headless: true,
    userDataDir: profileDir,
    extraArgs: [`--load-extension=${extPath}`],
  });

  // 4. The extension must dial in through native messaging.
  await bridge.waitExt(30_000);
  assert.equal(bridge.extOnline(), true, "extension connected via native messaging");

  // 5. Drive it through the frozen command contract.
  const pageHtml = `<!doctype html><html><body>
    <h1>bridge fixture</h1>
    <button id="b" onclick="document.getElementById('o').textContent='ext done'">go</button>
    <div id="o" style="min-height:1em"></div>
  </body></html>`;
  const srv = http.createServer((q, r) => { r.setHeader("content-type", "text/html"); r.end(pageHtml); });
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  t.after(() => srv.close());

  const c = new Controller();
  const opened = await c.execute("open", {
    backend: "extension",
    url: `http://127.0.0.1:${srv.address().port}/`,
    settle_ms: 400,
  });
  assert.equal(opened.observation.mode, "full");
  assert.match(opened.observation.text, /button "go"/, "snapshot came through chrome.debugger");
  const ref = opened.observation.text.match(/button "go"[^\[]*\[ref=(e\d+)\]/)[1];

  const clicked = await c.execute("click", { target: { ref }, settle_ms: 300 });
  assert.equal(clicked.action_sent, "sent");
  assert.match(clicked.observation.text, /ext done/, "trusted click landed and the diff saw it");

  // Stale refs fail typed, as on every backend.
  await assert.rejects(
    () => c.execute("click", { target: { ref: "e999" } }),
    (e) => e.code === "REF_NOT_FOUND",
  );

  // Events flow from the user's browser through the bridge.
  const ev = await c.execute("events", {});
  assert.ok(Array.isArray(ev.events));

  // close closes OUR tabs — the browser itself keeps running (user's).
  await c.execute("close", { browser: true });
  const tabs = await c.execute("tabs", {});
  assert.equal(tabs.tabs.length, 0);
});
