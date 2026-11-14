/**
 * axuse bridge — extension service worker.
 *
 * Lineage: the Codex ChatGPT extension's background bridge — the extension
 * holds chrome.debugger (real CDP over the user's real browser and sessions)
 * and relays commands from the harness over native messaging. That is the
 * pattern that makes harness browser use "run in the user's session": no
 * second browser, no credential copies, and the debugger infobar keeps the
 * human honestly informed.
 *
 * Protocol (one JSON object per native-messaging message):
 *   from hub:  {t:"req", id, method, params} | {t:"ping"}
 *   to hub:    {t:"hello", ext, ua} | {t:"res", id, ok, result?|error?}
 *              | {t:"evt", tabId, method, params} | {t:"pong"}
 *   methods:   open_tab {url} | cdp {tabId, method, params}
 *              close_tab {tabId} | list_tabs {} | activate_tab {tabId, focusWindow?}
 *   events:    CDP events, plus debugger.detached {reason} and
 *              tab.removed {cause: "axuse_close"|"window_closed"|"closed_outside_axuse"}
 */

const HOST_NAME = "com.axuse.bridge";
let port = null;
let reconnectTimer = null;

// Field diagnostics: readable from an attached DevTools session
// (`self.__axuseDiag` in the service worker). Answers "did connect() run,
// did the port disconnect, and why" without guessing.
self.__axuseDiag = { connects: 0, disconnects: 0, lastError: null, startedAt: null, reqs: {}, replies: {}, msgs: [], removals: [], detaches: [] };

// Domains the backend relies on (event ring, lifecycle settling). A fresh
// attach — first open or a re-attach after a detach — must re-enable them,
// or lifecycle-based settling silently stops.
const DOMAINS = ["Page.enable", "Runtime.enable", "Log.enable"];
// Tabs being closed by close_tab: their onRemoved is "axuse_close", not a
// surprise removal.
const closingByUs = new Set();

function diagPush(list, entry) {
  list.push({ ...entry, at: new Date().toISOString() });
  if (list.length > 200) list.splice(0, list.length - 200);
}

function send(msg) {
  if (!port) return;
  try {
    port.postMessage(msg);
  } catch (e) {
    port = null;
  }
}

function connect() {
  // Idempotent: at SW start, top-level code AND wake listeners (onInstalled
  // etc.) may all fire — a second connect() must never open a second native
  // host. Two hosts cascade: the hub keeps only the latest, killing the old
  // host's socket, whose onDisconnect would otherwise clobber the live port.
  if (port) return;
  clearTimeout(reconnectTimer);
  self.__axuseDiag.connects++;
  self.__axuseDiag.startedAt = new Date().toISOString();
  let p;
  try {
    p = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    self.__axuseDiag.lastError = "connectNative threw: " + String(e && e.message ? e.message : e);
    reconnectTimer = setTimeout(connect, 1000);
    return;
  }
  port = p;
  p.onMessage.addListener(onMessage);
  p.onDisconnect.addListener(() => {
    // Guard: only the CURRENT port's disconnect is actionable. A stale
    // port's disconnect (replaced by a newer connect) must be ignored.
    if (port !== p) return;
    self.__axuseDiag.disconnects++;
    self.__axuseDiag.lastError = chrome.runtime.lastError
      ? "onDisconnect lastError: " + chrome.runtime.lastError.message
      : "onDisconnect (host exited or SW was killed)";
    port = null;
    reconnectTimer = setTimeout(connect, 1000);
  });
  send({ t: "hello", ext: chrome.runtime.getManifest().version, ua: navigator.userAgent });
}

function onMessage(msg) {
  // Receiving a message resets the MV3 idle timer (the hub pings every 20s).
  try {
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "req") {
      self.__axuseDiag.reqs[msg.method] = (self.__axuseDiag.reqs[msg.method] || 0) + 1;
      self.__axuseDiag.msgs.push("req " + msg.method + " id=" + msg.id);
      void handleReq(msg);
    } else if (msg.t === "ping") {
      self.__axuseDiag.msgs.push("ping");
      send({ t: "pong" });
    }
  } catch (e) {
    if (msg && msg.id !== undefined) send({ t: "res", id: msg.id, ok: false, error: String(e) });
  }
}

function reply(id, ok, result, error) {
  self.__axuseDiag.replies[ok ? "ok" : "err"] = (self.__axuseDiag.replies[ok ? "ok" : "err"] || 0) + 1;
  self.__axuseDiag.msgs.push("reply id=" + id + " ok=" + ok);
  send(ok
    ? { t: "res", id, ok: true, result }
    : { t: "res", id, ok: false, error: String(error ?? "unknown error") });
}

