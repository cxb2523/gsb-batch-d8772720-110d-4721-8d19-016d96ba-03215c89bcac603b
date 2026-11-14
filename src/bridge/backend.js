/**
 * axuse bridge — backend.
 *
 * Lineage: Codex's tab_cdp_call over chrome.debugger — the extension holds
 * real CDP over the user's real browser (cookies, logged-in sessions, 2FA
 * devices all present), and the harness drives it through a thin transport.
 * ExtensionBrowser duck-types the surface the Controller already uses for
 * CDP-launched browsers (conn/createTab/closeTabTarget/dispose), so the
 * entire frozen command contract — snapshots, diffs, trusted input, budgets
 * — runs unchanged against the user's daily Chrome.
 *
 * Known backend gap (documented honestly): chrome.debugger exposes no
 * Target domain, so OOPIF frames are listed but not entered here (the CDP
 * backend enters them).
 */
import { AxError, Codes } from "../core/errors.js";
import { getBridge } from "./hub.js";

/** Domains the controller's event ring and settling rely on. */
const DOMAINS = ["Page.enable", "Runtime.enable", "Log.enable"];

/** conn-like surface over the bridge (duck-types CdpConnection where the
 *  controller cares: send / onEvent / close / closed). */
class ExtConn {
  constructor(bridge) {
    this.bridge = bridge;
    this.handlers = new Set();
    // tabId → detach reason: the debugger detached and the domains must be
    // re-enabled on the next command (re-attach happens in the extension).
    this.detached = new Map();
    // tabId → removal cause ("axuse_close" | "window_closed" | "closed_outside_axuse").
    this.removed = new Map();
    this.offRoute = bridge.onEvent((e) => {
      if (e.method === "debugger.detached" && e.sessionId) this.detached.set(e.sessionId, e.params?.reason ?? null);
      if (e.method === "tab.removed" && e.sessionId) {
        this.detached.delete(e.sessionId);
        this.removed.set(e.sessionId, e.params?.cause ?? "closed");
      }
      for (const h of this.handlers) { try { h(e); } catch {} }
    });
    this.closedFlag = false;
  }

  get closed() {
    return this.closedFlag;
  }

  async send(method, params, sessionId) {
    if (sessionId === undefined) {
      throw new AxError(Codes.COMMAND_REJECTED,
        `Command "${method}" needs a browser-level CDP domain the extension backend does not expose (chrome.debugger has no Target domain).`,
        { hint: "Use backend cdp for that command.", retry: "never" });
    }
    const tabKey = String(sessionId);
    if (this.removed.has(tabKey)) throw this.goneError(method, tabKey);
    if (this.detached.has(tabKey) && !DOMAINS.includes(method)) {
      // Debugger detached (navigation/devtools/another debugger): the
      // extension re-attaches on the next command, but a fresh attach has no
      // domains enabled — re-run them so events and lifecycle settling keep
      // flowing instead of silently stopping.
      this.detached.delete(tabKey);
      for (const m of DOMAINS) {
        try { await this.send(m, {}, sessionId); } catch {}
      }
    }
    let res;
    try {
      res = await this.bridge.rpc("cdp", { tabId: Number(sessionId), method, params: params ?? {} });
    } catch (e) {
      if (e instanceof AxError && e.code === Codes.TIMEOUT) {
        // Trunk-Chromium stall fallback (verified on r1721585 headless): a
        // Page.navigate RPC can hang while the SAME build answers
        // Runtime.evaluate fine. Route the navigation through the page once,
        // verify the URL actually changed, and answer with a navigate result.
        if (method === "Page.navigate" && typeof params?.url === "string") {
          return this.navigateViaEvaluate(params.url, sessionId);
        }
        // Side-effect accounting, same as the CDP backend: a timeout after
        // dispatch means the input may have landed.
        throw new AxError(Codes.TIMEOUT, e.message, { ...e, sideEffect: "uncertain" });
      }
      throw e;
    }
    if (!res.ok) {
      const s = String(res.error ?? "unknown error");
      if (/no tab with given id/i.test(s)) {
        if (!this.removed.has(tabKey)) this.removed.set(tabKey, "closed");
        throw this.goneError(method, tabKey, s);
      }
      if (/no attached target|tab.*(closed|not found)|detach/i.test(s)) {
        throw new AxError(Codes.ATTACH_FAILED, `CDP ${method} failed: ${s}`,
          { hint: "The tab was closed or the debugger detached (navigation can detach it; axuse re-attaches on the next command).", retry: "retry" });
      }
      throw new AxError(Codes.INTERNAL, `CDP ${method} failed: ${s}`);
    }
    return res.result ?? {};
  }

