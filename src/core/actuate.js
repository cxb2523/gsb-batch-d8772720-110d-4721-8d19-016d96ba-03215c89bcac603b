/**
 * axuse — actuator: trusted input synthesis + live ref resolution over CDP.
 *
 * Lineage: Codex acts through chrome.debugger → Input.dispatch* (isTrusted
 * events — many sites reject synthetic DOM events) and resolves element
 * targets live at action time instead of trusting remembered coordinates.
 * ZCode contributes the error vocabulary (ELEMENT_HIDDEN, STALE_STATE,
 * actionSent) and the rule "coordinates are the last resort".
 */

import { AxError, Codes } from "./errors.js";

/** CDP modifier bitmasks. */
export const MOD = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

/** macOS virtual key codes used by Chromium's native event builder. */
const MAC_NATIVE_KEY_CODES = Object.freeze({
  Enter: 36, Tab: 48, Escape: 53, Backspace: 51, Delete: 117, Space: 49,
  ArrowUp: 126, ArrowDown: 125, ArrowLeft: 123, ArrowRight: 124,
  Home: 115, End: 119, PageUp: 116, PageDown: 121, Insert: 114, Help: 114,
  F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97,
  F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111,
  // Function row beyond F12 (HIToolbox Events.h).
  F13: 105, F14: 107, F15: 113, F16: 106, F17: 64, F18: 79, F19: 80, F20: 90,
  ControlLeft: 59, ShiftLeft: 56, AltLeft: 58, MetaLeft: 55,
  CapsLock: 57, ContextMenu: 110, Fn: 63,
  KeyA: 0, KeyB: 11, KeyC: 8, KeyD: 2, KeyE: 14, KeyF: 3, KeyG: 5,
  KeyH: 4, KeyI: 34, KeyJ: 38, KeyK: 40, KeyL: 37, KeyM: 46, KeyN: 45,
  KeyO: 31, KeyP: 35, KeyQ: 12, KeyR: 15, KeyS: 1, KeyT: 17, KeyU: 32,
  KeyV: 9, KeyW: 13, KeyX: 7, KeyY: 16, KeyZ: 6,
  Digit0: 29, Digit1: 18, Digit2: 19, Digit3: 20, Digit4: 21,
  Digit5: 23, Digit6: 22, Digit7: 26, Digit8: 28, Digit9: 25,
  // Punctuation row (US layout physical codes — layout-independent).
  Backquote: 50, Minus: 27, Equal: 24, BracketLeft: 33, BracketRight: 30,
  Backslash: 42, Semicolon: 41, Quote: 39, Comma: 43, Period: 47, Slash: 44,
  // Numeric keypad.
  Numpad0: 82, Numpad1: 83, Numpad2: 84, Numpad3: 85, Numpad4: 86,
  Numpad5: 87, Numpad6: 88, Numpad7: 89, Numpad8: 91, Numpad9: 92,
  NumpadEnter: 76, NumpadAdd: 69, NumpadSubtract: 78, NumpadMultiply: 67,
  NumpadDivide: 75, NumpadDecimal: 65, NumpadEqual: 81, NumLock: 71,
});

/** Keyboard descriptors: name → {vk, key, code, text}. */
export const KEYS = {
  enter: { vk: 13, key: "Enter", code: "Enter", text: "\r" },
  tab: { vk: 9, key: "Tab", code: "Tab" },
  escape: { vk: 27, key: "Escape", code: "Escape" },
  esc: { vk: 27, key: "Escape", code: "Escape" },
  backspace: { vk: 8, key: "Backspace", code: "Backspace" },
  delete: { vk: 46, key: "Delete", code: "Delete" },
  del: { vk: 46, key: "Delete", code: "Delete" },
  up: { vk: 38, key: "ArrowUp", code: "ArrowUp" },
  down: { vk: 40, key: "ArrowDown", code: "ArrowDown" },
  left: { vk: 37, key: "ArrowLeft", code: "ArrowLeft" },
  right: { vk: 39, key: "ArrowRight", code: "ArrowRight" },
  home: { vk: 36, key: "Home", code: "Home" },
  end: { vk: 35, key: "End", code: "End" },
  pageup: { vk: 33, key: "PageUp", code: "PageUp" },
  pagedown: { vk: 34, key: "PageDown", code: "PageDown" },
  space: { vk: 32, key: " ", code: "Space", text: " " },
  ctrl: { vk: 0x11, key: "Control", code: "ControlLeft" },
  control: { vk: 0x11, key: "Control", code: "ControlLeft" },
  shift: { vk: 0x10, key: "Shift", code: "ShiftLeft" },
  alt: { vk: 0x12, key: "Alt", code: "AltLeft" },
  meta: { vk: 0x5b, key: "Meta", code: "MetaLeft" },
  cmd: { vk: 0x5b, key: "Meta", code: "MetaLeft" },
  command: { vk: 0x5b, key: "Meta", code: "MetaLeft" },
};
for (let i = 1; i <= 12; i++) {
  KEYS["f" + i] = { vk: 0x70 + (i - 1), key: "F" + i, code: "F" + i };
}
for (let i = 0; i < 26; i++) {
  const ch = String.fromCharCode(97 + i);
  KEYS[ch] = {
    vk: 65 + i,
    key: ch.toUpperCase(),
    code: "Key" + ch.toUpperCase(),
    text: ch,
  };
}
for (let i = 0; i < 10; i++) {
  KEYS[String(i)] = { vk: 48 + i, key: String(i), code: "Digit" + i, text: String(i) };
}

