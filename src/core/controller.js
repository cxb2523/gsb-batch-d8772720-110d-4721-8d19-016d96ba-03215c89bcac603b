/**
 * axuse — controller: the state owner and command executor.
 *
 * Lineage: Codex's native-messaging host owns browser/tab state (tab leases,
 * state ids, event routing, watchdogs) behind a thin transport adapter; ZCode
 * keeps browser/AX state in the host while the model-facing tool calls are
 * stateless one-shots. Same shape here: MCP tool calls are thin and
 * stateless; every durable fact (tabs, refs' state_id, dialogs, event
 * cursors, snapshots for diffing) lives in this process.
 */

import { BrowserHandle, parseProxySpec } from "./cdp.js";
import { Contract, validate } from "./commands.js";
import { AxError, Codes } from "./errors.js";
import { serializeExpression } from "./serialize.js";
import { diffSnapshots, noChangeText } from "./diff.js";
import { captureScreenshot, DEFAULT_BUDGET_BYTES } from "./screenshot.js";
import { virtualDisplayStatus } from "./vdisplay.js";
import {
  click as doClick, hover as doHover, drag as doDrag, wheel as doWheel,
  insertText, humanType, pressCombo, platformShortcut, planPointerJitter, selectAllCombo,
  refResolveExpression, selectOptionExpression, elementInfoExpression, fieldKindExpression, findOptionExpression,
  sliderValueExpression, settleExpression, mutationWaitExpression, waitForExpression, MOD,
} from "./actuate.js";

const URL_SCHEMES = /^(https?|file|about|data|blob):/i;
const EVENT_RING_MAX = 1000; // Codex tab_cdp_events: limit ≤ 1000
const MAX_EVAL_CHARS = 64_000; // Codex DOM text cap: 64k default
const EVENT_TEXT_CAP = 2000;
const MAX_OPEN_MANY_URLS = 100;
const MOD_MASK = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
const CLOSE_CAUSES = {
  idle_reaped: "axuse closed it after it sat unused for AXUSE_TAB_IDLE_MS (default 30 min)",
  window_closed: "its browser window was closed",
  closed_outside_axuse: "it was closed outside axuse (the user, another agent or another extension)",
  closed: "it no longer exists in the browser",
};

/** Idle-tab reaper window: tabs no call has touched for this long are
 *  closed (agents that ended without ax_close). AXUSE_TAB_IDLE_MS=0 off. */