  /** The tab no longer exists in Chrome — say so, with the cause when known. */
  goneError(method, tabKey, raw) {
    const cause = this.removed.get(tabKey);
    const why = cause === "axuse_close" ? "it was closed by ax_close"
      : cause === "window_closed" ? "its window was closed"
      : cause === "closed_outside_axuse" ? "it was closed outside axuse (user, another agent or extension)"
      : "it no longer exists";
    return new AxError(Codes.NO_TAB, `CDP ${method} failed: Chrome tab ${tabKey} is gone — ${why}.${raw ? ` (${raw})` : ""}`,
      { hint: "Open a new tab with ax_open. In parallel runs, never close a tab in the same batch as other calls on it.", retry: "never" });
  }

  /** Navigate by assignment when the debugger RPC stalls: the page executes
   *  location.href = url; we confirm with a same-turn read-back and return
   *  the Page.navigate result shape the controller expects. */
  async navigateViaEvaluate(url, sessionId) {
    const expr = `(function(){ location.href = ${JSON.stringify(url)}; return location.href; })()`;
    const res = await this.bridge.rpc("cdp", {
      tabId: Number(sessionId),
      method: "Runtime.evaluate",
      params: { expression: expr, returnByValue: true },
    });
    if (res.ok && res.result?.result?.value !== undefined) {
      return { frameId: null, loaderId: undefined, via: "location.href (Page.navigate RPC stalled — trunk-Chromium fallback)" };
    }
    throw new AxError(Codes.TIMEOUT,
      `Page.navigate stalled and the location.href fallback did not confirm (browser may be mid-detach).`,
      { hint: "Retry: the debugger re-attach on the next command usually restores the direct path.", retry: "retry", sideEffect: "uncertain" });
  }

  onEvent(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close() {
    this.closedFlag = true;
    try { this.offRoute && this.offRoute(); } catch {}
  }
}

/** BrowserHandle-compatible surface backed by the user's real Chrome. */
export class ExtensionBrowser {
  constructor(bridge) {
    this.bridge = bridge;
    this.conn = new ExtConn(bridge);
    this.tabs = new Set();
    this.launched = false; // we never launched it — it's the user's browser
    this.proc = null;
    this.userDataDir = null;
    this.createdTargets = new Set();
  }

  async waitOnline(timeoutMs = 20_000) {
    await this.bridge.waitExt(timeoutMs);
  }

  async createTab(url = "about:blank") {
    const res = await this.bridge.rpc("open_tab", { url });
    if (!res.ok) {
      throw new AxError(Codes.ATTACH_FAILED, `open_tab failed: ${res.error}`,
        { hint: "Is Chrome running with the axuse bridge extension loaded? (axuse bridge install; load bridge/extension unpacked)", retry: "retry" });
    }
    const tabId = String(res.result.tabId);
    try {
      for (const m of DOMAINS) {
        await this.conn.send(m, {}, tabId);
      }
    } catch (e) {
      // Never leak a tab the caller will not get an id for.
      try { await this.bridge.rpc("close_tab", { tabId: Number(tabId) }); } catch {}
      throw e;
    }
    // NOTE: no Target.setAutoAttach — chrome.debugger has no Target domain,
    // so OOPIF frames stay listed-but-not-entered on this backend.
    this.createdTargets.add(tabId);
    return { targetId: tabId, sessionId: tabId };
  }

