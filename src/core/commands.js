/**
 * axuse — the frozen command contract.
 *
 * Lineage: ZCode's `packages/shared/src/browser-use/commands.ts` — a single
 * discriminated union every backend accepts, so the model-facing surface,
 * validation and docs can never drift apart. Here the same contract object
 * also *generates* the MCP tool schemas, so the tool list the model sees is
 * literally derived from what the controller executes.
 *
 * "observed" values:
 *   "full"  — command returns a FULL observation (navigations, open)
 *   "diff"  — command returns a DIFF against the last observation (actions)
 *   "none"  — command returns its own payload (screenshots, evaluate, ...)
 */

// Shared param specs: identical wording everywhere, and short — the tool
// list rides along in the model's context on EVERY turn.
const TAB = { t: "string", desc: "Tab id from ax_open. Required once more than one tab is controlled (tabs are shared by every caller of this server)." };
const STATE = { t: "number", desc: "state_id the ref came from (rejects stale refs)." };
const SETTLE = { t: "number", desc: "Settle ms before the diff (default 150)." };
const TARGET = { t: "target", req: true, desc: '{ref:"e7"} from the latest observation, or {x,y} viewport CSS px = ax_screenshot pixels (last resort).' };

export const Contract = Object.freeze({
  open: {
    group: "browser",
    title: "Open a controlled browser tab",
    desc: "Open a URL in a new tab. Backend default: the user's own signed-in Chrome when the axuse extension is connected, else a separate CDP-launched browser (the result says which). Returns the FULL accessibility snapshot: one line per element, actionable ones with [ref=eN]. cdp_url attaches to a running Chrome. Keep the returned tab_id and pass it on every later call.",
    params: {
      url: { t: "string", req: true, desc: "http(s), file, about, data or blob URL." },
      headless: { t: "boolean", desc: "No window (cdp backend). On a display-less Linux server axuse auto-boots a virtual display and stays headed (anti-bot-safe) — keep headless off for challenge pages; use it only for trusted internal pages." },
      proxy: { t: "string", desc: 'Route this browser through a proxy: "http://host:port", "socks5://user:pass@host:port" (per-launch, credentials answered over CDP; loopback bypassed by default; AXUSE_PROXY otherwise).' },
      proxy_bypass: { t: "string", desc: 'Chrome proxy bypass list (advanced), e.g. "<-loopback>" to include localhost.' },
      timezone: { t: "string", desc: 'Per-instance IANA persona zone (e.g. "America/New_York") — Date/Intl in pages and workers; overrides AXUSE_TIMEZONE for this browser (one coherent persona per exit).' },
      lang: { t: "string", desc: 'Per-instance persona language (e.g. "en-GB") — navigator.languages + Accept-Language + Intl; overrides AXUSE_LANG for this browser.' },
      cdp_url: { t: "string", desc: 'Attach instead of launching, e.g. "http://127.0.0.1:9222".' },
      backend: { t: "enum", values: ["cdp", "extension"], desc: "Omit for auto (extension when connected, else cdp; AXUSE_BACKEND pins it). cdp = separate, not-signed-in browser." },
      executable_path: { t: "string", desc: "Browser binary (default: auto-detect)." },
      profile_dir: { t: "string", desc: "Persistent user-data-dir to reuse an aged profile (e.g. a session-vault profile). A persistent profile is never deleted on close." },
      settle_ms: { t: "number", desc: "Settle ms before observing (default 300)." },
    },
    observed: "full",
  },

  open_many: {
    group: "browser",
    title: "Open multiple URLs",
    desc: "Open a bounded list of URLs sequentially and return compact page results. Tabs are closed after each URL by default, so this is safe for source lists and batch inspection. Use ax_open for interactive work on one page.",
    params: {
      urls: { t: "urls", req: true, desc: "Non-empty list of http(s), file, about, data or blob URLs (maximum 100)." },
      headless: { t: "boolean", desc: "No window (cdp backend; display-less Linux servers auto-boot a virtual display instead)." },
      cdp_url: { t: "string", desc: 'Attach instead of launching, e.g. "http://127.0.0.1:9222".' },
      backend: { t: "enum", values: ["cdp", "extension"], desc: "Omit for auto (extension when connected, else cdp; AXUSE_BACKEND pins it). cdp = separate, not-signed-in browser." },
      executable_path: { t: "string", desc: "Browser binary (default: auto-detect)." },
      proxy: { t: "string", desc: 'Route this batch through a proxy: "http://host:port", "socks5://user:pass@host:port" — one coherent persona for the whole list (credentials answered over CDP; WebRTC leak fix applied).' },
      proxy_bypass: { t: "string", desc: 'Chrome proxy bypass list (advanced), e.g. "<-loopback>" to include localhost.' },
      timezone: { t: "string", desc: "Per-instance persona zone (IANA) for this batch — the clock matches the exit." },
      lang: { t: "string", desc: "Per-instance persona language for this batch — navigator.languages + Accept-Language + Intl match the exit." },
      settle_ms: { t: "number", desc: "Settle ms per URL (default 300)." },
      close_after: { t: "boolean", desc: "Close each axuse-created tab after observing it (default true)." },
      excerpt_chars: { t: "number", desc: "Maximum accessibility-text excerpt per URL (default 1600, max 20000)." },
    },
    observed: "none",
  },

  navigate: {
    group: "browser",
    title: "Navigate the current tab to a URL",
    desc: "Load a URL in the tab; returns a FULL snapshot (old refs die).",
    params: { url: { t: "string", req: true, desc: "Target URL." }, tab_id: TAB, settle_ms: { t: "number", desc: "Default 300." } },
    observed: "full",
  },

  go: {
    group: "browser",
    title: "Go back / forward in history",
    desc: "History back (delta −1, default) or forward (+1); returns a FULL snapshot.",
    params: { delta: { t: "number", desc: "Steps (default −1)." }, tab_id: TAB },
    observed: "full",
  },

  tabs: {
    group: "browser",
    title: "List controlled tabs",
    desc: "Controlled tabs: tab_id, url, title, state_id, open dialog. Popups opened by the page are adopted automatically.",
    params: {},
    observed: "none",
  },

  observe: {
    group: "browser",
    title: "Observe a tab (accessibility snapshot; diff by default)",
    desc: "Accessibility snapshot. mode=diff (default): only what changed since the last observation (unchanged refs stay valid); mode=full: whole page. find=\"text\": only matching lines (+context, refs) from the whole page — cheapest way to locate a row/item on big pages. mode=text: the page's full readable text (no refs) for long articles that a snapshot truncates. Actions already return a diff, so you rarely need this.",
    params: {
      tab_id: TAB,
      mode: { t: "enum", values: ["diff", "full", "text"], desc: "diff (default), full, or text (readable text only)." },
      find: { t: "string", desc: "Return only lines containing this text (case-insensitive)." },
      max_nodes: { t: "number", desc: "Element budget (default 300, max 2000)." },
      max_chars: { t: "number", desc: "Char budget (default 24000; text mode 100000; max 200000)." },
    },
    observed: "none",
  },

  click: {
    group: "browser",
    title: "Click (trusted input)",
    desc: "Trusted click on a ref (or {x,y}). Returns the diff; a JS dialog or a new tab it opens is reported in the result.",
    params: {
      target: TARGET,
      button: { t: "enum", values: ["left", "middle", "right"], desc: "Default left." },
      count: { t: "number", desc: "2 = double click." },
      modifiers: { t: "enum", values: ["alt", "ctrl", "meta", "shift"], multi: true, desc: "Held modifiers." },
      human: { t: "boolean", desc: "Human mouse approach first (jittered curved trajectory, overshoot, dwell) — use for challenge widgets and pointer-dynamics-sensitive targets." },
      state_id: STATE, tab_id: TAB, settle_ms: SETTLE,
    },
    observed: "diff",
  },

  fill: {
    group: "browser",
    title: "Fill a form in one call",
    desc: "Set many fields in ONE call, optionally clicking submit after; returns one diff. value: string for text inputs/textareas/editors, <select>s, dropdown buttons and autocomplete comboboxes (types, then picks the exact suggestion); true/false for checkboxes, radios, switches; number for ARIA/native sliders (trusted Arrow key presses, converges and reports the step). Stops at the first failing field and says which.",
    params: {
      fields: { t: "fields", req: true, desc: '[{"ref":"e3","value":"Ada"},{"ref":"e6","value":true}]' },
      submit: { t: "string", desc: "Ref to click after filling." },
      human: { t: "boolean", desc: "Human input lane for text fields: human focus clicks + per-key trusted typing with human cadence — for login/credential forms on pages where keystroke dynamics are sampled; default is fast bulk insert." },
      state_id: STATE, tab_id: TAB, settle_ms: { t: "number", desc: "Default 200." },
    },
    observed: "diff",
  },

  upload: {
    group: "browser",
    title: "Upload local files",
    desc: "Set local file(s) on a file input (ref of the <input type=file>, or omit ref right after a click opened a file chooser). Absolute paths. Returns the diff.",
    params: {
      ref: { t: "string", desc: "Ref of the file input (optional if a file chooser is pending)." },
      paths: { t: "paths", req: true, desc: 'Absolute local paths, e.g. ["C:/Users/me/a.png"].' },
      tab_id: TAB, settle_ms: SETTLE,
    },
    observed: "diff",
  },

  hover: {
    group: "browser",
    title: "Hover (trusted input)",
    desc: "Move the mouse over a ref (opens hover menus/tooltips). Returns the diff.",
    params: { target: TARGET, state_id: STATE, tab_id: TAB, settle_ms: SETTLE },
    observed: "diff",
  },

  type: {
    group: "browser",
    title: "Type text (trusted input)",
    desc: "Click the target, then type (trusted). Replaces existing content by default; submit=true presses Enter. Works on inputs and contenteditable editors. Returns the diff.",
    params: {
      target: { t: "target", desc: "{ref} of the field (omit: focused element)." },
      text: { t: "string", req: true, desc: "Text to type." },
      replace: { t: "boolean", desc: "Replace content (default true)." },
      submit: { t: "boolean", desc: "Press Enter after." },
      human: { t: "boolean", desc: "Per-key trusted events with human cadence (keydown→hold→keyup per char, 45–160 ms gaps, thinking pauses) — for challenge/login fields where keystroke dynamics are sampled; default is fast bulk insert." },
      state_id: STATE, tab_id: TAB, settle_ms: SETTLE,
    },
    observed: "diff",
  },

  press: {
    group: "browser",
    title: "Press a key or combo (trusted input)",
    desc: 'Key combo, e.g. "enter", "escape", "ctrl+a", "shift+tab". platform:true translates a Windows-convention application shortcut to this OS\'s convention (macOS: ctrl→cmd, e.g. ctrl+alt+1→cmd+alt+1 for headings, ctrl+end→cmd+end). Use it for app shortcuts (bold, headings, caret-to-end); leave it off for combos that must be literal Control (terminals, browser devtools). Returns the diff.',
    params: {
      combo: { t: "string", req: true, desc: "Key combo." },
      platform: { t: "boolean", desc: "Translate ctrl-based app shortcuts to the platform convention (macOS: cmd)." },
      tab_id: TAB, settle_ms: SETTLE,
    },
    observed: "diff",
  },

  scroll: {
    group: "browser",
    title: "Scroll (trusted input)",
    desc: "Wheel scroll by direction+amount (pages) or dx/dy, anchored at target. until=\"text\": keeps scrolling in ONE call until that text is on the page (infinite feeds, lazy lists) or the page ends, and returns only the matching lines with refs.",
    params: {
      direction: { t: "enum", values: ["up", "down", "left", "right"], desc: "Direction." },
      amount: { t: "number", desc: "Pages (default 1)." },
      dx: { t: "number", desc: "Raw px." },
      dy: { t: "number", desc: "Raw px." },
      until: { t: "string", desc: "Scroll until this text appears (case-insensitive)." },
      target: { t: "target", desc: "Anchor {ref} or {x,y}." },
      tab_id: TAB, settle_ms: SETTLE,
    },
    observed: "diff",
  },

  select: {
    group: "browser",
    title: "Select an option (combobox)",
    desc: "Set a native <select> by option value or text. (Custom dropdowns: use ax_fill.) Returns the diff.",
    params: {
      ref: { t: "string", req: true, desc: "Ref of the <select>." },
      value: { t: "string", req: true, desc: "Option value or text." },
      state_id: STATE, tab_id: TAB, settle_ms: SETTLE,
    },
    observed: "diff",
  },

  drag: {
    group: "browser",
    title: "Drag (trusted input)",
    desc: "Drag from one ref/point to another (trusted pointer moves). Returns the diff.",
    params: {
      from: { t: "target", req: true, desc: "{ref} or {x,y}." },
      to: { t: "target", req: true, desc: "{ref} or {x,y}." },
      steps: { t: "number", desc: "Move steps (default 12)." },
      tab_id: TAB, settle_ms: SETTLE,
    },
    observed: "diff",
  },

  screenshot: {
    group: "browser",
    title: "Screenshot (budgeted, one raster)",
    desc: "JPEG of the viewport (or crop {x,y,w,h}), byte-budgeted. 1 image px = 1 viewport CSS px = the {x,y} ax_click takes. Only when pixels matter (canvas, visual checks).",
    params: {
      tab_id: TAB,
      crop: { t: "rect", desc: "{x,y,w,h} viewport region." },
      budget_bytes: { t: "number", desc: "Default 200000." },
      quality: { t: "number", desc: "JPEG 1-100 (default 80)." },
    },
    observed: "none",
  },

  element_info: {
    group: "browser",
    title: "Element info at a point (vision↔structure bridge)",
    desc: "What is at viewport point (x,y) (screenshot pixels): tag, role, name, rect and its ref.",
    params: { x: { t: "number", req: true, desc: "Viewport X." }, y: { t: "number", req: true, desc: "Viewport Y." }, tab_id: TAB },
    observed: "none",
  },

  evaluate: {
    group: "browser",
    title: "Evaluate JavaScript in the page",
    desc: "Escape hatch: run a JS expression in the page (await ok); JSON result, 64KB cap.",
    params: { expression: { t: "string", req: true, desc: "JS expression or (async) IIFE." }, tab_id: TAB },
    observed: "none",
  },

  wait_for: {
    group: "browser",
    title: "Wait for a condition (bounded, in-page)",
    desc: "One bounded in-page wait for a CSS selector or a truthy JS expression (default 3s, max 25s). Use for slow async UI instead of polling.",
    params: {
      selector: { t: "string", desc: "CSS selector (visible)." },
      expression: { t: "string", desc: "JS expression." },
      text: { t: "string", desc: "Wait until this text is on the page." },
      timeout_ms: { t: "number", desc: "Default 3000, max 25000." },
      tab_id: TAB,
    },
    observed: "none",
  },

  events: {
    group: "browser",
    title: "CDP/page events since a cursor",
    desc: "Sequenced event log (navigations, dialogs, console errors, tabs opened). Poll with after_sequence.",
    params: {
      after_sequence: { t: "number", desc: "Only events after this (default 0)." },
      limit: { t: "number", desc: "Max events (default 50)." },
      tab_id: TAB,
    },
    observed: "none",
  },

  dialog: {
    group: "browser",
    title: "Read or answer a JS dialog",
    desc: "Answer an open alert/confirm/prompt (accept|dismiss, prompt_text for prompts), or read it (no answer). Pages are frozen while one is open.",
    params: {
      answer: { t: "enum", values: ["accept", "dismiss"], desc: "Omit to just read." },
      prompt_text: { t: "string", desc: "Text for a prompt()." },
      tab_id: TAB,
    },
    observed: "diff",
  },

  close: {
    group: "browser",
    title: "Close tabs / browsers",
    desc: "Close a tab (default active), or browser:true to close every controlled browser.",
    params: { tab_id: TAB, browser: { t: "boolean", desc: "Close all browsers." } },
    observed: "none",
  },
});

