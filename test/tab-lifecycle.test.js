/**
 * Tab lifecycle regressions from the 2026-10-21 field report (extension
 * backend, 20+ agents on one server):
 *   1. hidden tabs: SPAs wired on rAF never initialise → visible-tab guard
 *   2. a failed ax_open leaked an untracked about:blank tab
 *   3. omitted backend landed in a separate, not-signed-in browser
 *   4. detach / tab removal: domains re-enabled, clear causes, explicit tab_id
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Controller } from "../src/core/controller.js";
import { locateBrowser } from "../src/core/cdp.js";
import { ExtensionBrowser, __resetProbeForTests } from "../src/bridge/backend.js";
import { getBridge, __resetBridgeForTests } from "../src/bridge/hub.js";

/** A bridge double: records rpc calls, answers from `answer(method, params)`. */
function fakeBridge(answer) {
  const handlers = new Set();
  const sent = [];
  return {
    sent,
    emit: (e) => { for (const h of handlers) h(e); },
    onEvent: (h) => { handlers.add(h); return () => handlers.delete(h); },
    extOnline: () => true,
    rpc: async (method, params) => {
      sent.push({ method, params });
      return answer(method, params) ?? { ok: true, result: {} };
    },
  };
}

/** Register a tab on a fake extension-backed browser record. */
function fakeExtensionTab(c, bridge, sessionId = "41") {
  const handle = new ExtensionBrowser(bridge);
  const rec = { browserId: "b1", handle, tabs: new Set(), key: "extension" };
  c.browsers.set("b1", rec);
  c.browserIndex.set("extension", "b1");
  return c.registerTab(rec, sessionId, sessionId, "about:blank");
}

test("visible-tab guard: a hidden extension tab is brought forward before input", async () => {
  let visible = false;
  const bridge = fakeBridge((method, p) => {
    if (method === "activate_tab") { visible = true; return { ok: true, result: { active: true } }; }
    if (method === "cdp" && p.method === "Runtime.evaluate") {
      const value = p.params.expression === "document.visibilityState" ? (visible ? "visible" : "hidden") : true;
      return { ok: true, result: { result: { value } } };
    }
  });
  const c = new Controller();
  const tab = fakeExtensionTab(c, bridge);
  const res = await c.ensureVisible(tab);
  assert.deepEqual(res, { activated: true, visible: true });
  assert.ok(bridge.sent.some((s) => s.method === "activate_tab" && s.params.tabId === 41));
  assert.ok(!bridge.sent.some((s) => s.params?.method === "Page.captureScreenshot"), "no forced frame when activation worked");
  assert.ok(tab.events.some((e) => e.method === "tab.activated"));
  // Already visible: one cheap check, no activation.
  bridge.sent.length = 0;
  assert.equal(await c.ensureVisible(tab), null);
  assert.ok(!bridge.sent.some((s) => s.method === "activate_tab"));
  for (const cmd of ["navigate", "click", "type", "press", "fill", "wait_for"]) {
    assert.ok(Controller.VISIBLE_COMMANDS.has(cmd), `${cmd} runs the guard`);
  }
});

test("visible-tab guard: an occluded window still gets one forced frame", async () => {
  const bridge = fakeBridge((method, p) => {
    if (method === "activate_tab") return { ok: true, result: { active: true } };
    if (method === "cdp" && p.method === "Runtime.evaluate") {
      return { ok: true, result: { result: { value: p.params.expression === "document.visibilityState" ? "hidden" : true } } };
    }
  });
  const c = new Controller();
  const tab = fakeExtensionTab(c, bridge);
  const res = await c.ensureVisible(tab);
  assert.equal(res.visible, false);
  assert.ok(bridge.sent.some((s) => s.params?.method === "Page.captureScreenshot"), "1x1 capture forces a frame");
});

test("visible-tab guard: old extensions fall back to Page.bringToFront", async () => {
  const bridge = fakeBridge((method) => {
    if (method === "activate_tab") return { ok: false, error: "unknown method activate_tab" };
  });
  const b = new ExtensionBrowser(bridge);
  const res = await b.bringToFront("9");
  assert.equal(res.via, "Page.bringToFront");
  assert.ok(bridge.sent.some((s) => s.params?.method === "Page.bringToFront" && s.params.tabId === 9));
});

