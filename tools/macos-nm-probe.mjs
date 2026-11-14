/**
 * macOS browser-matrix probe: for each installed Chromium-family browser,
 * verify the FULL native-messaging chain against the real (default)
 * NativeMessagingHosts dir — install → launch with an isolated profile +
 * --load-extension → hub → extension connectNative → drive a tab → cleanup.
 *
 * Usage: node tools/macos-nm-probe.mjs [browser-id ...]
 * Browser ids: chrome, chrome-for-testing, chromium, edge
 */
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installBridge, uninstallBridge } from "../src/bridge/install.js";
import { getBridge } from "../src/bridge/hub.js";
import { locateBrowser, BrowserHandle } from "../src/core/cdp.js";
import { Controller } from "../src/core/controller.js";

// Browser id (installBridge accepts chrome | edge | chromium |
// chrome-for-testing) → discovery selector. Binaries resolve via the core's
// own locateBrowser: an AXUSE_BIN_<ID> env override wins (matrix testing
// against side-installed builds), then the standard discovery candidates.
const SELECTORS = {
  chrome: { browser: "chrome", exact: true },
  "chrome-for-testing": { browser: "chrome-for-testing" },
  chromium: { browser: "chromium" },
  edge: { browser: "edge" },
};

function binaryFor(id) {
  const override = process.env[`AXUSE_BIN_${id.replaceAll("-", "_").toUpperCase()}`];
  if (override) return override;
  return locateBrowser(SELECTORS[id] ?? {});
}

const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(MAC_BINARIES);
process.env.AXUSE_BRIDGE_DIR = mkdtempSync(join(tmpdir(), "axuse-nm-probe-"));

let failures = 0;
for (const id of want) {
  const exe = binaryFor(id);
  if (!exe || !existsSync(exe)) { console.log(`SKIP ${id}: binary not present (set AXUSE_BIN_${id.replaceAll("-", "_").toUpperCase()} for side-installed builds)`); continue; }
  const profile = mkdtempSync(join(tmpdir(), `axuse-nm-probe-${id}-`));
  // Chromium resolves the user-scoped NativeMessagingHosts dir relative to
  // the ACTIVE --user-data-dir, so an isolated launch needs a profile-local
  // manifest (exactly what the E2E test does). The default-dir flow (the
  // user's daily browser) is covered by `axuse bridge install` writing to
  // the OS-default location, which the real profile resolves.
  const manifestDir = join(profile, "NativeMessagingHosts");
  let chrome = null, hub = null;
  console.log(`\n=== ${id} (${exe}) ===`);
  try {
    const inst = await installBridge({ browser: id, manifestDir });
    console.log(`  manifest: ${inst.registry}`);
    const hub = await getBridge();
    console.log(`  hub: 127.0.0.1:${hub.port} (${hub.constructor.name})`);
    chrome = await BrowserHandle.launch({
      executablePath: exe,
      headless: true,
      userDataDir: profile,
      extraArgs: [`--load-extension=${inst.extensionDir.replaceAll("\\", "/")}`],
    });
    await hub.waitExt(25_000);
    console.log("  ext: CONNECTED via native messaging (profile-local manifest)");
    const page = `<!doctype html><html><body><button id=b onclick="this.textContent='ok'">go</button></body></html>`;
    const srv = http.createServer((q, r) => { r.setHeader("content-type", "text/html"); r.end(page); });
    srv.listen(0, "127.0.0.1");
    await new Promise((ok) => srv.once("listening", ok));
    const c = new Controller();
    const opened = await c.execute("open", { backend: "extension", url: `http://127.0.0.1:${srv.address().port}/`, settle_ms: 400 });
    const ref = opened.observation.text.match(/button "go"[^\[]*\[ref=(e\d+)\]/)?.[1];
    const clicked = ref ? await c.execute("click", { target: { ref }, settle_ms: 300 }) : null;
    const ok = /ok/.test(clicked?.observation?.text ?? "");
    console.log(`  drive: open+click via chrome.debugger ${ok ? "OK" : "OBSERVED (click diff empty)"}`);
    await c.dispose();
    srv.close();
    if (!ok && !ref) throw new Error("could not observe or click through the extension");
  } catch (e) {
    failures++;
    console.log(`  FAIL: ${e.message}`);
  } finally {
    try { await chrome?.dispose(); } catch {}
    try { hub?.stop(); } catch {}
    try { await uninstallBridge({ browser: id, manifestDir }); } catch {}
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    // getBridge() caches per process; each iteration must start clean.
    const { __resetBridgeForTests } = await import("../src/bridge/hub.js");
    if (typeof __resetBridgeForTests === "function") __resetBridgeForTests();
  }
}
try { rmSync(process.env.AXUSE_BRIDGE_DIR, { recursive: true, force: true }); } catch {}
process.exit(failures ? 1 : 0);