/** Parse a combo like "ctrl+shift+p" → {mods: ["ctrl","shift"], main: {…}} */
export function parseCombo(combo) {
  const parts = String(combo).toLowerCase().split("+").map((s) => s.trim()).filter(Boolean);
  const mods = [];
  let main = null;
  for (const p of parts) {
    if (MOD[p]) mods.push(p);
    else if (main) throw new AxError(Codes.COMMAND_REJECTED, `Combo has two non-modifier keys: "${combo}"`);
    else main = KEYS[p];
  }
  if (!main) throw new AxError(Codes.COMMAND_REJECTED, `Unknown key in combo "${combo}"`);
  return { mods, main };
}

/** @param {{conn: import("./cdp.js").CdpConnection, sessionId: string}} ctx */
function keyEvent(ctx, type, k, modifiers, withText, command) {
  const params = {
    type,
    key: k.key,
    code: k.code,
    windowsVirtualKeyCode: k.vk,
    // Chromium's Mac input path expects a native macOS key code when it is
    // provided; Windows VK values are not Mac key codes.
    nativeVirtualKeyCode: process.platform === "darwin" ? (MAC_NATIVE_KEY_CODES[k.code] ?? 0) : k.vk,
    modifiers,
  };
  if (withText && k.text) params.text = k.text;
  if (command) params.commands = [command];
  return ctx.conn.send("Input.dispatchKeyEvent", params, ctx.sessionId);
}

function macEditingCommand(main, mask) {
  if (process.platform !== "darwin" || !(mask & MOD.meta)) return null;
  if (main.code === "KeyA") return "selectAll";
  if (main.code === "KeyC") return "copy";
  if (main.code === "KeyX") return "cut";
  if (main.code === "KeyV") return "paste";
  if (main.code === "KeyZ") return mask & MOD.shift ? "redo" : "undo";
  return null;
}

/** Press a key combo. Text is sent for single printable keys only. */
export async function pressCombo(ctx, combo) {
  const { mods, main } = parseCombo(combo);
  const mask = mods.reduce((m, x) => m | MOD[x], 0);
  for (const m of mods) await keyEvent(ctx, "keyDown", KEYS[m], mask, false);
  const command = macEditingCommand(main, mask);
  await keyEvent(ctx, "keyDown", main, mask, mods.length === 0, command);
  await keyEvent(ctx, "keyUp", main, mask, false);
  for (let i = mods.length - 1; i >= 0; i--) await keyEvent(ctx, "keyUp", KEYS[mods[i]], mask, false);
}

const BUTTON_MAP = { left: "left", middle: "middle", right: "right", 1: "left", 2: "middle", 3: "right" };

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/* --------------------------------------------------- human input realism */

/** Key descriptor for one printable character: known layout codes when the
 *  key exists on a US layout (letters, digits, space), a plain text-bearing
 *  key event otherwise (e.code "" is what IME/dead-key input reports too). */
function charKey(ch) {
  const known = KEYS[ch];
  if (known && known.text === ch) return known;
  return { vk: 0, key: ch, code: "", text: ch };
}

/** Human keystroke plan: per-char { …key, delayMs (approach gap), holdMs
 *  (down→up) }. The shape keystroke-dynamics systems sample: mostly
 *  45–160 ms gaps, a few thinking pauses (6%), slightly longer word
 *  boundaries and 25–90 ms holds. Pure — injectable randomness for tests. */