function tabIdleMs() {
  const v = Number(process.env.AXUSE_TAB_IDLE_MS ?? 30 * 60_000);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** AXUSE_REQUIRE_TAB_ID=0 restores the implicit active-tab default when
 *  several tabs are controlled. */
function requireTabId() {
  return !/^(0|false|off|no)$/i.test(String(process.env.AXUSE_REQUIRE_TAB_ID ?? "").trim());
}

/** Event methods worth a round trip — the signal, not the noise. */
const RECORDED_EVENTS = new Set([
  "Page.fileChooserOpened",
  "Page.javascriptDialogOpening",
  "Page.javascriptDialogClosed",
  "Page.frameNavigated",
  "Page.navigatedWithinDocument",
  "Page.loadEventFired",
  "Page.windowOpen",
  "Page.crashed",
  "Page.downloadWillBegin", // plugin prerequisite R1: downloads-pdf
  "Page.downloadProgress",
  "Runtime.consoleAPICalled", // error/warning only, filtered below
  "Log.entryAdded", // error level only, filtered below
]);

/** Request types whose completion usually re-renders the page. Images, CSS,
 *  fonts, media, sockets and beacons are not worth waiting for. */
const NET_TRACKED = new Set(["XHR", "Fetch", "Document"]);
/** A request in flight longer than this is a long-poll/stream, not a pending render. */
const NET_LONGPOLL_MS = 3000;
/** Upper bound on the post-action wait for page-triggered requests. */
const netSettleCapMs = () => Math.max(0, Number(process.env.AXUSE_NET_SETTLE_MS ?? 2000));
const netSettleEnabled = () => !/^(0|false|off|no)$/i.test(String(process.env.AXUSE_NET_SETTLE ?? "").trim()) && netSettleCapMs() > 0;
/** How long an action that showed NO change keeps watching for a late one. */
const lateChangeMs = () => Math.max(0, Number(process.env.AXUSE_LATE_CHANGE_MS ?? 450));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Controller {
  constructor() {
    this.browsers = new Map(); // browser_id → {handle, tabs:Set, key}
    this.browserIndex = new Map(); // reuse key ("launch:headless" / "attach:url") → browser_id
    this.tabs = new Map(); // tab_id → tab record
    this.tabSeq = 0;
    this.browserSeq = 0;
    this.activeTabId = null;
    // tab_id → why it disappeared (tab removed in the browser, not by
    // ax_close): later calls on it fail with the cause, not a bare NO_TAB.
    this.closedTabs = new Map();
    // Ambient park-fuzz state (null timer = parked; undefined would break
    // the startAmbient guard — initialize explicitly).
    this.ambientTimer = null;
    this.busy = 0;
    this.pointerAnchor = null;
    this.disposing = false;
  }

  /* ------------------------------------------------------------------ util */

  tabOrActive(tabId) {
    if (tabId == null && this.tabs.size > 1 && requireTabId()) {
      // Every agent on this server shares one tab table: the "active tab" is
      // whichever tab ANY caller opened last, so an implicit target is a
      // cross-agent misfire waiting to happen.
      const ids = [...this.tabs.keys()];
      const shown = ids.length > 12 ? `${ids.slice(-12).join(", ")} and ${ids.length - 12} more` : ids.join(", ");
      throw new AxError(Codes.COMMAND_REJECTED,
        `tab_id is required: ${ids.length} tabs are controlled (${shown}; active ${this.activeTabId}).`,
        { hint: "Pass the tab_id your ax_open returned. Tabs are shared by every caller of this axuse server, so the active tab may belong to someone else (AXUSE_REQUIRE_TAB_ID=0 restores the implicit default).", retry: "never" });
    }
    const id = tabId ?? this.activeTabId;
    if (id && this.tabs.has(id)) this.tabs.get(id).lastUsedAt = Date.now();
    if (!id || !this.tabs.has(id)) {
      const cause = id ? this.closedTabs.get(id) : null;
      if (cause) {
        throw new AxError(Codes.NO_TAB, `Tab ${id} is gone: ${CLOSE_CAUSES[cause] ?? cause}.`,
          { hint: "Open a new tab with ax_open.", retry: "never" });
      }
      throw new AxError(Codes.NO_TAB, tabId ? `No controlled tab "${tabId}" (closed or never opened). Open one with ax_open.` : "No controlled tab. Open one with ax_open first.", { retry: "never" });
    }
    return this.tabs.get(id);
  }

  /**
   * Visible-tab guard. A tab hidden in the user's own Chrome (extension or
   * cdp_url attach; launched browsers run with background throttling off)
   * gets no requestAnimationFrame and ~1 s timers, so SPAs whose handlers
   * are wired on rAF/idle callbacks (Google search) never finish
   * initialising and swallow Enter and clicks. Bring the tab forward; if
   * its window is occluded or minimised, force one frame with a 1x1
   * capture (the verified workaround), then let one frame run.
   */
  async ensureVisible(tab) {
    const handle = tab.browser.handle;
    if (typeof handle.bringToFront !== "function" || handle.launched || tab.dialog || tab.closed) return null;
    if (/^(0|false|off|no)$/i.test(String(process.env.AXUSE_VISIBLE_GUARD ?? "").trim())) return null;
    const visibility = () => this.evalInTab(tab, "document.visibilityState").catch(() => null);
    if ((await visibility()) !== "hidden") return null;
    try { await handle.bringToFront(tab.sessionId); } catch {}
    let state = null;
    for (let i = 0; i < 10; i++) {
      state = await visibility();
      if (state !== "hidden") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    if (state === "hidden") {
      try {
        await handle.conn.send("Page.captureScreenshot",
          { format: "jpeg", quality: 1, clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 } }, tab.sessionId);
      } catch {}
    }
    // One frame so rAF-gated initialisation runs before input lands
    // (host-bounded: a still-hidden page's own timers may be throttled).
    await Promise.race([
      this.evalInTab(tab, "new Promise((r) => requestAnimationFrame(() => r(true)))", { awaitPromise: true }).catch(() => null),
      new Promise((r) => setTimeout(r, 400)),
    ]);
    this.recordEvent(tab, "tab.activated", { was: "hidden", visible: state !== "hidden" });
    return { activated: true, visible: state !== "hidden" };
  }

  /**
   * Backend for ax_open/ax_open_many when the caller names none.
   * AXUSE_BACKEND=cdp|extension pins it; the default "auto" picks the
   * user's own signed-in Chrome whenever the bridge hub reports a connected
   * axuse extension, else a CDP-launched browser. Launch-only options
   * (headless, profile_dir, proxy, executable_path) and cdp_url mean cdp.
   */
  async resolveBackend(a, headless) {
    if (a.backend) return { backend: a.backend, reason: "requested" };
    if (a.cdp_url) return { backend: "cdp", reason: "cdp_url" };
    const pref = String(process.env.AXUSE_BACKEND ?? "auto").trim().toLowerCase();
    if (pref === "cdp" || pref === "extension") return { backend: pref, reason: "AXUSE_BACKEND" };
    if (headless || a.executable_path || a.profile_dir || a.proxy) return { backend: "cdp", reason: "launch option" };
    const extId = this.browserIndex.get("extension");
    const ext = extId ? this.browsers.get(extId) : null;
    if (ext && !ext.handle.conn.closed && ext.handle.bridge?.extOnline?.() !== false) {
      return { backend: "extension", reason: "axuse extension connected" };
    }
    const { extensionOnline } = await import("../bridge/backend.js");
    if (await extensionOnline()) return { backend: "extension", reason: "axuse extension connected" };
    return { backend: "cdp", reason: "no axuse extension connected" };
  }

  /** Guard: acting on refs from an older observation than the current page state. */
  checkStale(tab, args) {
    if (args.state_id !== undefined && args.state_id !== tab.stateId) {
      throw new AxError(Codes.STALE_STATE,
        `state_id ${args.state_id} predates current state ${tab.stateId} (url: ${tab.url}).`,
        { hint: "Call ax_observe, then act on fresh refs.", retry: "reobserve" });
    }
  }

  /** Guard: JS dialogs block everything until answered. */
  checkDialog(tab) {
    if (tab.dialog) {
      throw new AxError(Codes.DIALOG_OPEN,
        `A ${tab.dialog.type} dialog is open: "${tab.dialog.message}".`,
        { hint: "Answer it with ax_dialog (answer: accept|dismiss).", retry: "retry" });
    }
  }

  /** Parse an `f<slot>:eN` ref → the owning session, or the tab's own. */
  sessionForRef(tab, ref) {
    const m = /^f(\d+):(.+)$/.exec(String(ref));
    if (!m) return { session: tab.sessionId, ref: String(ref), frame: null };
    for (const [, f] of tab.frames) {
      if (f.slot === Number(m[1])) return { session: f.sessionId, ref: m[2], frame: `f${f.slot}` };
    }
    throw new AxError(Codes.REF_NOT_FOUND,
      `frame slot f${m[1]} is gone (frame navigated away or detached).`,
      { hint: "Call ax_observe — the frame tree is re-merged each observation.", retry: "reobserve" });
  }

  /** Run the injected serializer and build a snapshot record.
   *  OOPIF frames are serialized in their own sessions and merged with
   *  `f<slot>:` ref namespacing (identity-stable slots + per-document
   *  registries, so unchanged frame refs stay valid across observations). */
  async serialize(tab, { maxNodes = 300, maxChars = 24000 } = {}) {
    const expression = serializeExpression({ maxNodes, maxChars });
    const res = await this.evalInTab(tab, expression, { awaitPromise: false });
    if (!res || res.ok === false) {
      throw new AxError(Codes.EVALUATE_FAILED, `Serializer failed: ${res && res.error}`);
    }
    const entries = [...res.entries];
    const textLines = [...res.textLines];
    let text = res.text;
    let truncated = res.truncated;
    const clipped = res.clipped ?? 0;
    const frameNotes = [];
    // Frames in slot order; each frame's own serializer runs in its session.
    const frames = [...tab.frames.values()].sort((a, b) => a.slot - b.slot);
    for (const f of frames) {
      if (text.length >= maxChars) { truncated = true; break; }
      let fres;
      try {
        fres = await this.evalInTab(tab, serializeExpression({ maxNodes: Math.min(maxNodes, 100), maxChars: Math.max(2000, Math.floor(maxChars / 4)) }), { awaitPromise: false }, f.sessionId);
      } catch {
        frameNotes.push(`--- frame f${f.slot} (${f.url}) not ready ---`);
        continue;
      }
      if (!fres || fres.ok === false || !Array.isArray(fres.entries)) {
        frameNotes.push(`--- frame f${f.slot} (${f.url}) not ready ---`);
        continue;
      }
      const prefix = `f${f.slot}:`;
      const section = [`--- frame f${f.slot} (${fres.url ?? f.url}) ---`];
      for (const e of fres.entries) {
        const line = e.line.replace(/\[ref=(e\d+)\]/, (m, r) => `[ref=${prefix}${r}]`);
        entries.push({ ref: `${prefix}${e.ref}`, line });
        section.push("  " + line);
      }
      for (const tl of fres.textLines) {
        textLines.push(tl);
        section.push("  " + tl);
      }
      if (fres.truncated) truncated = true;
      text += "\n" + section.join("\n");
    }
    for (const n of frameNotes) text += "\n" + n;
    if (text.length > maxChars) {
      text = text.slice(0, maxChars) + "\n…[truncated — pass max_chars or observe in pieces]";
      truncated = true;
    }
    tab.stateId += 1;
    return {
      stateId: tab.stateId,
      entries,
      textLines,
      url: res.url,
      title: res.title,
      truncated,
      clipped,
      refCount: entries.length,
      frameCount: frames.length,
      items: res.items ?? null, // per main-frame line: id of its enclosing item (find mode)
      text,
    };
  }

  /** Runtime.evaluate with typed error mapping and size clipping. `session`
   *  routes the evaluation into a frame session (OOPIF refs). */
  async evalInTab(tab, expression, { awaitPromise = false } = {}, session) {
    const sessionId = session ?? tab.sessionId;
    let res;
    try {
      res = await tab.browser.handle.conn.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise,
      }, sessionId);
    } catch (e) {
      if (e instanceof AxError && e.code === Codes.TIMEOUT) {
        throw new AxError(Codes.NAVIGATION_IN_PROGRESS,
          "The tab is navigating (execution context replaced mid-call), or the page stalled past the RPC window.",
          { hint: "Call ax_observe once navigation settles. Background tabs in the user's Chrome throttle page timers; input and wait commands bring the tab forward first.", retry: "reobserve", sideEffect: "uncertain" });
      }
      throw e;
    }
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      const msg = (d.exception && (d.exception.description || d.exception.value)) || d.text || "unknown error";
      throw new AxError(Codes.EVALUATE_FAILED, String(msg).slice(0, 400), { retry: "never" });
    }
    return res.result?.value;
  }

  /** Bounded settle wait, in-page (ZCode rule: wait for UI settle, no host polling). */
  async settle(tab, budgetMs = 4000, debounceMs = 150) {
    await this.evalInTab(tab, settleExpression(budgetMs, debounceMs), { awaitPromise: true }).catch(() => null);
  }

  /**
   * Produce an observation: full snapshot text or diff vs the last one.
   * This is the Codex/ZCode observation engine — the model normally reads
   * diffs, full trees only on navigation or explicit request.
   */
  async observation(tab, { mode = "diff", maxNodes, maxChars, settleMs } = {}) {
    if (settleMs !== undefined) await this.settle(tab, 4000, settleMs);
    const snap = await this.serialize(tab, { maxNodes, maxChars });
    if (snap.url) tab.url = snap.url;
    if (snap.title !== undefined) tab.title = snap.title;
    const budget = snap.text.length >= (maxChars ?? 24000) ? `${maxChars ?? 24000}-char` : `${maxNodes ?? 300}-element`;
    const header = `url: ${snap.url}\ntitle: ${snap.title}\nentries: ${snap.entries.length} refs, state ${snap.stateId}${snap.truncated ? `\nnote: truncated by the ${budget} budget — ax_observe {mode:"text"} returns the full readable text; find:"..." locates refs anywhere; or raise max_chars (≤200000) / max_nodes (≤2000)` : ""}${!snap.truncated && snap.clipped ? `\nnote: ${snap.clipped} long text${snap.clipped === 1 ? "" : "s"} shortened with "…" — ax_observe {mode:"text"} returns the full readable text` : ""}`;
    const fullText = `${header}\n${snap.text}`;
    if (mode === "full" || !tab.lastSnapshot) {
      tab.lastSnapshot = snap;
      return { state_id: snap.stateId, mode: "full", url: snap.url, title: snap.title, truncated: snap.truncated, ref_count: snap.refCount, text: fullText };
    }
    const prev = tab.lastSnapshot;
    const d = diffSnapshots(prev, snap);
    tab.lastSnapshot = snap;
    if (d.mode === "full") {
      return { state_id: snap.stateId, mode: "full", url: snap.url, title: snap.title, truncated: snap.truncated, ref_count: snap.refCount, text: fullText, diff_suppressed: true };
    }
    const churn = d.removed.length + d.added.length + d.changed.length
      + (d.textAdded?.length ?? 0) + (d.textRemoved?.length ?? 0);
    if (churn === 0) {
      return { state_id: snap.stateId, mode: "diff", url: snap.url, title: snap.title, truncated: snap.truncated, ref_count: snap.refCount, text: noChangeText(prev, snap) };
    }
    return { state_id: snap.stateId, mode: "diff", url: snap.url, title: snap.title, truncated: snap.truncated, ref_count: snap.refCount, text: d.text };
  }

  /** Post-action auto-observation. Never masks a successful action. */
  async autoObserve(tab, settleMs, { expectChange = false } = {}) {
    try {
      if (tab.dialog) return this.dialogNote(tab);
      if (settleMs !== undefined && settleMs > 0) {
        await this.raceDialog(tab, this.settle(tab, 4000, settleMs));
        await this.raceDialog(tab, this.awaitNetworkIdle(tab));
      }
      if (tab.dialog) return this.dialogNote(tab);
      let obs = await this.raceDialog(tab, this.observation(tab, { mode: "diff" }));
      if (tab.dialog) return this.dialogNote(tab);
      // "No change" after a click is usually "not yet": a delayed render or a
      // debounced request. Look once more before telling the agent nothing happened.
      if (expectChange && typeof obs?.text === "string" && obs.text.startsWith("no changes detected") && lateChangeMs() > 0) {
        if (await this.raceDialog(tab, this.awaitLateChange(tab, lateChangeMs()))) {
          obs = await this.raceDialog(tab, this.observation(tab, { mode: "diff" }));
          if (tab.dialog) return this.dialogNote(tab);
        }
      }
      return obs;
    } catch (e) {
      return { skipped: e.code ?? "ERROR", hint: "Call ax_observe." };
    }
  }

  /** Resolve target {ref} | {x,y} to live coordinates. `f<slot>:eN` refs
   *  resolve inside the frame's session (frame-local coordinates, matching
   *  frame-local CDP input dispatch). */
  async resolveTarget(tab, target) {
    if (target.x !== undefined) {
      if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) {
        throw new AxError(Codes.BAD_COORDS, "x/y must be finite numbers", { retry: "never" });
      }
      return { x: target.x, y: target.y, from: "coords" };
    }
    const { session, ref, frame } = this.sessionForRef(tab, target.ref);
    const res = await this.evalInTab(tab, refResolveExpression(ref), { awaitPromise: true }, session);
    if (!res) throw new AxError(Codes.REF_NOT_FOUND, `ref "${target.ref}" does not exist in the page.`,
      { hint: "Refs are per-observation. Call ax_observe (mode full if needed), then act on fresh refs.", retry: "reobserve" });
    if (res.error === "no_ref" || res.error === "detached") {
      throw new AxError(Codes.REF_NOT_FOUND, `ref "${target.ref}" is gone (navigation or re-render).`,
        { hint: "Call ax_observe, then act on fresh refs.", retry: "reobserve" });
    }
    if (res.error === "hidden") {
      throw new AxError(Codes.ELEMENT_HIDDEN, `ref "${target.ref}" has no visible box.`,
        { hint: "Scroll it into view or re-observe.", retry: "reobserve" });
    }
    // The ambient park-fuzz anchors to the last real action position.
    this.pointerAnchor = { x: res.x, y: res.y };
    return { x: res.x, y: res.y, covered: res.covered, hitTag: res.hitTag, from: "ref", session, frame };
  }

  modifierMask(modifiers) {
    return (modifiers ?? []).reduce((m, x) => m | (MOD_MASK[x] ?? 0), 0);
  }

  /* ------------------------------------------------------------- commands */

  /** Commands that own the pointer (and its precision window): ambient
   *  park-fuzz pauses ONLY for these. Waits and observations release the
   *  pointer — an agent that sits in ax_wait_for for 20 s must still look
   *  like a hand is on the mouse. */
  static POINTER_COMMANDS = new Set(["click", "type", "press", "fill", "scroll", "drag", "hover", "dialog", "upload"]);

  /** Commands that need a visible tab (navigation and input): the
   *  visible-tab guard runs before them. ax_open runs it itself. */
  static VISIBLE_COMMANDS = new Set(["navigate", "go", "click", "type", "press", "fill", "scroll", "drag", "hover", "select", "upload", "wait_for"]);

  /** Single entry point — the frozen contract executes here and only here.
   *  busy counts in-flight POINTER commands: the idle park-fuzz runs
   *  between them (and during waits/observations), never over one. */
  async execute(name, rawArgs = {}) {
    const args = validate(name, rawArgs);
    const entry = Contract[name];
    if (entry.group !== "browser") throw new AxError(Codes.INTERNAL, `unroutable group ${entry.group}`);
    const fn = this[`$${name}`];
    if (!fn) throw new AxError(Codes.INTERNAL, `command "${name}" has no executor`);
    const holdsPointer = Controller.POINTER_COMMANDS.has(name);
    if (holdsPointer) this.busy = (this.busy ?? 0) + 1;
    if (this.ambientEnabled()) this.startAmbient();
    const started = Date.now();
    try {
      let activated = null;
      if (Controller.VISIBLE_COMMANDS.has(name)) {
        const id = args.tab_id ?? (this.tabs.size === 1 || !requireTabId() ? this.activeTabId : null);
        const tab = id ? this.tabs.get(id) : null;
        if (tab) activated = await this.ensureVisible(tab).catch(() => null);
      }
      let result;
      try {
        result = await fn.call(this, args);
      } catch (e) {
        // A stale ref/state means the page moved on (re-render, step change).
        // Hand back the CURRENT page in the same response so the agent does
        // not spend a turn on ax_observe just to find out where it is.
        if (e instanceof AxError && (e.code === Codes.REF_NOT_FOUND || e.code === Codes.STALE_STATE) && e.retry === "reobserve" && !e.facts?.fresh_observation) {
          const id = args.tab_id ?? this.activeTabId;
          const tab = id ? this.tabs.get(id) : null;
          if (tab && !tab.closed && !tab.dialog) {
            try {
              const obs = await this.observation(tab, { mode: "full" });
              e.facts = { ...(e.facts ?? {}), fresh_observation: obs.text, state_id: obs.state_id };
              e.hint = "The page changed since your last observation. Its current state is included below: act on these refs; no ax_observe needed.";
            } catch { /* keep the original error */ }
          }
        }
        throw e;
      }
      const meta = { elapsed_ms: Date.now() - started, ...(activated ? { tab_activated: true } : {}) };
      if (result && typeof result === "object") {
        if (entry.observed === "full") meta.observed = "full";
        return { ...result, meta };
      }
      return { result, meta };
    } finally {
      if (holdsPointer) this.busy = Math.max(0, this.busy - 1);
      // Re-check AFTER the command too: the FIRST open boots the virtual
      // display (ambient becomes enabled mid-command) — the idle chain must
      // start then, not at the next tool call.
      if (this.ambientEnabled()) this.startAmbient();
    }
  }

  /* ------------------------------------------------------- ambient motion */

  /** Idle pointer park-fuzz: trusted micro-jitter around the last action's
   *  position while the agent THINKS (between tool calls). AXUSE_AMBIENT_
   *  MOTION=0 opts out; default "auto" = on exactly in server mode (the
   *  lane where protected-page dynamics matter; desktop benchmarks keep
   *  their measured behavior unchanged). */
  ambientEnabled() {
    const v = String(process.env.AXUSE_AMBIENT_MOTION ?? "").trim().toLowerCase();
    if (v === "0" || v === "off" || v === "false" || v === "no") return false;
    if (v === "1" || v === "on" || v === "true" || v === "yes") return true;
    return virtualDisplayStatus().active;
  }

  startAmbient() {
    if (this.ambientTimer !== null) return;
    const tick = () => {
      this.ambientTimer = null;
      const delay = this.ambientTick();
      if (delay !== null) this.ambientTimer = setTimeout(tick, delay);
    };
    this.ambientTimer = setTimeout(tick, 900);
  }

  /** One ambient step. Returns the next delay, or null to stop (dispose).
   *  Never moves while a pointer command is in flight, a dialog is open, or
   *  no tab is alive — precision and dialog semantics always win over
   *  entropy. */
  ambientTick() {
    if (this.disposing || this.busy > 0 || !this.ambientEnabled()) return 800; // re-check later, stay parked
    const tab = this.activeTabId ? this.tabs.get(this.activeTabId) : null;
    const browser = tab ? this.browsers.get(tab.browserId) : null;
    if (!tab || tab.dialog || !browser?.handle?.conn || browser.handle.conn.closed) return 1500;
    if (!this.pointerAnchor) {
      const vd = virtualDisplayStatus();
      this.pointerAnchor = { x: Math.round((vd.active ? vd.width : 1280) * (0.3 + Math.random() * 0.4)),
        y: Math.round((vd.active ? vd.height : 800) * (0.3 + Math.random() * 0.4)) };
    }
    const j = planPointerJitter(this.pointerAnchor, {});
    try {
      browser.handle.conn.send("Input.dispatchMouseEvent",
        { type: "mouseMoved", x: j.x, y: j.y, button: "none", modifiers: 0 }, tab.sessionId).catch(() => {});
    } catch { /* connection gone — the next tick re-checks */ }
    return j.nextInMs;
  }

  stopAmbient() {
    if (this.ambientTimer !== null) { clearTimeout(this.ambientTimer); this.ambientTimer = null; }
  }

  async $open(a) {
    const url = String(a.url);
    if (!URL_SCHEMES.test(url)) {
      throw new AxError(Codes.COMMAND_REJECTED, `url must start with http(s)://, file://, about:, data: or blob:`, { retry: "never" });
    }
    const headless = a.headless ?? /^(1|true)$/i.test(process.env.AXUSE_HEADLESS ?? "");
    const { backend, reason } = await this.resolveBackend(a, headless);
    const browser = await this.ensureBrowser({ headless, cdpUrl: a.cdp_url, executablePath: a.executable_path, backend, profileDir: a.profile_dir, proxy: a.proxy, proxyBypass: a.proxy_bypass, timezone: a.timezone, lang: a.lang });
    const { targetId, sessionId } = await browser.handle.createTab("about:blank");
    let tab;
    try {
      tab = this.registerTab(browser, targetId, sessionId, "about:blank");
      await this.applyPersonaTimezone(tab);
      await this.ensureVisible(tab).catch(() => null);
      await this.navigateInTab(tab, url, a.settle_ms ?? 300);
    } catch (e) {
      // A failed open must not leak a blank tab nobody holds an id for
      // (downloads end in ERR_ABORTED, hung navigations time out). An
      // aborted navigation can also leave a REPLACEMENT target the id
      // never pointed at — sweep every page we do not still track.
      if (tab) this.deregisterTab(tab);
      try { await browser.handle.closeTabTarget(targetId); } catch {}
      const keep = [...this.tabs.values()].map((t) => t.targetId);
      await browser.handle.sweepStrayPages(keep).catch(() => {});
      if (e instanceof AxError) {
        throw new AxError(e.code, `${e.message} The tab axuse created for it was closed.`,
          { ...e, facts: { ...(e.facts ?? {}), tab_closed: true } });
      }
      throw e;
    }
    const tabId = tab.tabId;
    let observation;
    try {
      observation = await this.observation(tab, { mode: "full" });
    } catch (e) {
      // Navigation succeeded, so keep the tab — but hand its id back.
      if (e instanceof AxError) {
        throw new AxError(e.code, e.message, { ...e, facts: { ...(e.facts ?? {}), tab_id: tabId, browser_id: browser.browserId } });
      }
      throw e;
    }
    // Server-mode fact: headed Chrome on an auto-booted virtual display —
    // the anti-bot-safe lane on display-less hosts (never --headless).
    const vd = virtualDisplayStatus();
    return {
      browser_id: browser.browserId, tab_id: tabId, backend, ...(a.backend ? {} : { backend_reason: reason }),
      observation, dialog: tab.dialog ?? null,
      ...(vd.active ? { display: { id: vd.display, virtual: true, width: vd.width, height: vd.height } } : {}),
    };
  }

  /** Open a bounded source list without forcing the caller to write an MCP
   * client. Results are deliberately compact; callers can use ax_open for a
   * single page when they need the full interactive snapshot and live refs. */
  async $open_many(a) {
    if (a.urls.length > MAX_OPEN_MANY_URLS) {
      throw new AxError(Codes.COMMAND_REJECTED,
        `open_many accepts at most ${MAX_OPEN_MANY_URLS} URLs (received ${a.urls.length})`,
        { retry: "never" });
    }
    const closeAfter = a.close_after ?? true;
    const excerptChars = Math.min(Math.max(Math.floor(a.excerpt_chars ?? 1600), 0), 20_000);
    const results = [];

    for (const url of a.urls) {
      const before = new Set(this.tabs.keys());
      let opened = null;
      try {
        opened = await this.$open({
          url,
          headless: a.headless,
          cdp_url: a.cdp_url,
          backend: a.backend,
          executable_path: a.executable_path,
          proxy: a.proxy,
          proxy_bypass: a.proxy_bypass,
          timezone: a.timezone,
          lang: a.lang,
          settle_ms: a.settle_ms,
        });
        const obs = opened.observation ?? {};
        const body = String(obs.text ?? "").split("\n").slice(3).join("\n").trim();
        const excerpt = excerptChars ? body.slice(0, excerptChars) : "";
        results.push({
          url,
          final_url: obs.url ?? url,
          title: obs.title ?? "",
          status: "opened",
          ref_count: obs.ref_count ?? 0,
          truncated: !!obs.truncated,
          ...(excerpt ? { excerpt } : {}),
          ...(!closeAfter ? { tab_id: opened.tab_id } : {}),
        });
      } catch (e) {
        const created = [...this.tabs.keys()].filter((id) => !before.has(id));
        const error = typeof e?.toJSON === "function"
          ? e.toJSON()
          : { code: e?.code ?? Codes.INTERNAL, message: String(e?.message ?? e), retry: "never" };
        results.push({
          url,
          status: "error",
          ...(created.at(-1) && !closeAfter ? { tab_id: created.at(-1) } : {}),
          error,
        });
      } finally {
        if (closeAfter) {
          const created = [...this.tabs.keys()].filter((id) => !before.has(id));
          for (const tabId of created) {
            try { await this.$close({ tab_id: tabId }); } catch {}
          }
        }
      }
    }

    return {
      results,
      count: results.length,
      opened: results.filter((r) => r.status === "opened").length,
      failed: results.filter((r) => r.status === "error").length,
      closed_after: closeAfter,
    };
  }

  registerTab(browser, targetId, sessionId, url, openerTabId) {
    // Governance: bounded tabs per process (AXUSE_MAX_TABS, default 48) —
    // runaway popup chains must fail typed, not eat the box.
    const maxTabs = Number(process.env.AXUSE_MAX_TABS ?? 48);
    if (this.tabs.size >= maxTabs) {
      throw new AxError(Codes.COMMAND_REJECTED,
        `Tab cap reached: ${this.tabs.size}/${maxTabs} (AXUSE_MAX_TABS). Close tabs with ax_close before opening more.`,
        { retry: "retry" });
    }
    const tabId = `t${++this.tabSeq}`;
    const tab = {
      tabId, browserId: browser.browserId, targetId, sessionId,
      url, title: "", stateId: 0, lastSnapshot: null, lastUsedAt: Date.now(),
      events: [], eventSeq: 0, dialog: null, closed: false,
      frames: new Map(), // OOPIF child sessionId → {slot, sessionId, targetId, url}
      frameSeq: 0,
      downloads: new Map(), // guid → {suggestedFilename, url, state, receivedBytes, totalBytes} (R1)
      cdpBroadcasts: [], // [method, params] replays on every future frame attach (R2)
      browser,
      ...(openerTabId ? { opener: openerTabId } : {}),
    };
    this.tabs.set(tabId, tab);
    browser.tabs.add(tabId);
    this.activeTabId = tabId;
    this.attachEventRouting(tab);
    void this.enableNetTracking(tab);
    this.startReaper();
    return tab;
  }

  /** Every agent shares this server's tab table, and a subagent that ends
   *  without ax_close leaves its tabs behind (the server cannot see agents
   *  end). Close tabs nothing has touched for AXUSE_TAB_IDLE_MS. */
  startReaper() {
    if (this.reaperTimer || !tabIdleMs()) return;
    this.reaperTimer = setInterval(() => { void this.reapIdleTabs(); }, Math.min(60_000, tabIdleMs()));
    if (this.reaperTimer.unref) this.reaperTimer.unref();
  }

  async reapIdleTabs(now = Date.now()) {
    const idle = tabIdleMs();
    if (!idle || this.disposing) return [];
    const reaped = [];
    for (const tab of [...this.tabs.values()]) {
      if (now - (tab.lastUsedAt ?? now) < idle) continue;
      this.closedTabs.set(tab.tabId, "idle_reaped");
      this.deregisterTab(tab);
      try { await tab.browser.handle.closeTabTarget(tab.targetId); } catch {}
      reaped.push(tab.tabId);
    }
    return reaped;
  }

  /**
   * Popups / target=_blank / window.open: a page target whose opener is a
   * controlled tab is adopted as a new controlled tab and becomes active —
   * otherwise the agent clicks a link and the result silently vanishes.
   * Targets we didn't open (the user's own tabs on an attached browser)
   * are never touched.
   */
  async watchPopups(rec) {
    const conn = rec.handle.conn;
    if (!conn?.onEvent) return;
    rec.adopted = [];
    conn.onEvent((msg) => {
      if (msg.sessionId) return;
      if (msg.method === "Target.targetCreated") {
        const ti = msg.params.targetInfo;
        if (ti?.type !== "page" || !ti.openerId) return;
        const opener = [...this.tabs.values()].find((t) => t.targetId === ti.openerId && t.browserId === rec.browserId);
        if (!opener || [...this.tabs.values()].some((t) => t.targetId === ti.targetId)) return;
        const p = rec.handle.attachTab(ti.targetId).then(async ({ sessionId }) => {
          const tab = this.registerTab(rec, ti.targetId, sessionId, ti.url || "about:blank", opener.tabId);
          await this.applyPersonaTimezone(tab);
          this.recordEvent(opener, "tab.opened", { tab_id: tab.tabId, url: ti.url });
          rec.adopted.push(tab.tabId);
          return tab;
        }).catch(() => null);
        rec.pendingAdopt = (rec.pendingAdopt ?? Promise.resolve()).then(() => p);
      } else if (msg.method === "Target.targetDestroyed") {
        const tab = [...this.tabs.values()].find((t) => t.targetId === msg.params.targetId && t.browserId === rec.browserId);
        if (tab && tab.opener) this.deregisterTab(tab);
      }
    });
    try { await conn.send("Target.setDiscoverTargets", { discover: true }); } catch {}
  }

  /** After an action: if it opened popup tabs, report them (with a full
   *  observation of the newest, which is now the active tab). */
  async popupReport(tab) {
    const rec = tab.browser;
    if (!rec.adopted) return null;
    await new Promise((ok) => setTimeout(ok, 150));
    await rec.pendingAdopt;
    if (!rec.adopted.length) return null;
    const ids = rec.adopted.splice(0);
    const newest = this.tabs.get(ids.at(-1));
    if (!newest) return null;
    try { await this.settleLoad(newest); } catch {}
    const observation = await this.observation(newest, { mode: "full" }).catch(() => null);
    return {
      opened_tabs: ids,
      tab_note: `The action opened a new tab ${newest.tabId}. Its observation is below; the original tab ${tab.tabId} is unchanged — pass tab_id:"${newest.tabId}" to act in the new tab, tab_id:"${tab.tabId}" to act here again.`,
      new_tab: { tab_id: newest.tabId, observation },
    };
  }

  async settleLoad(tab) {
    // Wait (bounded) for the popup document to finish loading.
    for (let i = 0; i < 30; i++) {
      const st = await this.evalInTab(tab, "document.readyState", { awaitPromise: false }).catch(() => null);
      if (st === "complete" || st === "interactive") { await this.settle(tab, 2000, 150); return; }
      await new Promise((ok) => setTimeout(ok, 100));
    }
  }

  /** The active browser's launch posture — the facts solver results carry
   *  so agents (and operators) can see headless vs headed vs the server-mode
   *  virtual display, and get warned when they are about to fight a
   *  challenge page from a detected browser shape. */
  browserPosture() {
    let rec = null;
    if (this.activeTabId && this.tabs.has(this.activeTabId)) {
      rec = this.browsers.get(this.tabs.get(this.activeTabId).browserId) ?? null;
    }
    if (!rec || !rec.handle) {
      rec = [...this.browsers.values()].find((b) => b.handle && !b.handle.conn.closed) ?? null;
    }
    if (!rec) return { posture: "no-browser" };
    const vd = virtualDisplayStatus();
    const headless = String(rec.key).startsWith("launch:headless");
    return {
      posture: headless ? "headless" : (vd.active ? "headed-on-virtual-display" : "headed"),
      ...(vd.active ? { display: vd.display } : {}),
      ...(rec.egress ? { egress: rec.egress } : {}),
      ...(rec.persona ? { persona: rec.persona } : {}),
    };
  }

  async ensureBrowser({ headless, cdpUrl, executablePath, backend, profileDir, proxy, proxyBypass, timezone, lang }) {
    // Extension backend: the user's real Chrome through the axuse bridge
    // (Codex pattern: one browser, the user's own, tabs visible to them).
    if (backend === "extension") {
      const key = "extension";
      const existing = this.browserIndex.get(key);
      if (existing) {
        const b = this.browsers.get(existing);
        if (b && !b.handle.conn.closed) return b;
        this.browsers.delete(existing);
        this.browserIndex.delete(key);
      }
      const { createExtensionHandle } = await import("../bridge/backend.js");
      const handle = await createExtensionHandle();
      const browserId = `b${++this.browserSeq}`;
      const rec = { browserId, handle, tabs: new Set(), key };
      this.browsers.set(browserId, rec);
      this.browserIndex.set(key, browserId);
      return rec;
    }
    // Governance (massive operations): one process, bounded browsers — an
    // unbounded fan-out of per-proxy browsers OOM-kills the box instead of
    // failing typed. AXUSE_MAX_BROWSERS (default 8) caps concurrent
    // launched browsers; reuse of an existing key is always allowed.
    // The key includes the FULL per-instance persona (proxy + tz + lang):
    // one process, one coherent persona per exit — and persona changes
    // launch a new browser, never mutate a live one.
    const key = cdpUrl
      ? `attach:${cdpUrl}`
      : `launch:${headless ? "headless" : "headed"}:${proxy ?? process.env.AXUSE_PROXY ?? "direct"}:${timezone ?? process.env.AXUSE_TIMEZONE ?? ""}:${lang ?? process.env.AXUSE_LANG ?? ""}:${profileDir ?? "ephemeral"}`;
    const maxBrowsers = Number(process.env.AXUSE_MAX_BROWSERS ?? 8);
    const existingByKey = this.browserIndex.get(key);
    if (!cdpUrl && !existingByKey && this.browsers.size >= maxBrowsers
      && [...this.browsers.values()].some((b) => b.handle.launched)) {
      const live = [...this.browsers.keys()].join(", ");
      throw new AxError(Codes.COMMAND_REJECTED,
        `Browser cap reached: ${this.browsers.size}/${maxBrowsers} launched browsers (AXUSE_MAX_BROWSERS; live: ${live}). `
        + `Reuse tabs (ax_open opens tabs in the active browser), close one with ax_close {browser:true}, or raise the cap when the box has headroom.`,
        { retry: "retry" });
    }
    const existing = this.browserIndex.get(key);
    if (existing) {
      const b = this.browsers.get(existing);
      if (b && !b.handle.conn.closed) return b;
      this.browsers.delete(existing);
      this.browserIndex.delete(key);
    }
    const handle = cdpUrl
      ? await BrowserHandle.attach(cdpUrl)
      : await BrowserHandle.launch({ headless, executablePath, userDataDir: profileDir, proxy, proxyBypass, timezone, lang });
    const browserId = `b${++this.browserSeq}`;
    const rec = { browserId, handle, tabs: new Set(), key };
    // Egress + persona facts for solver results (parseProxySpec strips
    // credentials — only the scheme://host:port ever surfaces).
    const egressSpec = parseProxySpec(proxy ?? process.env.AXUSE_PROXY ?? "");
    if (egressSpec) rec.egress = egressSpec.server;
    if (timezone || lang) rec.persona = { ...(timezone ? { timezone } : {}), ...(lang ? { lang } : {}) };
    this.browsers.set(browserId, rec);
    this.browserIndex.set(key, browserId);
    await this.watchPopups(rec);
    return rec;
  }

  attachEventRouting(tab) {
    const off = tab.browser.handle.conn.onEvent((msg) => {
      // Frame lifecycle (auto-attach): Target.attachedToTarget events arrive
      // tagged with the PARENT tab session; type "iframe" children register
      // as frames (type "page" children are ignored — a duplicate attach).
      if (msg.sessionId === tab.sessionId && msg.method === "Target.attachedToTarget") {
        const ti = msg.params.targetInfo;
        if (ti && ti.type === "iframe") {
          this.registerFrame(tab, msg.params).catch(() => {});
        }
        return;
      }
      if (msg.sessionId === tab.sessionId && msg.method === "Target.detachedFromTarget") {
        const frame = tab.frames.get(msg.params.sessionId);
        if (frame) {
          tab.frames.delete(msg.params.sessionId);
          this.recordEvent(tab, "frame.detached", { frame: `f${frame.slot}`, url: frame.url });
        }
        return;
      }
      // Events from frame sessions are tagged with their frame slot.
      if (tab.frames.has(msg.sessionId)) {
        if (RECORDED_EVENTS.has(msg.method)) {
          this.recordEvent(tab, msg.method, msg.params, `f${tab.frames.get(msg.sessionId).slot}`);
        }
        return;
      }
      if (msg.sessionId === tab.sessionId && msg.method === "tab.removed") {
        // The tab is gone in the browser (extension backend): drop it so it
        // never stays the implicit target, and remember why.
        const cause = msg.params?.cause ?? "closed";
        if (cause !== "axuse_close" && !tab.closed) {
          this.closedTabs.set(tab.tabId, cause);
          this.deregisterTab(tab);
        }
        return;
      }
      if (msg.sessionId === tab.sessionId && msg.method === "debugger.detached") {
        this.recordEvent(tab, "debugger.detached", { reason: msg.params?.reason ?? null });
        return;
      }
      if (msg.sessionId === tab.sessionId && tab.net && msg.method?.startsWith("Network.")) {
        this.trackNet(tab, msg.method, msg.params);
        return;
      }
      if (msg.sessionId !== tab.sessionId || !RECORDED_EVENTS.has(msg.method)) return;
      this.recordEvent(tab, msg.method, msg.params);
    });
    tab.offEventRouting = off;
  }

  /** Persona timezone on Windows. The launch sets TZ for the browser process,
   *  which Linux and macOS Chrome honor but Windows Chrome ignores, so a Tokyo
   *  persona silently kept the machine's clock. CDP's timezone override is the
   *  cross-platform lever; it is applied where TZ is ineffective, before the
   *  tab's first navigation (and on every adopted popup / OOPIF frame). */
  async applyPersonaTimezone(tab, sessionId = tab.sessionId) {
    if (process.platform !== "win32") return;
    const timezoneId = tab.browser?.persona?.timezone ?? tab.browser?.handle?.persona?.timezone;
    if (!timezoneId) return;
    try { await tab.browser.handle.conn.send("Emulation.setTimezoneOverride", { timezoneId }, sessionId); } catch { /* invalid zone ids already fail the launch check */ }
  }

  /** In-flight XHR/fetch/document tracking for post-action settling. Passive:
   *  nothing is injected into the page, only CDP Network events are counted.
   *  AXUSE_NET_SETTLE=0 turns it off (then settling is timing-only). */
  async enableNetTracking(tab) {
    if (!netSettleEnabled()) return;
    tab.net = { inflight: new Map(), seq: 0 };
    try {
      await tab.browser.handle.conn.send("Network.enable",
        { maxTotalBufferSize: 1 << 20, maxResourceBufferSize: 1 << 18 }, tab.sessionId);
    } catch { tab.net = null; }
  }

  trackNet(tab, method, params) {
    const net = tab.net;
    if (method === "Network.requestWillBeSent") {
      if (NET_TRACKED.has(params?.type)) { net.inflight.set(params.requestId, Date.now()); net.seq++; }
    } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      net.inflight.delete(params?.requestId);
    }
  }

  /** True while a page-triggered request that is not a long-poll is pending. */
  netBusy(tab) {
    const net = tab.net;
    if (!net) return false;
    const now = Date.now();
    for (const [id, t0] of net.inflight) {
      if (now - t0 > NET_LONGPOLL_MS) net.inflight.delete(id);
      else return true;
    }
    return false;
  }

  /** Wait (bounded) until the page's own requests have landed, then give the
   *  render a beat. Returns whether it actually had to wait. */
  async awaitNetworkIdle(tab, capMs = netSettleCapMs()) {
    if (!tab.net || !this.netBusy(tab)) return false;
    const t0 = Date.now();
    while (this.netBusy(tab) && Date.now() - t0 < capMs) await sleep(30);
    await sleep(90);
    return true;
  }

  /** The action showed no change. Watch briefly for a late one: a DOM
   *  mutation, or the page firing a request (debounced handlers). */
  async awaitLateChange(tab, maxMs) {
    const seq0 = tab.net?.seq ?? 0;
    const mutation = this.evalInTab(tab, mutationWaitExpression(maxMs, 120), { awaitPromise: true }).then((v) => v === true, () => false);
    const request = (async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < maxMs) {
        if ((tab.net?.seq ?? 0) > seq0) { await this.awaitNetworkIdle(tab); return true; }
        await sleep(30);
      }
      return false;
    })();
    return new Promise((resolve) => {
      let pending = 2;
      for (const p of [mutation, request]) p.then((v) => { if (v) resolve(true); else if (--pending === 0) resolve(false); });
    });
  }

  async registerFrame(tab, { sessionId, targetInfo }) {
    if (tab.frames.has(sessionId)) return;
    const conn = tab.browser.handle.conn;
    // Frame slots are identity-stable (monotonic per tab): refs f2:e7 keep
    // pointing at the same frame across observations, mirroring the element
    // registry design.
    const slot = ++tab.frameSeq;
    const frame = { slot, sessionId, targetId: targetInfo.targetId, url: targetInfo.url ?? "" };
    tab.frames.set(sessionId, frame);
    try {
      await conn.send("Page.enable", {}, sessionId);
      await conn.send("Runtime.enable", {}, sessionId);
      await conn.send("Log.enable", {}, sessionId);
      await this.applyPersonaTimezone(tab, sessionId);
      // Nested cross-origin frames auto-attach within the frame session too.
      await conn.send("Target.setAutoAttach",
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
    } catch {}
    // Plugin prerequisite R2: domain enables broadcast by plugins (Fetch/
    // Network, WebAuthn) must survive cross-origin frame churn — replay the
    // registered broadcasts on every newly attached frame session.
    for (const [method, params] of tab.cdpBroadcasts) {
      try { await conn.send(method, params, sessionId); } catch {}
    }
    this.recordEvent(tab, "frame.attached", { frame: `f${slot}`, url: frame.url });
  }

  /** Plugin plumbing (R1-R4): typed CDP passthrough on a controlled tab's
   *  connection — the narrow lever for Storage (cookies, R4), Browser
   *  (download behavior, R1), WebAuthn (virtual authenticators, R3), Fetch /
   *  Network (governor, R2) and raw Input.* dispatch (human-curve drags).
   *  Dialog-aware like every input send; the plugin never touches the
   *  Controller itself. */
  async cdpSend(tabId, method, params = {}, sessionId) {
    const tab = this.tabOrActive(tabId);
    return this.raceDialog(tab, tab.browser.handle.conn.send(method, params, sessionId ?? tab.sessionId));
  }

  /** Plugin prerequisite R2 (event delivery): subscribe to raw CDP events on
   *  the tab's connection. The handler receives the full message
   *  ({ method, params, sessionId? }); events from the tab's own session and
   *  its OOPIF frame sessions are delivered (scope by msg.sessionId against
   *  tabs().frame_sessions). Returns an unsubscribe function. */
  cdpOn(tabId, method, handler) {
    const tab = this.tabOrActive(tabId);
    const frameSessions = () => new Set([...tab.frames.values()].map((f) => f.sessionId));
    const off = tab.browser.handle.conn.onEvent((msg) => {
      if (msg.method !== method) return;
      if (msg.sessionId && msg.sessionId !== tab.sessionId && !frameSessions().has(msg.sessionId)) return;
      handler(msg);
    });
    return () => { try { off(); } catch {} };
  }

  /** Plugin prerequisite R2: send to the tab session AND every attached
   *  OOPIF frame session, and replay on every future frame attach (Fetch/
   *  Network enables must survive cross-origin frame churn). Broadcasts are
   *  deduped by method+params; per-frame send failures never fail the call. */
  async cdpBroadcast(tabId, method, params = {}) {
    const tab = this.tabOrActive(tabId);
    const key = JSON.stringify([method, params]);
    if (!tab.cdpBroadcasts.some((pair) => JSON.stringify(pair) === key)) {
      tab.cdpBroadcasts.push([method, params]);
    }
    await this.raceDialog(tab, tab.browser.handle.conn.send(method, params, tab.sessionId));
    let frames = 0;
    for (const [, f] of tab.frames) {
      try {
        await this.raceDialog(tab, tab.browser.handle.conn.send(method, params, f.sessionId));
        frames++;
      } catch {}
    }
    return { sent: 1 + frames, sessions: 1 + tab.frames.size, replayedOnAttach: true };
  }

  recordEvent(tab, method, params, frame) {
    let data = params ?? {};
    if (method === "Page.javascriptDialogOpening") {
      tab.dialog = { type: params.type, message: String(params.message ?? "").slice(0, 300), default_prompt: params.defaultPrompt ?? "" };
      data = { type: params.type, message: tab.dialog.message };
    } else if (method === "Page.fileChooserOpened") {
      tab.fileChooser = { backendNodeId: params.backendNodeId, mode: params.mode };
      data = { mode: params.mode };
    } else if (method === "Page.javascriptDialogClosed") {
      tab.dialog = null;
      data = {};
    } else if (method === "Page.frameNavigated") {
      if (!params.frame.parentId) { // main frame only for the tab-level fact
        tab.dialog = null;
        data = { url: params.frame.url, frameId: params.frame.id };
        tab.url = params.frame.url;
      } else return; // child frames → noise
    } else if (method === "Page.navigatedWithinDocument") {
      tab.url = params.url;
      data = { url: params.url };
    } else if (method === "Runtime.consoleAPICalled") {
      if (params.type !== "error" && params.type !== "warning") return;
      const text = (params.args ?? []).map((x) => x.value ?? x.description ?? "").join(" ").slice(0, 300);
      data = { type: params.type, text };
    } else if (method === "Log.entryAdded") {
      if (params.entry?.level !== "error") return;
      data = { source: params.entry.source, text: String(params.entry.text ?? "").slice(0, 300) };
    } else if (method === "Page.loadEventFired" || method === "Page.windowOpen" || method === "Page.crashed") {
      data = {};
    } else if (method === "Page.downloadWillBegin") {
      // Plugin prerequisite R1: download lifecycle through the event ring —
      // a click that produces a file must never hang an agent silently.
      const dl = {
        guid: params.guid ?? null,
        suggestedFilename: params.suggestedFilename ?? null,
        url: params.url ?? null,
        state: "inProgress", receivedBytes: 0, totalBytes: null,
      };
      if (params.guid) tab.downloads.set(params.guid, dl);
      data = { ...dl };
    } else if (method === "Page.downloadProgress") {
      const dl = params.guid ? (tab.downloads.get(params.guid) ?? { guid: params.guid, suggestedFilename: null, url: null }) : null;
      if (dl) {
        if (typeof params.state === "string") dl.state = params.state;
        if (Number.isFinite(params.receivedBytes)) dl.receivedBytes = params.receivedBytes;
        if (Number.isFinite(params.totalBytes)) dl.totalBytes = params.totalBytes;
        tab.downloads.set(params.guid, dl);
      }
      data = { guid: params.guid ?? null, state: dl?.state ?? params.state ?? null, receivedBytes: dl?.receivedBytes ?? null, totalBytes: dl?.totalBytes ?? null };
    }
    tab.eventSeq += 1;
    tab.events.push({ sequence: tab.eventSeq, method, ...(frame ? { frame } : {}), data });
    if (tab.events.length > EVENT_RING_MAX) tab.events.splice(0, tab.events.length - EVENT_RING_MAX);
  }

  async navigateInTab(tab, url, settleMs = 300) {
    if (tab.browser.key === "extension" && /^data:/i.test(url)) return this.loadDataUrl(tab, url, settleMs);
    let res;
    try {
      res = await tab.browser.handle.conn.send("Page.navigate", { url }, tab.sessionId);
    } catch (e) {
      throw new AxError(Codes.NAVIGATION_IN_PROGRESS, `Navigation to ${url} failed: ${e.message}`,
        { hint: "Check the URL; ax_observe to see current state.", retry: "never" });
    }
    if (res && res.errorText) {
      throw new AxError(Codes.NAVIGATION_IN_PROGRESS, `Navigation error: ${res.errorText} (${url})`,
        { hint: /ERR_ABORTED/.test(res.errorText)
          ? "ERR_ABORTED usually means the URL is a download (PDF, attachment) or a top-level navigation the browser refuses — it is not a page to drive; fetch the file another way."
          : "The tab may be blocked by the network or bot detection. Observe to inspect.", retry: "never" });
    }
    tab.url = url;
    tab.lastSnapshot = null; // refs died with the old document
    await this.settle(tab, 4000, settleMs);
  }

  /** Extension backend: Chrome refuses top-level data: navigations from
   *  chrome.debugger (ERR_ABORTED). HTML/text data: URLs are loaded by
   *  writing their decoded content into the tab's own about:blank document. */
  async loadDataUrl(tab, url, settleMs) {
    const m = /^data:([^,]*?),(.*)$/is.exec(url);
    const meta = (m?.[1] ?? "").toLowerCase();
    const mime = meta.split(";")[0].trim() || "text/plain";
    if (!m || !/^(text\/html|text\/plain|application\/xhtml\+xml)$/.test(mime)) {
      throw new AxError(Codes.COMMAND_REJECTED,
        `The extension backend cannot open a top-level ${mime} data: URL (Chrome blocks top-level data: navigations).`,
        { hint: "Serve the content from localhost (http://127.0.0.1:...) or use backend cdp.", retry: "never" });
    }
    let body;
    try {
      body = /;base64$/.test(meta) ? Buffer.from(m[2], "base64").toString("utf8") : decodeURIComponent(m[2]);
    } catch {
      throw new AxError(Codes.COMMAND_REJECTED, "Malformed data: URL (could not decode the payload).", { retry: "never" });
    }
    const html = mime === "text/plain"
      ? `<!doctype html><pre>${body.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])}</pre>`
      : body;
    const conn = tab.browser.handle.conn;
    try {
      if (!/^about:blank/.test(tab.url)) {
        await conn.send("Page.navigate", { url: "about:blank" }, tab.sessionId);
        await this.settle(tab, 2000, 50);
      }
      const { frameTree } = await conn.send("Page.getFrameTree", {}, tab.sessionId);
      await conn.send("Page.setDocumentContent", { frameId: frameTree.frame.id, html }, tab.sessionId);
    } catch (e) {
      throw new AxError(Codes.NAVIGATION_IN_PROGRESS, `Loading the data: URL failed: ${e.message}`,
        { hint: "Serve the content from localhost instead.", retry: "never" });
    }
    tab.url = "about:blank";
    tab.lastSnapshot = null;
    this.recordEvent(tab, "data_url.loaded", { mime, via: "Page.setDocumentContent", note: "page origin is about:blank, not data:" });
    await this.settle(tab, 4000, settleMs);
  }

  async $navigate(a) {
    const tab = this.tabOrActive(a.tab_id);
    this.checkDialog(tab);
    await this.navigateInTab(tab, String(a.url), a.settle_ms ?? 300);
    const observation = await this.observation(tab, { mode: "full" });
    return { tab_id: tab.tabId, observation };
  }

  async $go(a) {
    const tab = this.tabOrActive(a.tab_id);
    this.checkDialog(tab);
    const delta = a.delta ?? -1;
    const hist = await tab.browser.handle.conn.send("Page.getNavigationHistory", {}, tab.sessionId);
    const idx = Math.min(Math.max(hist.currentIndex + delta, 0), hist.entries.length - 1);
    await tab.browser.handle.conn.send("Page.navigateToHistoryEntry", { entryId: hist.entries[idx].id }, tab.sessionId);
    tab.lastSnapshot = null;
    await this.settle(tab, 4000, 300);
    const observation = await this.observation(tab, { mode: "full" });
    return { tab_id: tab.tabId, observation };
  }

  async $tabs() {
    const out = [];
    for (const [tabId, tab] of this.tabs) {
      out.push({
        tab_id: tabId,
        browser_id: tab.browserId,
        url: tab.url,
        title: tab.lastSnapshot?.title ?? tab.title,
        state_id: tab.stateId,
        frames: tab.frames.size, // OOPIF frames merged under f-slot refs
        // Frame sessions (for plugin cdp(sessionId) routing — R2 plumbing):
        frame_sessions: [...tab.frames.values()].map((f) => ({ frame: `f${f.slot}`, url: f.url, session_id: f.sessionId })),
        // Live downloads (R1): guid-keyed, for downloads-pdf adoption.
        downloads: [...tab.downloads.values()].map(({ guid, suggestedFilename, url, state, receivedBytes, totalBytes }) => ({ guid, suggested_filename: suggestedFilename, url, state, received_bytes: receivedBytes, total_bytes: totalBytes })),
        ...(tab.dialog ? { dialog: tab.dialog } : {}),
      });
    }
    return { tabs: out, active_tab_id: this.activeTabId };
  }

  async $observe(a) {
    const tab = this.tabOrActive(a.tab_id);
    if (tab.dialog) {
      throw new AxError(Codes.DIALOG_OPEN, `A ${tab.dialog.type} dialog is open: "${tab.dialog.message}" — the page is frozen.`,
        { hint: "Answer it with ax_dialog first.", retry: "retry" });
    }
    const mode = a.mode ?? "diff";
    const maxNodes = Math.min(a.max_nodes ?? 300, 2000);
    const maxChars = Math.min(a.max_chars ?? 24000, 200000);
    if (a.find) return { tab_id: tab.tabId, observation: await this.findObservation(tab, a.find) };
    if (mode === "text") return { tab_id: tab.tabId, observation: await this.textObservation(tab, Math.min(a.max_chars ?? 100_000, 200_000)) };
    const observation = await this.observation(tab, { mode, maxNodes, maxChars });
    return { tab_id: tab.tabId, observation };
  }

  /**
   * Grep the (large-budget) snapshot for `needle`: matching lines plus a
   * little context, refs intact. The snapshot becomes the diff baseline, so
   * later actions still return proper diffs.
   */
  async findObservation(tab, needle, { before = 2, after = 3, maxHits = 12, maxItemLines = 14 } = {}) {
    const obs = await this.observation(tab, { mode: "full", maxNodes: 2000, maxChars: 200000 });
    const lines = obs.text.split("\n");
    const head = lines.slice(0, 3);
    const body = lines.slice(3);
    // Item ownership of each body line (0 = not inside an article/li/row).
    // A flat list makes the line above a match belong to the PREVIOUS item;
    // showing the match with its own item keeps its buttons attached to it.
    const items = tab.lastSnapshot?.items ?? null;
    const itemOf = (i) => (items && i < items.length ? items[i] : 0);
    const n = String(needle).toLowerCase();
    const keep = new Set();
    let hits = 0;
    let grouped = false;
    body.forEach((l, i) => {
      if (hits >= maxHits || !l.toLowerCase().includes(n)) return;
      hits++;
      const id = itemOf(i);
      if (id) {
        let lo = i, hi = i;
        while (lo > 0 && itemOf(lo - 1) === id) lo--;
        while (hi < body.length - 1 && itemOf(hi + 1) === id) hi++;
        if (hi - lo + 1 > maxItemLines) { lo = Math.max(lo, i - before); hi = Math.min(hi, i + after + 3); }
        for (let k = lo; k <= hi; k++) keep.add(k);
        grouped = true;
      } else {
        for (let k = Math.max(0, i - before); k <= Math.min(body.length - 1, i + after); k++) keep.add(k);
      }
    });
    const out = [];
    let last = -2;
    for (const i of [...keep].sort((x, y) => x - y)) {
      if (i !== last + 1 && out.length) out.push("  …");
      else if (out.length && itemOf(i) !== itemOf(last)) out.push("  ·");
      out.push(body[i]);
      last = i;
    }
    const note = grouped ? "; each match is shown with its own item" : "";
    const text = [...head, `find "${needle}": ${hits ? `${hits} match${hits > 1 ? "es" : ""}` : "no matches"} (of ${body.length} lines${note})`, ...out].join("\n");
    return { ...obs, mode: "find", text };
  }

  /** Readable page text, no refs: the long-article read that snapshot
   *  budgets cut (news pages, filings). Does not advance state_id, so refs
   *  from the last snapshot stay valid. */
  async textObservation(tab, maxChars) {
    const res = await this.evalInTab(tab, `(() => {
      const t = (document.body ? document.body.innerText : document.documentElement.innerText) || "";
      return { url: location.href, title: document.title, text: t.slice(0, ${maxChars}), length: t.length };
    })()`);
    const truncated = res.length > maxChars;
    return {
      mode: "text", url: res.url, title: res.title, chars: res.length, truncated,
      text: `url: ${res.url}\ntitle: ${res.title}\nchars: ${res.length}${truncated ? ` (first ${maxChars} shown — raise max_chars, ≤200000)` : ""}\n${res.text}`,
    };
  }

  async $click(a) {
    const tab = this.tabOrActive(a.tab_id);
    this.checkDialog(tab);
    this.checkStale(tab, a);
    const pos = await this.resolveTarget(tab, a.target);
    await this.doSent(tab, () => doClick(this.ctx(tab, pos.session), {
      x: pos.x, y: pos.y,
      button: a.button ?? "left",
      count: a.count ?? 1,
      modifiers: this.modifierMask(a.modifiers),
      human: !!a.human,
    }));
    const observation = await this.autoObserve(tab, a.settle_ms ?? 150, { expectChange: true });
    const popup = await this.popupReport(tab);
    const noChange = typeof observation?.text === "string" && observation.text.startsWith("no changes detected");
    return {
      action_sent: "sent",
      ...(tab.fileChooser ? { tab_note: "The click opened a file chooser — answer it with ax_upload {paths:[...]} (no ref needed)." } : {}),
      ...(pos.frame ? { frame: pos.frame } : {}),
      ...(pos.covered ? { note: `Target center is covered by a ${pos.hitTag ?? "element"} — the click landed on the overlay. Verify with the observation diff and re-plan if wrong.` } : {}),
      ...(noChange && !tab.fileChooser && !popup ? {
        note: "No observable change, even after waiting for the page to settle. Do not repeat this click blindly: it is likely a no-op in this state (e.g. an already-selected tab). If you expected a change, ax_observe to see the real page state; retry once only if the page had just loaded.",
      } : {}),
      observation,
      ...(popup ?? {}),
    };
  }

  async $fill(a) {
    const tab = this.tabOrActive(a.tab_id);
    this.checkDialog(tab);
    this.checkStale(tab, a);
    const done = [];
    const fail = (i, f, msg, extraHint) => {
      throw new AxError(Codes.COMMAND_REJECTED, `fill: field ${i + 1} (${f.ref}) ${msg}. Filled before it: ${done.join(", ") || "none"}.`,
        { hint: [extraHint, "Fix that field (re-observe if the ref is gone) and call ax_fill again with the remaining fields."].filter(Boolean).join(" "), retry: "reobserve" });
    };
    const clickRef = async (r) => {
      const pos = await this.resolveTarget(tab, { ref: r });
      await this.doSent(tab, () => doClick(this.ctx(tab, pos.session), { x: pos.x, y: pos.y, button: "left", count: 1, modifiers: 0, human: !!a.human }));
    };
    for (const [i, f] of a.fields.entries()) {
      if (tab.dialog) fail(i, f, `was not filled: a ${tab.dialog.type} dialog opened`);
      const { session, ref } = this.sessionForRef(tab, f.ref);
      const info = await this.evalInTab(tab, fieldKindExpression(ref), { awaitPromise: false }, session);
      if (!info || info.error) {
        const foreign = info?.error === "no_ref" ? await this.foreignFieldHint(tab, f.ref) : null;
        fail(i, f, info?.error === "no_ref" ? "is gone (stale ref)" : `could not be inspected (${info?.error})`, foreign);
      }
      let what = "";
      if (info.kind === "bool") {
        const want = f.value === true || ["true", "on", "checked", "yes"].includes(String(f.value).toLowerCase());
        if (info.on !== want) await clickRef(f.ref);
        what = info.on !== want ? (want ? "checked" : "unchecked") : `already ${want ? "checked" : "unchecked"}`;
      } else if (info.kind === "select") {
        const res = await this.evalInTab(tab, selectOptionExpression(ref, String(f.value)), { awaitPromise: false }, session);
        if (!res || res.error) fail(i, f, `has no option "${f.value}" (options: ${(res?.options ?? []).join(", ")})`);
        what = `selected "${f.value}"`;
      } else if (info.kind === "popup") {
        await clickRef(f.ref);
        let opt = null;
        for (let k = 0; k < 10 && !opt?.ok; k++) {
          await new Promise((ok) => setTimeout(ok, 100));
          opt = await this.evalInTab(tab, findOptionExpression(f.value), { awaitPromise: false }, session);
        }
        if (!opt?.ok) fail(i, f, `opened but has no option "${f.value}" (visible: ${(opt?.visible ?? []).join(", ")})`);
        await clickRef(opt.ref);
        what = `opened, picked option "${opt.text}"`;
      } else if (info.kind === "slider") {
        what = await this.fillSlider(tab, f, { session, ref, clickRef, fail: (msg, hint) => fail(i, f, msg, hint) });
      } else if (info.kind === "text" || info.kind === "combo") {
        await clickRef(f.ref);
        const ctx = this.ctx(tab, session);
        await this.doSent(tab, () => pressCombo(ctx, selectAllCombo()));
        // human: per-key trusted events with human cadence — the lane for
        // login/credential forms on protected pages (keystroke-dynamics
        // sampling); the default stays the fast bulk insert.
        if (a.human) {
          await this.doSent(tab, () => humanType(ctx, String(f.value)));
        } else {
          await this.doSent(tab, () => insertText(ctx, String(f.value)));
        }
        if (info.kind === "combo") {
          // Autocomplete: wait for suggestions, pick the exact match.
          let opt = null;
          for (let k = 0; k < 12 && !opt?.ok; k++) {
            await new Promise((ok) => setTimeout(ok, 150));
            opt = await this.evalInTab(tab, findOptionExpression(f.value), { awaitPromise: false }, session);
          }
          if (opt?.ok) await clickRef(opt.ref);
          what = opt?.ok ? `typed "${f.value}", picked suggestion "${opt.text}"` : `typed "${f.value}" (no matching suggestion appeared)`;
        } else what = `typed "${f.value}"`;
      } else {
        const foreign = await this.foreignFieldHint(tab, f.ref);
        const desc = info.kind === "other" ? `${info.tag ?? "element"}${info.role ? `[role=${info.role}]` : ""}` : "element";
        fail(i, f, `is not a form field on tab ${tab.tabId} — it is a ${desc} here (use ax_click / ax_type)`, foreign);
      }
      done.push(`${f.ref} ${what}`);
    }
    let submitted = false;
    if (a.submit && !tab.dialog) {
      await clickRef(a.submit);
      submitted = true;
    }
    const observation = await this.autoObserve(tab, a.settle_ms ?? 200);
    return { action_sent: "sent", filled: done, ...(submitted ? { submitted: a.submit } : {}), observation, ...((await this.popupReport(tab)) ?? {}) };
  }

  /** Set an ARIA/native slider to a numeric value with trusted keyboard
   *  input only (ArrowUp/ArrowDown; no synthetic value writes). Step is
   *  discovered empirically with one key press; convergence is capped and
   *  verified after every press, so a clamped handle (the other end of a
   *  range pair) stops the loop honestly instead of spinning. */
  async fillSlider(tab, f, { session, ref, clickRef, fail }) {
    const target = Number(f.value);
    if (!Number.isFinite(target)) fail(`wants a number for a slider (got ${JSON.stringify(String(f.value))})`);
    await clickRef(f.ref); // focus the handle / native track
    const readNow = async () => {
      const r = await this.evalInTab(tab, sliderValueExpression(ref), { awaitPromise: false }, session);
      return r && !r.error ? r.now : null;
    };
    let now = await readNow();
    if (now === null) fail("has no readable slider value (aria-valuenow / value missing)");
    if (Math.abs(now - target) < 1e-9) return `already at ${now}`;
    const ctx = this.ctx(tab, session);
    const key = target > now ? "up" : "down";
    const prev = now;
    await this.doSent(tab, () => pressCombo(ctx, key));
    now = (await readNow()) ?? prev;
    if (Math.abs(now - prev) < 1e-9) {
      fail(`did not respond to trusted keyboard ${key} — this widget needs pointer dragging; set it with ax_evaluate`,
        "The click focused it, but the value did not move one step.");
    }
    const step = Math.abs(now - prev);
    let presses = 1;
    while (Math.abs(target - now) >= step - 1e-9 && presses++ < 500) {
      await this.doSent(tab, () => pressCombo(ctx, key));
      const next = (await readNow()) ?? now;
      if (Math.abs(next - now) < 1e-9) break; // clamped (e.g. by the other handle of a range pair)
      now = next;
    }
    if (Math.abs(target - now) > step / 2 + 1e-9) {
      fail(`stopped at ${now} (target ${target}, step ${step}) — clamped or uneven stepping`,
        "The nearest reachable value was kept; finish exactly with ax_evaluate if the widget supports scripting.");
    }
    return `set to ${now} (from ${prev}, step ${step}, ${presses} trusted key presses)`;
  }

  /** Refs are per-tab (every page numbers its own e1, e2, …). When a fill
   *  misses right after a tab switch, the caller almost certainly observed
   *  one tab and is acting on another — check the other controlled tabs and
   *  name the one where this ref IS a fillable field. */
  async foreignFieldHint(activeTab, ref) {
    const FILLABLE = new Set(["bool", "select", "popup", "combo", "text", "slider"]);
    const hits = [];
    for (const [id, t] of this.tabs) {
      if (id === activeTab.tabId || !t.sessionId) continue;
      try {
        const info = await this.evalInTab(t, fieldKindExpression(ref), { awaitPromise: false });
        if (info && !info.error && FILLABLE.has(info.kind)) {
          hits.push(`${id} (${info.kind}, ${String(t.url).slice(0, 60)})`);
        }
      } catch { /* tab navigating or closed — not a candidate */ }
    }
    if (!hits.length) return null;
    return `Ref "${ref}" is a fillable field on ${hits.join(", ")} — pass that tab_id if that is the field you meant.`;
  }

  async $upload(a) {
    const tab = this.tabOrActive(a.tab_id);
    this.checkDialog(tab);
    const { existsSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const files = a.paths.map((p) => resolve(p));
    const missing = files.filter((f) => !existsSync(f));
    if (missing.length) throw new AxError(Codes.COMMAND_REJECTED, `upload: file not found: ${missing.join(", ")}`, { retry: "never" });
    const conn = tab.browser.handle.conn;
    if (a.ref) {
      const { session, ref } = this.sessionForRef(tab, a.ref);
      const ev = await conn.send("Runtime.evaluate", { expression: `(window.__axuseRefs||{})[${JSON.stringify(ref)}]`, returnByValue: false }, session);
      const objectId = ev?.result?.objectId;
      if (!objectId) throw new AxError(Codes.REF_NOT_FOUND, `ref "${a.ref}" is gone.`, { hint: "Call ax_observe, then retry.", retry: "reobserve" });
      await conn.send("DOM.setFileInputFiles", { files, objectId }, session);
    } else if (tab.fileChooser) {
      await conn.send("DOM.setFileInputFiles", { files, backendNodeId: tab.fileChooser.backendNodeId }, tab.sessionId);
    } else {
      throw new AxError(Codes.COMMAND_REJECTED, "upload: pass the ref of the file input (or click it first to open a file chooser).", { retry: "never" });
    }
    tab.fileChooser = null;
    return { action_sent: "sent", uploaded: files.map((f) => f.split(/[\\/]/).pop()), observation: await this.autoObserve(tab, a.settle_ms ?? 150) };
  }

  async $hover(a) {
    const tab = this.tabOrActive(a.tab_id);
    this.checkDialog(tab);
    this.checkStale(tab, a);
    const pos = await this.resolveTarget(tab, a.target);
    await this.doSent(tab, () => doHover(this.ctx(tab, pos.session), pos));
    return { action_sent: "sent", ...(pos.frame ? { frame: pos.frame } : {}), observation: await this.autoObserve(tab, a.settle_ms ?? 150) };
  }

  async $type(a) {
    const tab = this.tabOrActive(a.tab_id);
    this.checkDialog(tab);
    this.checkStale(tab, a);
    const pos = a.target ? await this.resolveTarget(tab, a.target) : null;
    const session = pos?.session;
    if (pos) {
      // human typing gets a human focus click too (the approach trajectory
      // a keystroke-dynamics sampler expects on the field as well).
      await this.doSent(tab, () => doClick(this.ctx(tab, session), { x: pos.x, y: pos.y, button: "left", count: 1, modifiers: 0, human: !!a.human }));
    }
    if (a.replace !== false) {
      await this.doSent(tab, () => pressCombo(this.ctx(tab, session), selectAllCombo()));
    }
    // human: per-key trusted events with a human cadence — for challenge and
    // login fields where keystroke dynamics are sampled (DataDome-class).
    // Default stays bulk insertText: fast, and what agent productivity needs.
    if (a.human) {
      await this.doSent(tab, () => humanType(this.ctx(tab, session), String(a.text)));
    } else {
      await this.doSent(tab, () => insertText(this.ctx(tab, session), String(a.text)));
    }
    if (a.submit) {
      await this.doSent(tab, () => pressCombo(this.ctx(tab, session), "enter"));
    }
    return { action_sent: "sent", ...(pos?.frame ? { frame: pos.frame } : {}), observation: await this.autoObserve(tab, a.settle_ms ?? 150) };
  }

  async $press(a) {
    const tab = this.tabOrActive(a.tab_id);
    this.checkDialog(tab);
    const combo = a.platform ? platformShortcut(a.combo) : a.combo;
    await this.doSent(tab, () => pressCombo(this.ctx(tab), combo));
    const observation = await this.autoObserve(tab, a.settle_ms ?? 150, { expectChange: true });
    return { action_sent: "sent", ...(combo !== a.combo ? { combo_sent: combo } : {}), observation, ...((await this.popupReport(tab)) ?? {}) };
  }

  async $scroll(a) {
    const tab = this.tabOrActive(a.tab_id);
    this.checkDialog(tab);
    const amount = a.amount ?? 1;
    let dx = a.dx ?? 0;
    let dy = a.dy ?? 0;
    if (a.direction) {
      const px = amount * 400;
      if (a.direction === "up") dy = -px;
      else if (a.direction === "down") dy = px;
      else if (a.direction === "left") dx = -px;
      else if (a.direction === "right") dx = px;
    }
    if (a.until) return this.scrollUntil(tab, a);
    if (!dx && !dy) throw new AxError(Codes.COMMAND_REJECTED, "scroll: pass direction/amount or dx/dy", { retry: "never" });
    let x, y, session;
    if (a.target) {
      const pos = await this.resolveTarget(tab, a.target);
      x = pos.x; y = pos.y; session = pos.session;
    } else {
      const vp = await this.evalInTab(tab, `({ w: innerWidth, h: innerHeight })`);
      x = vp.w / 2; y = vp.h / 2;
    }
    await this.doSent(tab, () => doWheel(this.ctx(tab, session), { x, y, dx, dy }));
    return { action_sent: "sent", observation: await this.autoObserve(tab, a.settle_ms ?? 150) };
  }

  /** Scroll (trusted wheel input) until `until` text exists in the page or
   *  the page stops growing; bounded. Infinite feeds load as we go. */
  /**
   * Scroll until `until` text is in the DOM, in ONE page-side loop. Works on
   * the window AND on inner scroll containers (virtualized grids, chat panes,
   * feeds in a div): scrollers are tried largest-first (or the target's own
   * scroller). Lazy lists get time to load at the end; bounded at 35 s.
   */
  async scrollUntil(tab, a) {
    const needle = String(a.until);
    let session;
    let targetExpr = "null";
    if (a.target?.ref) {
      const r = this.sessionForRef(tab, a.target.ref);
      session = r.session;
      targetExpr = `(window.__axuseRefs||{})[${JSON.stringify(r.ref)}]`;
    }
    const expr = `(async function(){
      var n = ${JSON.stringify(needle.toLowerCase())}, up = ${a.direction === "up"};
      function has(r){ if ((r.innerText || r.textContent || "").toLowerCase().indexOf(n) >= 0) return true;
        var all = r.querySelectorAll("*"); for (var i = 0; i < all.length; i++) if (all[i].shadowRoot && has(all[i].shadowRoot)) return true; return false; }
      function scrollable(el){ var cs = getComputedStyle(el); return /(auto|scroll|overlay)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 20 && el.clientHeight > 40; }
      var scrollers = [];
      var t = ${targetExpr};
      for (var e = t; e && e !== document.body; e = e.parentElement) if (scrollable(e)) { scrollers.push(e); break; }
      var se = document.scrollingElement || document.documentElement;
      if (se.scrollHeight > innerHeight + 20) scrollers.push(se);
      var cands = Array.prototype.filter.call(document.querySelectorAll("*"), function(el){ return el !== se && scrollable(el) && el.getBoundingClientRect().width > 0; });
      cands.sort(function(x, y){ return y.clientWidth * y.clientHeight - x.clientWidth * x.clientHeight; });
      scrollers = scrollers.concat(cands.slice(0, 4));
      var sleep = function(ms){ return new Promise(function(ok){ setTimeout(ok, ms); }); };
      var steps = 0, t0 = Date.now();
      if (has(document.body)) return { found: true, steps: 0, where: "already on the page" };
      for (var s = 0; s < scrollers.length; s++) {
        var el = scrollers[s], stuck = 0;
        while (Date.now() - t0 < 35000 && steps < 400) {
          var before = el.scrollTop, h = el.scrollHeight;
          var page = (el === se ? innerHeight : el.clientHeight) * 0.85;
          el.scrollTop = before + (up ? -page : page);
          steps++;
          await sleep(stuck ? 400 : 90);
          if (has(document.body)) return { found: true, steps: steps, where: el === se ? "page" : (el.getAttribute("aria-label") || el.id || el.tagName.toLowerCase()) };
          if (el.scrollTop === before && el.scrollHeight === h) { if (++stuck >= 5) break; } else stuck = 0;
        }
      }
      return { found: false, steps: steps, scrollers: scrollers.length, timedOut: Date.now() - t0 >= 35000 };
    })()`;
    const st = await this.raceDialog(tab, this.evalInTab(tab, expr, { awaitPromise: true }, session)) ?? {};
    if (st.found) {
      // Center the first match in its own scroller.
      await this.evalInTab(tab, `(function(){var n=${JSON.stringify(needle.toLowerCase())};var w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);var t;while((t=w.nextNode()))if(t.nodeValue.toLowerCase().indexOf(n)>=0){t.parentElement.scrollIntoView({block:"center"});return true}return false})()`, {}, session).catch(() => null);
      await new Promise((ok) => setTimeout(ok, 150));
    }
    const observation = await this.findObservation(tab, needle);
    const how = st.found ? `found after ${st.steps} scroll step${st.steps === 1 ? "" : "s"} (${st.where})` : st.timedOut ? "NOT found — gave up after 35 s" : `NOT found — scrolled ${st.steps} steps to the end of ${st.scrollers ?? 0} scrollable area(s)`;
    observation.text = `${how}\n` + observation.text;
    return { action_sent: "sent", observation };
  }

  async $select(a) {
    const tab = this.tabOrActive(a.tab_id);
    this.checkDialog(tab);
    this.checkStale(tab, a);
    const { session, ref } = this.sessionForRef(tab, a.ref);
    const res = await this.evalInTab(tab, selectOptionExpression(ref, a.value), { awaitPromise: false }, session);
    if (!res || res.error) {
      if (res?.error === "no_ref") {
        throw new AxError(Codes.REF_NOT_FOUND, `ref "${a.ref}" is gone.`, { hint: "Call ax_observe, then re-select.", retry: "reobserve" });
      }
      throw new AxError(Codes.COMMAND_REJECTED, `Option "${a.value}" not found. Available: ${(res?.options ?? []).join(", ")}`, { retry: "never" });
    }
    return { action_sent: "sent", value: res.value, observation: await this.autoObserve(tab, a.settle_ms ?? 150, { expectChange: true }) };
  }

  async $drag(a) {
    const tab = this.tabOrActive(a.tab_id);
    this.checkDialog(tab);
    this.checkStale(tab, a);
    const from = await this.resolveTarget(tab, a.from);
    const to = await this.resolveTarget(tab, a.to);
    await this.doSent(tab, () => doDrag(this.ctx(tab, from.session), { x: from.x, y: from.y }, { x: to.x, y: to.y }, a.steps ?? 12));
    return { action_sent: "sent", observation: await this.autoObserve(tab, a.settle_ms ?? 150) };
  }

  async $screenshot(a) {
    const tab = this.tabOrActive(a.tab_id);
    this.checkDialog(tab);
    const shot = await captureScreenshot(tab.browser.handle.conn, tab.sessionId, {
      crop: a.crop,
      budgetBytes: a.budget_bytes ?? DEFAULT_BUDGET_BYTES,
      quality: a.quality ?? 80,
    });
    return { image: { base64: shot.base64, mime: shot.mime, bytes: shot.bytes, budget_bytes: shot.budget_bytes, quality: shot.quality }, note: shot.geometry };
  }

  async $element_info(a) {
    const tab = this.tabOrActive(a.tab_id);
    const res = await this.evalInTab(tab, elementInfoExpression(a.x, a.y), { awaitPromise: false });
    if (!res || res.ok === false) {
      return { hit: null, hint: "Nothing actionable at that point — check coordinates against the latest screenshot." };
    }
    return { hit: { ref: res.ref, tag: res.tag, role: res.role, name: res.name, rect: res.rect, actionable: res.actionable } };
  }

  async $evaluate(a) {
    const tab = this.tabOrActive(a.tab_id);
    this.checkDialog(tab);
    const value = await this.evalInTab(tab, a.expression, { awaitPromise: true });
    let json;
    try {
      json = JSON.stringify(value ?? null);
    } catch {
      json = String(value);
    }
    if (json === undefined) json = "undefined";
    const truncated = json.length > MAX_EVAL_CHARS;
    return { value: truncated ? json.slice(0, MAX_EVAL_CHARS) + "…[truncated]" : json, truncated };
  }

  async $wait_for(a) {
    const tab = this.tabOrActive(a.tab_id);
    this.checkDialog(tab);
    const timeoutMs = Math.min(a.timeout_ms ?? 3000, 25000);
    let expr = a.expression;
    if (a.selector) {
      const sel = JSON.stringify(a.selector);
      expr = `(function(){var e=document.querySelector(${sel});return !!e && e.getBoundingClientRect().height>0;})()`;
    }
    if (a.text) {
      const t = JSON.stringify(String(a.text).toLowerCase());
      expr = `(document.body.innerText||"").toLowerCase().indexOf(${t})>=0`;
    }
    if (!expr) throw new AxError(Codes.COMMAND_REJECTED, "wait_for: pass selector, text or expression", { retry: "never" });
    const res = await this.raceDialog(tab, this.evalInTab(tab, waitForExpression(expr, timeoutMs), { awaitPromise: true }));
    const ok = !!res?.ok;
    // On success hand back what changed — saves the usual follow-up observe.
    return { ok, timeout: !!res?.timeout, elapsed_ms: res?.elapsed ?? null, ...(ok ? { observation: await this.autoObserve(tab, 100) } : {}) };
  }

  async $events(a) {
    const tab = this.tabOrActive(a.tab_id);
    const after = a.after_sequence ?? 0;
    const limit = Math.min(a.limit ?? 50, 1000);
    const events = tab.events.filter((e) => e.sequence > after).slice(0, limit);
    return {
      events,
      cursor: tab.eventSeq,
      has_more: tab.events.filter((e) => e.sequence > after).length > events.length,
      note: "Sequenced ring buffer (max 1000). Poll with after_sequence=cursor.",
    };
  }

  async $dialog(a) {
    const tab = this.tabOrActive(a.tab_id);
    if (!a.answer) {
      return { dialog: tab.dialog ?? null };
    }
    if (!tab.dialog) throw new AxError(Codes.COMMAND_REJECTED, "No dialog is open.", { retry: "never" });
    const answered = tab.dialog;
    await tab.browser.handle.conn.send("Page.handleJavaScriptDialog",
      { accept: a.answer === "accept", ...(a.prompt_text !== undefined ? { promptText: String(a.prompt_text) } : {}) }, tab.sessionId);
    // A follow-up dialog (confirm → prompt) may already be open: keep it.
    if (tab.dialog === answered) tab.dialog = null;
    return { answered: a.answer, observation: await this.autoObserve(tab, 150) };
  }

  async $close(a) {
    if (a.browser) {
      const count = this.browsers.size;
      await this.dispose();
      return { closed: { browsers: count } };
    }
    const tab = this.tabOrActive(a.tab_id);
    this.deregisterTab(tab);
    await tab.browser.handle.closeTabTarget(tab.targetId);
    return { closed: { tab_id: tab.tabId } };
  }

  deregisterTab(tab) {
    tab.closed = true;
    if (tab.offEventRouting) { try { tab.offEventRouting(); } catch {} }
    this.tabs.delete(tab.tabId);
    tab.browser.tabs.delete(tab.tabId);
    if (this.activeTabId === tab.tabId) {
      // Newest remaining tab becomes active (ZCode: scope-selected tab).
      this.activeTabId = this.tabs.size ? [...this.tabs.keys()].pop() : null;
    }
  }

  /**
   * Input context whose sends are dialog-aware: a click that opens
   * alert/confirm/prompt makes CDP's Input.dispatch* block until the dialog
   * is answered. Race every send against the dialog event, and never queue
   * further input behind an open dialog (it would land after the answer).
   */
  ctx(tab, session) {
    const conn = tab.browser.handle.conn;
    return {
      sessionId: session ?? tab.sessionId,
      conn: { send: (method, params, sid) => (tab.dialog ? Promise.resolve({ skipped: "dialog_open" }) : this.raceDialog(tab, conn.send(method, params, sid))) },
    };
  }

  raceDialog(tab, promise) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, v) => { if (done) return; done = true; clearInterval(iv); fn(v); };
      const iv = setInterval(() => { if (tab.dialog) { promise.catch(() => {}); finish(resolve, { dialog_opened: true }); } }, 20);
      promise.then((v) => finish(resolve, v), (e) => finish(reject, e));
    });
  }

  dialogNote(tab) {
    return {
      dialog: tab.dialog,
      hint: `The action opened a JS ${tab.dialog.type} dialog — the page is frozen until you answer it with ax_dialog (answer: accept|dismiss${tab.dialog.type === "prompt" ? ", prompt_text" : ""}).`,
    };
  }

  /**
   * Side-effect accounting (ZCode's actionSent): a CDP timeout after dispatch
   * means the input MAY have landed — report `possibly_sent`, not a clean no.
   */
  async doSent(tab, fn) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof AxError && (e.code === Codes.TIMEOUT || e.code === Codes.ATTACH_FAILED)) {
        throw new AxError(e.code, e.message, { ...e, sideEffect: "uncertain" });
      }
      throw e;
    }
  }

  async dispose() {
    this.disposing = true;
    this.stopAmbient();
    if (this.reaperTimer) { clearInterval(this.reaperTimer); this.reaperTimer = null; }
    const all = [...this.browsers.values()];
    this.browsers.clear();
    this.browserIndex?.clear();
    this.tabs.clear();
    this.activeTabId = null;
    await Promise.all(all.map((b) => Promise.resolve(b.handle.dispose()).catch(() => {})));
  }
}

// Re-export for the MCP layer.
export { MOD };