test("extension createTab closes the tab when the domain enables fail", async () => {
  const bridge = fakeBridge((method, p) => {
    if (method === "open_tab") return { ok: true, result: { tabId: 77 } };
    if (method === "cdp" && p.method === "Page.enable") return { ok: false, error: "Cannot access a chrome:// URL" };
  });
  const b = new ExtensionBrowser(bridge);
  await assert.rejects(() => b.createTab("about:blank"));
  assert.ok(bridge.sent.some((s) => s.method === "close_tab" && s.params.tabId === 77), "the created tab was closed");
  assert.equal(b.createdTargets.size, 0);
});

test("a failed ax_open closes the tab it created and reports it (download → ERR_ABORTED)", async (t) => {
  if (!locateBrowser()) return t.skip("no Chromium-family browser");
  const srv = http.createServer((q, r) => {
    r.setHeader("content-type", "application/octet-stream");
    r.setHeader("content-disposition", 'attachment; filename="dummy.bin"');
    r.end(Buffer.alloc(64));
  });
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  t.after(() => srv.close());
  const c = new Controller();
  t.after(() => c.dispose());
  const err = await c.execute("open", { url: `http://127.0.0.1:${srv.address().port}/dummy.bin`, headless: true }).then(
    () => { throw new Error("expected the download navigation to fail"); },
    (e) => e,
  );
  assert.equal(err.code, "NAVIGATION_IN_PROGRESS");
  assert.equal(err.toJSON().tab_closed, true, "the error says the tab was closed");
  assert.equal((await c.execute("tabs", {})).tabs.length, 0, "nothing left in the tab table");
  const rec = [...c.browsers.values()][0];
  const { targetInfos } = await rec.handle.conn.send("Target.getTargets", {});
  // (The launch's own chrome://newtab/ page is not ours.)
  const orphans = targetInfos.filter((ti) => ti.type === "page" && !ti.url.startsWith("chrome://"));
  assert.deepEqual(orphans.map((ti) => ti.url), [], "no orphan page target in the browser");
});

test("debugger detach: domains are re-enabled before the next command", async () => {
  const bridge = fakeBridge((method, p) => (method === "cdp" ? { ok: true, result: { ok: p.method } } : undefined));
  const b = new ExtensionBrowser(bridge);
  bridge.emit({ sessionId: "5", method: "debugger.detached", params: { reason: "target_closed" } });
  bridge.sent.length = 0;
  await b.conn.send("Runtime.evaluate", { expression: "1" }, "5");
  assert.deepEqual(bridge.sent.map((s) => s.params.method), ["Page.enable", "Runtime.enable", "Log.enable", "Runtime.evaluate"]);
  bridge.sent.length = 0;
  await b.conn.send("Runtime.evaluate", { expression: "1" }, "5");
  assert.deepEqual(bridge.sent.map((s) => s.params.method), ["Runtime.evaluate"], "only once per detach");
});

test("tab removed outside axuse: deregistered, later calls name the cause", async () => {
  const prev = process.env.AXUSE_REQUIRE_TAB_ID;
  const bridge = fakeBridge((method) => (method === "cdp" ? { ok: false, error: "No tab with given id 41." } : undefined));
  const c = new Controller();
  const tab = fakeExtensionTab(c, bridge, "41");
  bridge.emit({ sessionId: "41", method: "tab.removed", params: { cause: "closed_outside_axuse" } });
  assert.equal(c.tabs.size, 0);
  assert.equal(c.activeTabId, null, "a gone tab never stays the implicit target");
  await assert.rejects(() => c.execute("observe", { tab_id: tab.tabId }),
    (e) => e.code === "NO_TAB" && /closed outside axuse/.test(e.message));
  // Chrome's bare "No tab with given id" becomes a typed NO_TAB.
  await assert.rejects(() => tab.browser.handle.conn.send("Runtime.evaluate", {}, "99"),
    (e) => e.code === "NO_TAB" && /gone/.test(e.message));
  if (prev === undefined) delete process.env.AXUSE_REQUIRE_TAB_ID; else process.env.AXUSE_REQUIRE_TAB_ID = prev;
});