export function planHumanKeystrokes(text, { random = Math.random } = {}) {
  const chars = [...String(text)];
  return chars.map((ch, i) => {
    const wordBoundary = i > 0 && chars[i - 1] === " ";
    const thinking = random() < 0.06;
    const base = 45 + random() * 115;
    const delayMs = thinking
      ? 180 + random() * 270
      : Math.round(base + (wordBoundary ? 20 + random() * 40 : 0));
    return { ...charKey(ch), delayMs: i === 0 ? Math.round(base / 2) : delayMs, holdMs: Math.round(25 + random() * 65) };
  });
}

/** Per-key trusted typing (keydown→hold→keyup per char, human cadence).
 *  The default type path stays bulk insertText (fast, agent-productivity);
 *  this is the lane for challenge/login fields where keystroke dynamics
 *  are sampled (DataDome-class). */
export async function humanType(ctx, text, { random = Math.random } = {}) {
  for (const k of planHumanKeystrokes(text, { random })) {
    await sleep(k.delayMs);
    await keyEvent(ctx, "keyDown", k, 0, true);
    await sleep(k.holdMs);
    await keyEvent(ctx, "keyUp", k, 0, false);
  }
}

/** Human mouse approach before a click: a jittered quadratic curve from a
 *  random offset (40–130 px away), 3–6 eased moves over 120–320 ms, a
 *  1–3 px overshoot-and-settle and a short dwell — the trajectory shape
 *  pointer-dynamics systems expect to see BEFORE a press. Pure planner. */
export function planHumanApproach({ x, y }, { random = Math.random } = {}) {
  const angle = random() * Math.PI * 2;
  const dist = 40 + random() * 90;
  const sx = x + Math.cos(angle) * dist;
  const sy = y + Math.sin(angle) * dist;
  const steps = 3 + Math.floor(random() * 4); // 3–6 moves
  // Control point: mid-point pushed perpendicular — a curved, not laser-straight path.
  const mx = (sx + x) / 2, my = (sy + y) / 2;
  const nx = -(y - sy), ny = x - sx;
  const nlen = Math.hypot(nx, ny) || 1;
  const bend = (random() - 0.5) * 2 * (dist * 0.35);
  const cx = mx + (nx / nlen) * bend, cy = my + (ny / nlen) * bend;
  // Overshoot 1–3 px past the target on the incoming direction, then settle.
  const olen = 1 + random() * 2;
  const ox = x + ((x - cx) / (Math.hypot(x - cx, y - cy) || 1)) * olen;
  const oy = y + ((y - cy) / (Math.hypot(x - cx, y - cy) || 1)) * olen;
  const totalMs = 120 + random() * 200;
  const events = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = 1 - (1 - t) * (1 - t); // ease-out
    const px = (1 - ease) * (1 - ease) * sx + 2 * (1 - ease) * ease * cx + ease * ease * x;
    const py = (1 - ease) * (1 - ease) * sy + 2 * (1 - ease) * ease * cy + ease * ease * y;
    events.push({ x: Math.round(px), y: Math.round(py), dtMs: Math.round((totalMs / steps) * (0.7 + random() * 0.6)) });
  }
  events.push({ x: Math.round(ox), y: Math.round(oy), dtMs: 40 + Math.round(random() * 50) }); // overshoot
  events.push({ x: Math.round(x), y: Math.round(y), dtMs: 30 + Math.round(random() * 40) });   // settle
  return { events, dwellMs: 40 + Math.round(random() * 90), from: { x: Math.round(sx), y: Math.round(sy) } };
}

/** Dispatch a trusted click. `human` adds the approach trajectory first —
 *  for challenge widgets (Turnstile checkbox, puzzle tiles) and other
 *  pointer-dynamics-sensitive targets. */
export async function click(ctx, { x, y, button = "left", count = 1, modifiers = 0, human = false }) {
  const b = BUTTON_MAP[button];
  if (!b) throw new AxError(Codes.COMMAND_REJECTED, `button must be left|middle|right, got "${button}"`);
  if (human) {
    const plan = planHumanApproach({ x, y });
    for (const e of plan.events) {
      await sleep(e.dtMs);
      await ctx.conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: e.x, y: e.y, button: "none", modifiers }, ctx.sessionId);
    }
    await sleep(plan.dwellMs);
  } else {
    await ctx.conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", modifiers }, ctx.sessionId);
  }
  const base = { x, y, button: b, clickCount: count, modifiers };
  await ctx.conn.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base }, ctx.sessionId);
  await ctx.conn.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base }, ctx.sessionId);
}