  /** Make the tab the active one in its window. Hidden tabs in the user's
   *  Chrome get no requestAnimationFrame and throttled timers (it is not
   *  launched with --disable-background-timer-throttling), so SPAs that
   *  wire handlers on rAF never initialise there. Extensions older than
   *  1.1 lack activate_tab: fall back to CDP Page.bringToFront. */
  async bringToFront(sessionId, { focusWindow = false } = {}) {
    const res = await this.bridge.rpc("activate_tab", { tabId: Number(sessionId), focusWindow });
    if (res.ok) return res.result ?? {};
    if (/unknown method/i.test(String(res.error))) {
      await this.conn.send("Page.bringToFront", {}, sessionId);
      return { via: "Page.bringToFront" };
    }
    throw new AxError(Codes.INTERNAL, `activate_tab failed: ${res.error}`);
  }

  async closeTabTarget(targetId) {
    const id = String(targetId);
    this.createdTargets.delete(id);
    try { await this.bridge.rpc("close_tab", { tabId: Number(id) }); } catch {}
  }

  async dispose() {
    // Codex semantics: disposing this backend closes the tabs WE created —
    // never the user's browser. Awaited (bounded) so a server shutting down
    // does not exit before the close requests reach the extension.
    const targets = [...this.createdTargets];
    this.createdTargets.clear();
    await Promise.all(targets.map((t) => this.bridge.rpc("close_tab", { tabId: Number(t) }, 4000).catch(() => {})));
    this.conn.close();
  }
}

/** Build (and wait for) the extension-backed browser handle. */
export async function createExtensionHandle() {
  const bridge = await getBridge();
  const b = new ExtensionBrowser(bridge);
  await b.waitOnline(20_000);
  return b;
}

const PROBE_BROWSERS = ["chrome", "chrome-beta", "chrome-canary", "edge", "edge-beta", "chromium"];
let probeNegativeUntil = 0;

/** Is the native-messaging host registered for any Chromium-family browser?
 *  Without it no extension can ever dial a hub, so the probe stays free of
 *  side effects (no hub started, no info file written) on such machines. */
async function bridgeRegistered() {
  const { nativeMessagingDir, HOST_NAME } = await import("./install.js");
  const { bridgeDir } = await import("./hub.js");
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  if (process.platform === "win32") return existsSync(join(bridgeDir(), `${HOST_NAME}.json`));
  return PROBE_BROWSERS.some((b) => {
    try { return existsSync(join(nativeMessagingDir(b), `${HOST_NAME}.json`)); } catch { return false; }
  });
}

/**
 * Auto-backend probe: true when the bridge hub reports a connected axuse
 * extension (the user's own, signed-in Chrome). A hub alive in another
 * process answers at once; when this process has to start the hub, the
 * extension's service worker redials within ~1 s, so wait briefly once.
 * Negative answers are cached for 30 s so cdp-only machines pay nothing.
 */
export async function extensionOnline({ waitMs = 2500 } = {}) {
  if (Date.now() < probeNegativeUntil) return false;
  const { readInfo } = await import("./hub.js");
  const info = readInfo();
  let hubAlive = false;
  if (info?.port && info?.pid) {
    try { process.kill(info.pid, 0); hubAlive = true; } catch {}
  }
  if (!hubAlive && !(await bridgeRegistered())) {
    probeNegativeUntil = Date.now() + 30_000;
    return false;
  }
  try {
    const bridge = await getBridge();
    if (bridge.extOnline()) return true;
    await bridge.waitExt(hubAlive ? 500 : waitMs);
    return true;
  } catch {
    probeNegativeUntil = Date.now() + 30_000;
    return false;
  }
}

/** Test hook: forget the cached negative probe. */
export function __resetProbeForTests() {
  probeNegativeUntil = 0;
}