import { AxError, Codes } from "./errors.js";

const TYPE_NAMES = new Set(["string", "boolean", "number", "enum", "target", "rect", "fields", "paths", "urls", "any"]);

/**
 * Validate args against a contract entry. Returns a shallow-coerced copy.
 * Throws AxError(COMMAND_REJECTED) — always recoverable by fixing the call.
 */
export function validate(name, args) {
  const entry = Contract[name];
  if (!entry) throw new AxError(Codes.COMMAND_REJECTED, `Unknown command "${name}"`, { retry: "never" });
  const out = {};
  const src = args ?? {};
  const problems = [];
  for (const [key, spec] of Object.entries(entry.params)) {
    if (!TYPE_NAMES.has(spec.t)) problems.push(`internal: bad param type for ${key}`);
    const v = src[key];
    const present = v !== undefined && v !== null;
    if (!present) {
      if (spec.req) problems.push(`${key} is required`);
      continue;
    }
    switch (spec.t) {
      case "string":
        if (typeof v !== "string") { problems.push(`${key} must be a string`); continue; }
        break;
      case "boolean":
        if (typeof v !== "boolean") { problems.push(`${key} must be a boolean`); continue; }
        break;
      case "number":
        if (typeof v !== "number" || !Number.isFinite(v)) { problems.push(`${key} must be a number`); continue; }
        break;
      case "enum":
        if (spec.multi) {
          if (!Array.isArray(v) || v.some((x) => !spec.values.includes(x))) { problems.push(`${key} must be an array of: ${spec.values.join("|")}`); continue; }
        } else if (!spec.values.includes(v)) { problems.push(`${key} must be one of: ${spec.values.join("|")}`); continue; }
        break;
      case "target":
        if (typeof v !== "object") { problems.push(`${key} must be {ref} or {x,y}`); continue; }
        if (v.ref !== undefined) {
          if (typeof v.ref !== "string") { problems.push(`${key}.ref must be a string`); continue; }
        } else if (Number.isFinite(v.x) && Number.isFinite(v.y)) {
          out[key] = { x: v.x, y: v.y };
          continue;
        } else { problems.push(`${key} must be {ref:"eN"} or {x,y}`); continue; }
        break;
      case "rect":
        if (typeof v !== "object" || !["x", "y", "w", "h"].every((k) => Number.isFinite(v[k]))) { problems.push(`${key} must be {x,y,w,h} numbers`); continue; }
        break;
      case "fields":
        if (!Array.isArray(v) || !v.length || v.some((f) => !f || typeof f.ref !== "string" || !["string", "boolean", "number"].includes(typeof f.value))) {
          problems.push(`${key} must be a non-empty array of {ref:string, value:string|boolean}`); continue;
        }
        break;
      case "paths":
        if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== "string" || !x)) { problems.push(`${key} must be a non-empty array of paths`); continue; }
        break;
      case "urls":
        if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== "string" || !x)) {
          problems.push(`${key} must be a non-empty array of URLs`); continue;
        }
        break;
      case "any":
        break;
    }
    out[key] = v;
  }
  if (problems.length) {
    throw new AxError(Codes.COMMAND_REJECTED, `${name}: ${problems.join("; ")}`, { retry: "never" });
  }
  return out;
}