/** Pointer park-fuzz: the idle "hand tremor" a real pointer shows between
 *  actions — micro-jitter around the anchor (±1–3 px), a rare 8–20 px
 *  excursion. Agent loops freeze for seconds between tool calls; a pointer
 *  that NEVER moves between bursts is a correlation signal on
 *  protected pages. Pure planner. */
export function planPointerJitter(anchor, { random = Math.random } = {}) {
  const excursion = random() < 0.08;
  const r = excursion ? 8 + random() * 12 : 1 + random() * 2.5;
  const a = random() * Math.PI * 2;
  return {
    x: Math.round(anchor.x + Math.cos(a) * r),
    y: Math.round(anchor.y + Math.sin(a) * r),
    nextInMs: Math.round(1400 + random() * 2800),
  };
}

export async function hover(ctx, { x, y }) {
  await ctx.conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", modifiers: 0 }, ctx.sessionId);
}

export async function drag(ctx, from, to, steps = 12) {
  await hover(ctx, from);
  await ctx.conn.send("Input.dispatchMouseEvent", { type: "mousePressed", ...from, button: "left", clickCount: 1, modifiers: 0 }, ctx.sessionId);
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await ctx.conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", modifiers: 0 }, ctx.sessionId);
  }
  await ctx.conn.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1, modifiers: 0 }, ctx.sessionId);
}

export async function wheel(ctx, { x, y, dx = 0, dy = 0 }) {
  await ctx.conn.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, button: "none", deltaX: dx, deltaY: dy, modifiers: 0 }, ctx.sessionId);
}

/** Trusted bulk text entry (one CDP call, produces native input events). */
export async function insertText(ctx, text) {
  await ctx.conn.send("Input.insertText", { text: String(text) }, ctx.sessionId);
}

/** Select-all combo is platform-dependent (macOS uses Meta+A). */
export function selectAllCombo() {
  return process.platform === "darwin" ? "meta+a" : "ctrl+a";
}

/**
 * Translate a Windows-convention application shortcut to this platform's
 * convention. On macOS, application shortcuts (bold, heading, caret-to-end…)
 * are Cmd-based: a literal Control+Alt+1 dispatch never reaches the app's
 * accelerator table. Web apps that hard-code ctrlKey handlers still work —
 * callers only opt into translation for platform-convention shortcuts.
 */
export function platformShortcut(combo) {
  if (process.platform !== "darwin") return String(combo);
  return String(combo)
    .split("+")
    .map((part) => (part.trim().toLowerCase() === "ctrl" || part.trim().toLowerCase() === "control" ? "meta" : part))
    .join("+");
}

/**
 * Expression that resolves a ref to fresh coordinates at action time.
 * This is the Codex move: the layout may have moved since the observation;
 * scrolling happens here; covered/overlay state is reported, not guessed.
 *
 * Elements inside same-origin iframes live in the parent ref map (the walk
 * crosses contentDocument), but their rects are relative to the child
 * frame's viewport — coordinates are translated up through each hosting
 * iframe (+ borders) until they are main-viewport coordinates.
 */