test("tab_id is required once more than one tab is controlled", async () => {
  const prev = process.env.AXUSE_REQUIRE_TAB_ID;
  const bridge = fakeBridge(() => undefined);
  const c = new Controller();
  const a = fakeExtensionTab(c, bridge, "1");
  const b = fakeExtensionTab(c, bridge, "2");
  try {
    assert.throws(() => c.tabOrActive(undefined), (e) => e.code === "COMMAND_REJECTED" && /tab_id is required: 2 tabs/.test(e.message));
    assert.equal(c.tabOrActive(a.tabId), a);
    process.env.AXUSE_REQUIRE_TAB_ID = "0";
    assert.equal(c.tabOrActive(undefined), b, "opt-out restores the active-tab default");
    delete process.env.AXUSE_REQUIRE_TAB_ID;
    c.deregisterTab(b);
    assert.equal(c.tabOrActive(undefined), a, "a single tab stays implicit");
  } finally {
    if (prev === undefined) delete process.env.AXUSE_REQUIRE_TAB_ID; else process.env.AXUSE_REQUIRE_TAB_ID = prev;
  }
});

test("backend default: auto picks the connected extension, else cdp; pins and launch options win", async () => {
  const saved = { AXUSE_BACKEND: process.env.AXUSE_BACKEND, AXUSE_BRIDGE_DIR: process.env.AXUSE_BRIDGE_DIR, HOME: process.env.HOME };
  const root = mkdtempSync(join(tmpdir(), "axuse backend-auto-"));
  let hub = null;
  let ext = null;
  try {
    process.env.AXUSE_BRIDGE_DIR = join(root, "bridge");
    process.env.HOME = join(root, "home"); // no native-host registration here
    const c = new Controller();
    process.env.AXUSE_BACKEND = "cdp";
    assert.deepEqual(await c.resolveBackend({}, false), { backend: "cdp", reason: "AXUSE_BACKEND" });
    process.env.AXUSE_BACKEND = "auto";
    assert.equal((await c.resolveBackend({ backend: "extension" }, false)).backend, "extension");
    assert.equal((await c.resolveBackend({ cdp_url: "http://127.0.0.1:9222" }, false)).backend, "cdp");
    assert.equal((await c.resolveBackend({}, true)).reason, "launch option");
    __resetProbeForTests();
    __resetBridgeForTests();
    assert.deepEqual(await c.resolveBackend({}, false), { backend: "cdp", reason: "no axuse extension connected" });

    // A hub with a connected extension host → auto picks the extension.
    __resetProbeForTests();
    __resetBridgeForTests();
    hub = await getBridge();
    ext = net.connect(hub.port, "127.0.0.1");
    await once(ext, "connect");
    ext.write(JSON.stringify({ t: "hello", role: "extension-host", token: hub.token }) + "\n");
    await hub.waitExt(5000);
    assert.deepEqual(await c.resolveBackend({}, false), { backend: "extension", reason: "axuse extension connected" });
  } finally {
    try { ext?.destroy(); } catch {}
    try { hub?.stop?.(); } catch {}
    __resetBridgeForTests();
    __resetProbeForTests();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(root, { recursive: true, force: true });
  }
});

test("idle reaper closes tabs nobody touched and says why", async () => {
  const bridge = fakeBridge(() => undefined);
  const c = new Controller();
  try {
    const old = fakeExtensionTab(c, bridge, "11");
    const fresh = fakeExtensionTab(c, bridge, "12");
    const now = Date.now();
    old.lastUsedAt = now - 31 * 60_000;
    fresh.lastUsedAt = now - 60_000;
    assert.deepEqual(await c.reapIdleTabs(now), [old.tabId]);
    assert.ok(bridge.sent.some((s) => s.method === "close_tab" && s.params.tabId === 11));
    assert.ok(c.tabs.has(fresh.tabId));
    assert.throws(() => c.tabOrActive(old.tabId), (e) => e.code === "NO_TAB" && /unused/.test(e.message));
  } finally {
    await c.dispose();
  }
});