async function handleReq(msg) {
  const p = msg.params || {};
  switch (msg.method) {
    case "ping":
      return reply(msg.id, true, { ok: true });
    case "open_tab": {
      let tab = null;
      try {
        tab = await chrome.tabs.create({ url: p.url || "about:blank", active: true });
        await ensureAttached(tab.id);
        return reply(msg.id, true, { tabId: tab.id });
      } catch (e) {
        // Never leak a tab the caller has no id for.
        if (tab && tab.id != null) {
          closingByUs.add(tab.id);
          try { await chrome.tabs.remove(tab.id); } catch {}
        }
        return reply(msg.id, false, null, e);
      }
    }
    case "activate_tab": {
      // Background tabs get no requestAnimationFrame and heavily throttled
      // timers; SPAs that wire handlers on rAF never finish initialising
      // there. Bringing the tab forward in its window makes it visible.
      try {
        const tab = await chrome.tabs.update(p.tabId, { active: true });
        if (p.focusWindow && tab && tab.windowId != null) {
          try { await chrome.windows.update(tab.windowId, { focused: true }); } catch {}
        }
        return reply(msg.id, true, { active: true, windowId: tab ? tab.windowId : null });
      } catch (e) {
        return reply(msg.id, false, null, e);
      }
    }
    case "cdp": {
      try {
        const result = await chrome.debugger.sendCommand({ tabId: p.tabId }, p.method, p.params || {});
        return reply(msg.id, true, result === undefined ? {} : result);
      } catch (e) {
        // Tab reload/navigation can detach the debugger: one re-attach retry.
        const s = String(e && e.message ? e.message : e);
        if (/attach/i.test(s)) {
          try {
            const fresh = await ensureAttached(p.tabId);
            if (fresh) await enableDomains(p.tabId, p.method);
            const result = await chrome.debugger.sendCommand({ tabId: p.tabId }, p.method, p.params || {});
            return reply(msg.id, true, result === undefined ? {} : result);
          } catch (e2) {
            return reply(msg.id, false, null, e2);
          }
        }
        return reply(msg.id, false, null, e);
      }
    }
    case "close_tab": {
      closingByUs.add(p.tabId);
      try { await chrome.debugger.detach({ tabId: p.tabId }); } catch {}
      try { await chrome.tabs.remove(p.tabId); } catch {}
      return reply(msg.id, true, { closed: true });
    }
    case "list_tabs": {
      try {
        const tabs = await chrome.tabs.query({});
        return reply(msg.id, true, {
          tabs: tabs.map((t) => ({ tabId: t.id, url: t.url, title: t.title, active: t.active })),
        });
      } catch (e) {
        return reply(msg.id, false, null, e);
      }
    }
    default:
      return reply(msg.id, false, null, `unknown method ${msg.method}`);
  }
}

/** Attach the debugger. Resolves true for a fresh attach, false when it
 *  was already attached. */
async function ensureAttached(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    return true;
  } catch (e) {
    if (!/already attached/i.test(String(e && e.message ? e.message : e))) throw e;
    return false;
  }
}

/** Re-run the domain enables after a re-attach (skip the one the caller is
 *  about to send itself). */
async function enableDomains(tabId, except) {
  for (const m of DOMAINS) {
    if (m === except) continue;
    try { await chrome.debugger.sendCommand({ tabId }, m, {}); } catch {}
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source && source.tabId != null) send({ t: "evt", tabId: source.tabId, method, params: params ?? {} });
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source && source.tabId != null) {
    diagPush(self.__axuseDiag.detaches, { tabId: source.tabId, reason: reason ?? null });
    send({ t: "evt", tabId: source.tabId, method: "debugger.detached", params: { reason: reason ?? null } });
  }
});
// Tab removals with their cause: the backend deregisters the tab and later
// calls on it fail with a clear "closed (cause)" error instead of Chrome's
// bare "No tab with given id".
chrome.tabs.onRemoved.addListener((tabId, info) => {
  const cause = closingByUs.delete(tabId)
    ? "axuse_close"
    : (info && info.isWindowClosing ? "window_closed" : "closed_outside_axuse");
  diagPush(self.__axuseDiag.removals, { tabId, cause });
  send({ t: "evt", tabId, method: "tab.removed", params: { cause } });
});

// Wake triggers: any of these starting the SW runs the top-level connect().
// Without them an MV3 SW can stay dormant at browser start and never dial
// the hub.
chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());
chrome.tabs.onCreated.addListener(() => connect());

connect();