export function refResolveExpression(ref) {
  return `(async function(){
    try {
      var el = (window.__axuseRefs || {})${indexExpr(ref)};
      if (!el) return { error: "no_ref" };
      if (!el.isConnected) return { error: "no_ref" };
      if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded(true);
      else el.scrollIntoView({ block: "center" });
      // Wait until the box is stable across animation frames: smooth/wheel
      // scroll animations and late layout shifts otherwise move the target
      // between measuring and clicking (the click lands on a neighbour).
      var raf = function(){ return new Promise(function(ok){ var t = setTimeout(ok, 50); requestAnimationFrame(function(){ clearTimeout(t); ok(); }); }); };
      var prev = el.getBoundingClientRect();
      for (var k = 0; k < 20; k++) {
        await raf();
        var cur = el.getBoundingClientRect();
        if (Math.abs(cur.top - prev.top) < 0.5 && Math.abs(cur.left - prev.left) < 0.5) break;
        prev = cur;
      }
      var r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return { error: "hidden" };
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      // Translate out of same-origin frame nesting: each host iframe's box
      // offsets the child viewport inside the parent viewport.
      var w = el.ownerDocument.defaultView;
      var hops = 0;
      while (w !== window && hops < 10) {
        hops++;
        var hosts = w.parent.document.querySelectorAll("iframe");
        var host = null;
        for (var i = 0; i < hosts.length; i++) {
          if (hosts[i].contentWindow === w) { host = hosts[i]; break; }
        }
        if (!host) return { error: "frame_host_not_found" };
        var hr = host.getBoundingClientRect();
        var hcs = window.getComputedStyle(host);
        cx += hr.left + (parseFloat(hcs.borderLeftWidth) || 0);
        cy += hr.top + (parseFloat(hcs.borderTopWidth) || 0);
        w = w.parent;
      }
      var hit = document.elementFromPoint(cx, cy);
      var covered = !(hit === el || (hit && el.contains(hit)));
      return { ok: true, x: cx, y: cy, w: r.width, h: r.height, covered: covered,
        hitTag: hit ? hit.tagName.toLowerCase() : null };
    } catch (e) { return { error: String(e) }; }
  })()`;
}

/** Set a <select> value + dispatch input/change (synthetic, React-safe). */
export function selectOptionExpression(ref, value) {
  return `(function(){
    try {
      var el = (window.__axuseRefs || {})${indexExpr(ref)};
      if (!el || el.tagName !== "SELECT") return { error: "no_ref" };
      var want = ${JSON.stringify(String(value))};
      var found = null;
      for (var i = 0; i < el.options.length; i++) {
        var o = el.options[i];
        if (o.value === want || o.text === want) { found = o; break; }
      }
      if (!found) return { error: "no_option", options: Array.prototype.map.call(el.options, function(o){ return o.value || o.text; }) };
      el.value = found.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, value: el.value };
    } catch (e) { return { error: String(e) }; }
  })()`;
}

/** Describe a ref'd element for form filling: control kind + boolean state. */
export function fieldKindExpression(ref) {
  return `(function(){
    try {
      var el = (window.__axuseRefs || {})${indexExpr(ref)};
      if (!el || !el.isConnected) return { error: "no_ref" };
      var tag = el.tagName, type = (el.getAttribute("type") || "").toLowerCase(), role = el.getAttribute("role") || "";
      if (tag === "SELECT") return { kind: "select" };
      if (tag === "INPUT" && (type === "checkbox" || type === "radio")) return { kind: "bool", on: !!el.checked };
      if (role === "switch" || role === "checkbox" || role === "radio" || role === "menuitemcheckbox") return { kind: "bool", on: el.getAttribute("aria-checked") === "true" };
      if ((role === "combobox" && (tag === "INPUT" || tag === "TEXTAREA")) || el.getAttribute("aria-autocomplete") === "list" || (tag === "INPUT" && el.getAttribute("list"))) return { kind: "combo" };
      if (role === "combobox" || el.getAttribute("aria-haspopup") === "listbox") return { kind: "popup" };
      if (role === "slider" || (tag === "INPUT" && type === "range")) {
        var num = function (v, dflt) { var n = parseFloat(v); return isFinite(n) ? n : dflt; };
        var native = tag === "INPUT" && type === "range";
        return {
          kind: "slider",
          min: native ? num(el.min, 0) : num(el.getAttribute("aria-valuemin"), 0),
          max: native ? num(el.max, 100) : num(el.getAttribute("aria-valuemax"), 100),
          now: native ? num(el.value, null) : num(el.getAttribute("aria-valuenow"), null),
          step: native ? (num(el.step, 1) || 1) : null,
        };
      }
      if (tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable) return { kind: "text" };
      return { kind: "other", tag: tag, role: role || null };
    } catch (e) { return { error: String(e) }; }
  })()`;
}

/** Read the live value of a ref'd slider — aria-valuenow for ARIA widgets
 *  (noUiSlider, ionRangeSlider, MUI…), .value for native range inputs. */
export function sliderValueExpression(ref) {
  return `(function(){
    try {
      var el = (window.__axuseRefs || {})${indexExpr(ref)};
      if (!el || !el.isConnected) return { error: "no_ref" };
      var tag = el.tagName, type = (el.getAttribute("type") || "").toLowerCase();
      var v = tag === "INPUT" && type === "range" ? el.value : el.getAttribute("aria-valuenow");
      var n = parseFloat(v);
      return isFinite(n) ? { now: n } : { error: "no_value" };
    } catch (e) { return { error: String(e) }; }
  })()`;
}