test("hub closes the tabs of a client that disconnected", async () => {
  const saved = process.env.AXUSE_BRIDGE_DIR;
  const root = mkdtempSync(join(tmpdir(), "axuse hub-client-"));
  process.env.AXUSE_BRIDGE_DIR = root;
  const { BridgeHub, BridgeClient } = await import("../src/bridge/hub.js");
  const hub = await new BridgeHub().start();
  const ext = net.connect(hub.port, "127.0.0.1");
  try {
    await once(ext, "connect");
    const seen = [];
    let buf = "";
    ext.on("data", (d) => {
      buf += String(d);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (msg.t !== "req") continue;
        seen.push(msg);
        const result = msg.method === "open_tab" ? { tabId: 500 + seen.length } : { closed: true };
        ext.write(JSON.stringify({ t: "res", id: msg.id, ok: true, result }) + "\n");
      }
    });
    ext.write(JSON.stringify({ t: "hello", role: "extension-host", token: hub.token }) + "\n");
    await hub.waitExt(5000);
    const client = await new BridgeClient().connect({ port: hub.port, token: hub.token }, 3000);
    const a = await client.rpc("open_tab", { url: "about:blank" });
    const b = await client.rpc("open_tab", { url: "about:blank" });
    await client.rpc("close_tab", { tabId: a.result.tabId });
    seen.length = 0;
    client.close();
    for (let i = 0; i < 40 && !seen.length; i++) await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual(seen.map((m) => [m.method, m.params.tabId]), [["close_tab", b.result.tabId]], "only the still-open tab is closed");
  } finally {
    ext.destroy();
    hub.stop();
    if (saved === undefined) delete process.env.AXUSE_BRIDGE_DIR; else process.env.AXUSE_BRIDGE_DIR = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test("extension backend: data: HTML loads via setDocumentContent; other types fail clearly", async () => {
  const bridge = fakeBridge((method, p) => {
    if (method !== "cdp") return undefined;
    if (p.method === "Page.getFrameTree") return { ok: true, result: { frameTree: { frame: { id: "F1" } } } };
    if (p.method === "Runtime.evaluate") return { ok: true, result: { result: { value: "complete" } } };
  });
  const c = new Controller();
  const tab = fakeExtensionTab(c, bridge, "21");
  await c.navigateInTab(tab, "data:text/html," + encodeURIComponent("<h1>hi</h1>"), 0);
  const set = bridge.sent.find((s) => s.params?.method === "Page.setDocumentContent");
  assert.deepEqual(set.params.params, { frameId: "F1", html: "<h1>hi</h1>" });
  assert.ok(!bridge.sent.some((s) => s.params?.method === "Page.navigate" && /^data:/.test(s.params.params.url)));
  bridge.sent.length = 0;
  await c.navigateInTab(tab, "data:text/html;base64," + Buffer.from("<p>b64</p>").toString("base64"), 0);
  assert.equal(bridge.sent.find((s) => s.params?.method === "Page.setDocumentContent").params.params.html, "<p>b64</p>");
  await assert.rejects(() => c.navigateInTab(tab, "data:image/png;base64,AAAA", 0),
    (e) => e.code === "COMMAND_REJECTED" && /localhost/.test(e.hint));
});

test("cut snapshots say why and how to read everything; mode text returns it", async (t) => {
  if (!locateBrowser()) return t.skip("no Chromium-family browser");
  const para = "Lorem ipsum dolor sit amet. ".repeat(40);
  const page = (n) => `<!doctype html><title>long</title>${Array.from({ length: n }, (_, i) => `<p>p${i} ${para}</p>`).join("")}<p>THE-END-MARKER</p>`;
  const srv = http.createServer((q, r) => {
    r.setHeader("content-type", "text/html");
    r.end(page(Number(new URL(q.url, "http://x").searchParams.get("n"))));
  });
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const c = new Controller();
  t.after(() => c.dispose());
  const notes = (o) => o.observation.text.split("\n").filter((l) => l.startsWith("note:")).join("\n");

  const big = await c.execute("open", { url: `${base}?n=300`, headless: true });
  assert.match(notes(big), /truncated by the 24000-char budget — ax_observe \{mode:"text"\}/);

  // Under budget, but every paragraph is shortened in the snapshot.
  const medium = await c.execute("navigate", { tab_id: big.tab_id, url: `${base}?n=60` });
  assert.match(notes(medium), /60 long texts shortened with "…" — ax_observe \{mode:"text"\}/);
  const full = await c.execute("observe", { tab_id: big.tab_id, mode: "text" });
  assert.equal(full.observation.mode, "text");
  assert.equal(full.observation.truncated, false);
  assert.ok(full.observation.chars > 60 * para.length, "every paragraph, unclipped");
  assert.match(full.observation.text, /THE-END-MARKER/);
});