/** Find a visible option whose text matches (exact, then case-insensitive),
 *  bind it to a ref, return the ref. Searches shadow roots too. */
export function findOptionExpression(value) {
  return `(function(){
    var want = ${JSON.stringify(String(value))}.trim(), lw = want.toLowerCase();
    var all = [];
    (function walk(root){
      var els = root.querySelectorAll('[role=option],[role=menuitem],[role=menuitemradio],[role=treeitem],li');
      for (var i = 0; i < els.length; i++) all.push(els[i]);
      var hosts = root.querySelectorAll('*');
      for (var j = 0; j < hosts.length; j++) if (hosts[j].shadowRoot) walk(hosts[j].shadowRoot);
    })(document);
    var vis = all.filter(function(e){ var r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    var t = function(e){ return (e.innerText || e.textContent || "").replace(/\\s+/g, " ").trim(); };
    var hit = vis.find(function(e){ return t(e) === want; }) || vis.find(function(e){ return t(e).toLowerCase() === lw; });
    if (!hit) return { error: "no_option", visible: vis.slice(0, 15).map(t) };
    var refs = window.__axuseRefs || (window.__axuseRefs = {});
    var reg = window.__axuseRefRegistry;
    var ref = reg && reg.get(hit);
    if (!ref) { window.__axuseRefSeq = (window.__axuseRefSeq || 0) + 1; ref = "e" + window.__axuseRefSeq; if (reg) reg.set(hit, ref); }
    refs[ref] = hit;
    return { ok: true, ref: ref, text: t(hit) };
  })()`;
}

/** Hit-test an (x,y) and walk up to the nearest ref'd element (vision↔structure bridge). */
export function elementInfoExpression(x, y) {
  return `(function(){
    try {
      var el = document.elementFromPoint(${x}, ${y});
      if (!el) return { ok: false, reason: "nothing at point" };
      var ref = null;
      var m = window.__axuseRefs || {};
      for (var k in m) { var n = m[k]; if (n === el || n.contains(el)) { ref = k; el = n; break; } }
      var r = el.getBoundingClientRect();
      return { ok: true, ref: ref, tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") || "",
        name: (el.getAttribute("aria-label") || el.innerText || el.value || "").trim().slice(0, 120),
        rect: { x: r.left, y: r.top, w: r.width, h: r.height },
        actionable: !!ref };
    } catch (e) { return { error: String(e) }; }
  })()`;
}

/** Wait for the document to settle — a bounded in-page wait, not host polling. */
export function settleExpression(budgetMs, debounceMs) {
  return `(async () => {
    const t0 = Date.now();
    while (document.readyState !== "complete" && Date.now() - t0 < ${budgetMs}) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, ${debounceMs}));
    return document.readyState;
  })()`;
}

/** In-page wait for the FIRST DOM mutation (then a short quiet window), bounded
 *  by maxMs. Resolves true when the page changed, false when it stayed still.
 *  Attached after the action, so it only ever sees LATE changes (a delayed
 *  render, a debounced handler) — the case a 150 ms settle reports as "no
 *  change" while the page advances a moment later. */
export function mutationWaitExpression(maxMs, quietMs) {
  return `(async () => {
    const mo = new MutationObserver(() => { changed = true; last = Date.now(); });
    let changed = false, last = 0;
    mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    const t0 = Date.now();
    try {
      for (;;) {
        const now = Date.now();
        if (changed && now - last >= ${quietMs}) return true;
        if (now - t0 >= ${maxMs}) return changed;
        await new Promise((r) => setTimeout(r, 30));
      }
    } finally { mo.disconnect(); }
  })()`;
}

/** Bounded in-page wait-for: expression or selector, single round trip. */
export function waitForExpression(expression, timeoutMs) {
  return `(async () => {
    const t0 = Date.now();
    for (;;) {
      let v;
      try { v = await (${expression}); } catch (e) { return { ok: false, error: String(e) }; }
      if (v) return { ok: true, elapsed: Date.now() - t0 };
      if (Date.now() - t0 > ${timeoutMs}) return { ok: false, timeout: true, elapsed: Date.now() - t0 };
      await new Promise((r) => setTimeout(r, 80));
    }
  })()`;
}

function indexExpr(ref) {
  return `[${JSON.stringify(String(ref))}]`;
}
