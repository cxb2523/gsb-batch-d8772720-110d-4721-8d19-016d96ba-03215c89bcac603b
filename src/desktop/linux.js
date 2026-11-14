/**
 * axuse — Linux desktop driver over the zero-dependency X11 client.
 *
 * Lineage: Windows uses a resident PowerShell + SendInput driver and macOS
 * a JXA/CoreGraphics one; both shell out to the OS's scriptable surface.
 * Linux has no guaranteed scripting surface (xdotool/wmctrl are extra apt
 * packages), so this driver speaks X11 directly through src/desktop/x11.js
 * — same contract as the Windows driver (coordinate+vision mode):
 *
 *   - input: XTEST FakeInput (trusted, server-synthesized events — the X
 *     equivalent of SendInput), strictly ordered like the Windows driver
 *   - screenshots: GetImage (ZPixmap) → baseline JPEG (src/desktop/jpeg.js)
 *     with the same budget/quality retry contract as GDI+ on Windows
 *   - window list/activate: EWMH properties on the root window
 *     (_NET_CLIENT_LIST / _NET_WM_NAME / _NET_WM_PID / _NET_ACTIVE_WINDOW)
 *
 * No OS accessibility tree on X11 v1 (AT-SPI is a bus protocol out of scope
 * here) — the ax_* browser tools remain the structure-first surface, and
 * this driver is the fallback for native apps, exactly like Windows today.
 */
import { AxError, Codes } from "../core/errors.js";
import { KEYS, parseCombo } from "../core/actuate.js";
import { DEFAULT_BUDGET_BYTES } from "../core/screenshot.js";
import { X11Client, FakeEventType } from "./x11.js";
import { encodeJPEG } from "./jpeg.js";
import { spawn } from "node:child_process";

/** Shared KEYS-table names → X keysyms (Latin-1 + the standard ranges). */
const KEY_NAME_TO_KEYSYM = {
  enter: 0xff0d, tab: 0xff09, escape: 0xff1b, esc: 0xff1b,
  backspace: 0xff08, delete: 0xffff, del: 0xffff,
  up: 0xff52, down: 0xff54, left: 0xff51, right: 0xff53,
  home: 0xff50, end: 0xff57, pageup: 0xff55, pagedown: 0xff56,
  space: 0x20,
  ctrl: 0xffe3, control: 0xffe3, shift: 0xffe1, alt: 0xffe9,
  meta: 0xffeb, cmd: 0xffeb, command: 0xffeb,
};
for (let i = 1; i <= 12; i++) KEY_NAME_TO_KEYSYM["f" + i] = 0xffbe + (i - 1);

/** keysym for a KEYS-table name, or null. */
function keysymFor(name) {
  if (name.length === 1) {
    const c = name.charCodeAt(0);
    if ((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39)) return c; // a-z, 0-9
    if (c >= 0x21 && c <= 0xff) return c; // printable latin-1 punctuation etc.
  }
  return KEY_NAME_TO_KEYSYM[name] ?? null;
}

const BUTTON_DETAIL = { left: 1, middle: 2, right: 3 };

/** X11/EWMH driver. Ops are serialized (input ordering must never
 *  interleave — the same discipline as the resident Windows driver). */
export class LinuxDriver {
  /** @param {string} [display] @param {{atspiSessionBus?: string}} [opts] */
  constructor(display, opts = {}) {
    this.client = new X11Client(display);
    this.atspiSessionBus = opts.atspiSessionBus;
    this.chain = Promise.resolve();
  }

  /** Serialized op execution; the X11 connection opens lazily on first use. */
  op(fn) {
    const run = async () => {
      if (!this.client.connected) await this.client.connect();
      return fn(this.client);
    };
    this.chain = this.chain.then(run, run);
    return this.chain;
  }

  /* ------------------------------------------------------------- capture */

  async screenInfo() {
    return this.op(async (c) => {
      const g = await c.getGeometry(c.rootWindow);
      const monitors = await c.getMonitors();
      return {
        ok: true,
        x: 0,
        y: 0,
        w: g.w,
        h: g.h,
        coordinate_space: "X11 root window pixels (spans the monitors of the display's default screen)",
        note: "X11/XWayland driver (XTEST input, GetImage capture, EWMH windows)",
        ...(monitors.length ? { monitors } : {}),
      };
    });
  }

  /** GetImage → RGB rows honoring bpp/stride/byte-order. */
  async grabRGB(c, x, y, w, h) {
    const img = await c.getImage(x, y, w, h);
    const { bytesPerPixel: bpp, stride, data, byteOrder } = img;
    if (bpp !== 4 && bpp !== 3) {
      throw new AxError(Codes.DESKTOP_OP_FAILED,
        `Unsupported X11 pixmap format (${bpp} bytes/pixel, depth ${img.depth})`,
        { retry: "never" });
    }
    const rgb = Buffer.alloc(w * h * 3);
    for (let row = 0; row < h; row++) {
      const src = row * stride;
      const dst = row * w * 3;
      if (bpp === 4) {
        if (byteOrder === 0) { // LSBFirst: [B, G, R, X]
          for (let col = 0; col < w; col++) {
            const o = src + col * 4;
            rgb[dst + col * 3] = data[o + 2];
            rgb[dst + col * 3 + 1] = data[o + 1];
            rgb[dst + col * 3 + 2] = data[o];
          }
        } else { // MSBFirst: [X, R, G, B]
          for (let col = 0; col < w; col++) {
            const o = src + col * 4;
            rgb[dst + col * 3] = data[o + 1];
            rgb[dst + col * 3 + 1] = data[o + 2];
            rgb[dst + col * 3 + 2] = data[o + 3];
          }
        }
      } else { // 3 bytes: LSB [B, G, R], MSB [R, G, B]
        if (byteOrder === 0) {
          for (let col = 0; col < w; col++) {
            const o = src + col * 3;
            rgb[dst + col * 3] = data[o + 2];
            rgb[dst + col * 3 + 1] = data[o + 1];
            rgb[dst + col * 3 + 2] = data[o];
          }
        } else {
          data.copy(rgb, dst, src, src + w * 3);
        }
      }
    }
    return rgb;
  }

  /** 2× box downscale of packed RGB rows (vision agents don't need 1080p,
   *  and each halving quarters the JPEG cost). */
  static downscale2x(rgb, w, h) {
    const nw = Math.max(1, w >> 1);
    const nh = Math.max(1, h >> 1);
    const out = Buffer.alloc(nw * nh * 3);
    for (let y = 0; y < nh; y++) {
      const r0 = (y * 2) * w * 3;
      const r1 = (y * 2 + 1 < h ? y * 2 + 1 : y * 2) * w * 3;
      const d = y * nw * 3;
      for (let x = 0; x < nw; x++) {
        const c0 = (x * 2) * 3;
        const c1 = (x * 2 + 1 < w ? x * 2 + 1 : x * 2) * 3;
        out[d + x * 3] = (rgb[r0 + c0] + rgb[r0 + c1] + rgb[r1 + c0] + rgb[r1 + c1]) >> 2;
        out[d + x * 3 + 1] = (rgb[r0 + c0 + 1] + rgb[r0 + c1 + 1] + rgb[r1 + c0 + 1] + rgb[r1 + c1 + 1]) >> 2;
        out[d + x * 3 + 2] = (rgb[r0 + c0 + 2] + rgb[r0 + c1 + 2] + rgb[r1 + c0 + 2] + rgb[r1 + c1 + 2]) >> 2;
      }
    }
    return { rgb: out, w: nw, h: nh };
  }

  async screenshot({ x, y, w, h, budgetBytes = DEFAULT_BUDGET_BYTES, quality = 80 } = {}) {
    return this.op(async (c) => {
      let rx = Math.max(0, Math.floor(x ?? 0));
      let ry = Math.max(0, Math.floor(y ?? 0));
      let rw = w === undefined ? c.screenWidth - rx : Math.floor(w);
      let rh = h === undefined ? c.screenHeight - ry : Math.floor(h);
      // Clamp: GetImage rejects regions hanging off the root.
      rw = Math.min(rw, c.screenWidth - rx);
      rh = Math.min(rh, c.screenHeight - ry);
      if (rw < 1 || rh < 1) {
        throw new AxError(Codes.COMMAND_REJECTED,
          `Capture region ${JSON.stringify({ x: rx, y: ry, w: rw, h: rh })} is outside the screen (${c.screenWidth}x${c.screenHeight})`,
          { retry: "reobserve" });
      }
      // Budget ladder, cheapest first: full quality, then q45, then halving
      // the resolution twice (each halving also quarters the encode cost).
      // Vision workflows keep a usable image instead of a typed dead end.
      let { rgb: pixels, w: iw, h: ih } = { rgb: null, w: rw, h: rh };
      const grabFull = async () => {
        pixels = await this.grabRGB(c, rx, ry, rw, rh);
        iw = rw; ih = rh;
      };
      await grabFull();
      let jpg = encodeJPEG(pixels, iw, ih, iw * 3, quality);
      let usedQuality = quality;
      if (jpg.length > budgetBytes && quality > 45) {
        jpg = encodeJPEG(pixels, iw, ih, iw * 3, 45);
        usedQuality = 45;
      }
      for (const _ of [1, 2]) {
        if (jpg.length <= budgetBytes) break;
        if (iw <= 160 || ih <= 160) break; // keep text legible
        const small = LinuxDriver.downscale2x(pixels, iw, ih);
        pixels = small.rgb; iw = small.w; ih = small.h;
        jpg = encodeJPEG(pixels, iw, ih, iw * 3, 70);
        usedQuality = 70;
      }
      const bytes = jpg.length;
      if (bytes > budgetBytes) {
        throw new AxError(Codes.SCREENSHOT_BUDGET_EXCEEDED,
          `Desktop screenshot is ${bytes} bytes, over the ${budgetBytes} byte budget.`,
          { hint: "Pass a crop region ({x,y,w,h} in pixels from screen_info).", retry: "never" });
      }
      return {
        base64: jpg.toString("base64"),
        mime: "image/jpeg",
        bytes,
        budget_bytes: budgetBytes,
        quality: usedQuality,
        ...(iw !== rw || ih !== rh ? { downscaled: `${rw}x${rh} → ${iw}x${ih}` } : {}),
      };
    });
  }

  /* --------------------------------------------------------------- input */

  async move(x, y) {
    await this.op((c) => c.warpPointer(x, y));
    return { action_sent: "sent" };
  }

  async click({ x, y, button = "left", double = false } = {}) {
    const detail = BUTTON_DETAIL[button];
    if (!detail) throw new AxError(Codes.COMMAND_REJECTED, `button must be left|middle|right, got "${button}"`);
    await this.op(async (c) => {
      await c.warpPointer(x, y);
      await c.fakeInput({ type: FakeEventType.ButtonPress, detail });
      await c.fakeInput({ type: FakeEventType.ButtonRelease, detail });
      if (double) {
        await c.fakeInput({ type: FakeEventType.ButtonPress, detail });
        await c.fakeInput({ type: FakeEventType.ButtonRelease, detail });
      }
    });
    return { action_sent: "sent" };
  }

  async down(button = "left") {
    const detail = BUTTON_DOWN[button] ?? 1;
    await this.op((c) => c.fakeInput({ type: FakeEventType.ButtonPress, detail }));
    return { action_sent: "sent" };
  }

  async up(button = "left") {
    const detail = BUTTON_DOWN[button] ?? 1;
    await this.op((c) => c.fakeInput({ type: FakeEventType.ButtonRelease, detail }));
    return { action_sent: "sent" };
  }

  /** Wheel: X buttons 4/5 (vertical) and 6/7 (horizontal); one FakeInput
   *  click per notch (120 delta per notch, matching the Windows driver's
   *  SendInput WHEEL_DELTA convention). */
  async wheel(dx = 0, dy = 0) {
    await this.op(async (c) => {
      const notches = (d) => Math.max(1, Math.min(50, Math.round(Math.abs(d) / 120) || 1));
      if (dy < 0) for (let i = 0; i < notches(dy); i++) await c.fakeInput({ type: FakeEventType.ButtonPress, detail: 4 }), await c.fakeInput({ type: FakeEventType.ButtonRelease, detail: 4 });
      if (dy > 0) for (let i = 0; i < notches(dy); i++) await c.fakeInput({ type: FakeEventType.ButtonPress, detail: 5 }), await c.fakeInput({ type: FakeEventType.ButtonRelease, detail: 5 });
      if (dx < 0) for (let i = 0; i < notches(dx); i++) await c.fakeInput({ type: FakeEventType.ButtonPress, detail: 6 }), await c.fakeInput({ type: FakeEventType.ButtonRelease, detail: 6 });
      if (dx > 0) for (let i = 0; i < notches(dx); i++) await c.fakeInput({ type: FakeEventType.ButtonPress, detail: 7 }), await c.fakeInput({ type: FakeEventType.ButtonRelease, detail: 7 });
    });
    return { action_sent: "sent" };
  }

  async keyTapKeysym(keysym) {
    await this.op(async (c) => {
      const key = c.keyForKeysym(keysym);
      if (!key) throw untypeableKeysym(keysym);
      if (key.shift) {
        await c.fakeInput({ type: FakeEventType.KeyPress, detail: c.keyForKeysym(0xffe1).keycode });
        await c.fakeInput({ type: FakeEventType.KeyPress, detail: key.keycode });
        await c.fakeInput({ type: FakeEventType.KeyRelease, detail: key.keycode });
        await c.fakeInput({ type: FakeEventType.KeyRelease, detail: c.keyForKeysym(0xffe1).keycode });
      } else {
        await c.fakeInput({ type: FakeEventType.KeyPress, detail: key.keycode });
        await c.fakeInput({ type: FakeEventType.KeyRelease, detail: key.keycode });
      }
    });
    return { action_sent: "sent" };
  }

  async keyDownKeysym(keysym) {
    await this.op(async (c) => {
      const key = c.keyForKeysym(keysym);
      if (!key) throw untypeableKeysym(keysym);
      if (key.shift) await c.fakeInput({ type: FakeEventType.KeyPress, detail: c.keyForKeysym(0xffe1).keycode });
      await c.fakeInput({ type: FakeEventType.KeyPress, detail: key.keycode });
    });
    return { action_sent: "sent" };
  }

  async keyUpKeysym(keysym) {
    await this.op(async (c) => {
      const key = c.keyForKeysym(keysym);
      if (!key) throw untypeableKeysym(keysym);
      await c.fakeInput({ type: FakeEventType.KeyRelease, detail: key.keycode });
      if (key.shift) await c.fakeInput({ type: FakeEventType.KeyRelease, detail: c.keyForKeysym(0xffe1).keycode });
    });
    return { action_sent: "sent" };
  }

  /** Unicode text at the caret. Two paths, chosen per payload:
   *   - short, keymap-typeable text → one XTEST keysym press per char (the
   *     same per-char discipline as the Windows KEYEVENTF_UNICODE driver)
   *   - long (≥48 chars) or non-keymap text with xclip available →
   *     clipboard set + trusted ctrl+v paste (fast, layout-proof; the
   *     clipboard side effect is reported honestly). */
  async type(text) {
    const s = String(text);
    // Load the server keymap (lazy connect) before probing typeability —
    // an empty map must not push short text onto the clipboard path.
    await this.op(async () => {});
    const chars = [...s];
    const typeable = (ch) => {
      if (ch === "\n" || ch === "\r") return true; // mapped to Return below
      if (ch === "\t") return true; // mapped to Tab below
      let keysym = ch.codePointAt(0);
      if (keysym > 0xff) keysym = 0x01000000 | keysym;
      return !!this.client.keysymToKey.get(keysym);
    };
    const wantsClipboard = chars.length >= 48 || chars.some((ch) => !typeable(ch));
    if (wantsClipboard && await LinuxDriver.clipboardAvailable()) {
      await this.setClipboard(s);
      await this.press("ctrl+v");
      return { action_sent: "sent", via: "clipboard-paste", clipboard_replaced: true };
    }

    await this.op(async (c) => {
      for (const ch of chars) {
        let keysym;
        if (ch === "\n" || ch === "\r") keysym = 0xff0d; // Return
        else if (ch === "\t") keysym = 0xff09; // Tab
        else {
          keysym = ch.codePointAt(0);
          if (keysym > 0xff) keysym = 0x01000000 | keysym; // Unicode range
        }
        const key = c.keyForKeysym(keysym);
        if (!key) {
          throw new AxError(Codes.COMMAND_REJECTED,
            `Character ${JSON.stringify(ch)} has no keysym/keycode on this keyboard layout (XTEST types through the server keymap).`,
            { hint: "Install xclip for the automatic clipboard-paste path, or fill this text via the browser tools.", retry: "never" });
        }
        if (key.shift) await c.fakeInput({ type: FakeEventType.KeyPress, detail: c.keyForKeysym(0xffe1).keycode });
        await c.fakeInput({ type: FakeEventType.KeyPress, detail: key.keycode });
        await c.fakeInput({ type: FakeEventType.KeyRelease, detail: key.keycode });
        if (key.shift) await c.fakeInput({ type: FakeEventType.KeyRelease, detail: c.keyForKeysym(0xffe1).keycode });
      }
    });
    return { action_sent: "sent", via: "keysym" };
  }

  /** xclip presence (the clipboard helper), memoized. */
  static async clipboardAvailable() {
    if (LinuxDriver._clipboardHelper === undefined) {
      LinuxDriver._clipboardHelper = await new Promise((resolve) => {
        const probe = spawn("which", ["xclip"], { stdio: "ignore" });
        probe.on("exit", (code) => resolve(code === 0));
        probe.on("error", () => resolve(false));
      });
    }
    return LinuxDriver._clipboardHelper;
  }

  /** Set the CLIPBOARD selection through xclip (waits until xclip owns it).
   *  The driver's OWN display is passed explicitly — never the ambient one. */
  async setClipboard(text) {
    const ok = await new Promise((resolve) => {
      const child = spawn("xclip", ["-display", this.client.display || ":0", "-selection", "clipboard", "-in"], { stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
      child.stdin.on("error", () => {});
      child.stdin.end(String(text), "utf8");
    });
    if (!ok) {
      throw new AxError(Codes.DESKTOP_OP_FAILED,
        "xclip failed while setting the clipboard (is it installed and is an X server reachable?).",
        { retry: "retry" });
    }
    return true;
  }

  /** Combo press ("ctrl+s") mapped through the shared KEYS table. */
  async press(combo) {
    const { mods } = parseCombo(combo); // validates; throws typed errors
    const mainName = comboMainName(combo);
    const modKeysyms = [];
    for (const m of mods) {
      const ks = keysymFor(m);
      if (!ks) throw new AxError(Codes.COMMAND_REJECTED, `Unknown modifier "${m}" in combo "${combo}"`);
      modKeysyms.push(ks);
    }
    const mainKeysym = keysymFor(mainName);
    if (!mainKeysym) {
      throw new AxError(Codes.COMMAND_REJECTED, `Unknown key "${mainName}" in combo "${combo}"`);
    }
    await this.op(async (c) => {
      for (const ks of modKeysyms) {
        const key = c.keyForKeysym(ks);
        if (!key) throw untypeableKeysym(ks);
        await c.fakeInput({ type: FakeEventType.KeyPress, detail: key.keycode });
      }
      const mainKey = c.keyForKeysym(mainKeysym);
      if (!mainKey) throw untypeableKeysym(mainKeysym);
      if (mainKey.shift && !modKeysyms.length) {
        await c.fakeInput({ type: FakeEventType.KeyPress, detail: c.keyForKeysym(0xffe1).keycode });
      }
      await c.fakeInput({ type: FakeEventType.KeyPress, detail: mainKey.keycode });
      await c.fakeInput({ type: FakeEventType.KeyRelease, detail: mainKey.keycode });
      if (mainKey.shift && !modKeysyms.length) {
        await c.fakeInput({ type: FakeEventType.KeyRelease, detail: c.keyForKeysym(0xffe1).keycode });
      }
      for (let i = modKeysyms.length - 1; i >= 0; i--) {
        const key = c.keyForKeysym(modKeysyms[i]);
        await c.fakeInput({ type: FakeEventType.KeyRelease, detail: key.keycode });
      }
    });
    return { action_sent: "sent", combo };
  }

  /** Drag via move/down/move/up (interpolated like both sibling drivers). */
  async drag({ from, to, steps = 12 } = {}) {
    await this.op(async (c) => {
      await c.warpPointer(from.x, from.y);
      await c.fakeInput({ type: FakeEventType.ButtonPress, detail: 1 });
      for (let i = 1; i <= steps; i++) {
        const x = Math.round(from.x + ((to.x - from.x) * i) / steps);
        const y = Math.round(from.y + ((to.y - from.y) * i) / steps);
        await c.fakeInput({ type: FakeEventType.MotionNotify, detail: 0, x, y });
      }
      await c.fakeInput({ type: FakeEventType.ButtonRelease, detail: 1 });
    });
    return { action_sent: "sent" };
  }

  /* ------------------------------------------------------------- windows */

  async windows() {
    return this.op(async (c) => {
      const ids = await c.getPropertyU32s(c.rootWindow, "_NET_CLIENT_LIST");
      let hiddenAtom = 0;
      try { hiddenAtom = await c.internAtom("_NET_WM_STATE_HIDDEN"); } catch {}
      const rows = [];
      for (const win of ids) {
        const row = { hwnd: win, window_id: win };
        try {
          if (hiddenAtom) {
            const state = await c.getPropertyU32s(win, "_NET_WM_STATE").catch(() => []);
            if (state.includes(hiddenAtom)) continue; // minimized windows are not visible
          }
          const nameProp = await c.getProperty(win, "_NET_WM_NAME").catch(() => null);
          let title = "";
          if (nameProp?.value?.length) title = nameProp.value.toString("utf8");
          if (!title) {
            const wmName = await c.getProperty(win, "WM_NAME").catch(() => null);
            if (wmName?.value?.length) title = wmName.value.toString("latin1");
          }
          row.title = title.replace(/\s+/g, " ").trim();
          const pidProp = await c.getProperty(win, "_NET_WM_PID").catch(() => null);
          if (pidProp?.format === 32 && pidProp.value.length >= 4) row.pid = pidProp.value.readUInt32LE(0);
          const classProp = await c.getProperty(win, "WM_CLASS").catch(() => null);
          if (classProp?.value?.length) {
            const parts = classProp.value.toString("latin1").split("\0").filter(Boolean);
            row.application = parts[parts.length - 1] || undefined;
          }
          try {
            const geom = await c.getGeometry(win);
            const origin = await c.translateCoordinates(win);
            row.bounds = { x: origin.x, y: origin.y, w: geom.w, h: geom.h };
          } catch {}
        } catch {}
        rows.push(row);
      }
      return { windows: rows };
    });
  }

  async activate({ title, hwnd, pid, windowId } = {}) {
    return this.op(async (c) => {
      let target = hwnd ?? windowId ?? null;
      if (!target && pid !== undefined) {
        const ids = await c.getPropertyU32s(c.rootWindow, "_NET_CLIENT_LIST");
        for (const win of ids) {
          const p = await c.getProperty(win, "_NET_WM_PID").catch(() => null);
          if (p?.format === 32 && p.value.length >= 4 && p.value.readUInt32LE(0) === pid) { target = win; break; }
        }
      }
      if (!target && title) {
        const needle = String(title).toLowerCase();
        const ids = await c.getPropertyU32s(c.rootWindow, "_NET_CLIENT_LIST");
        for (const win of ids) {
          const nameProp = await c.getProperty(win, "_NET_WM_NAME").catch(() => null);
          const t = nameProp?.value?.length ? nameProp.value.toString("utf8") : "";
          if (t.toLowerCase().includes(needle)) { target = win; break; }
        }
      }
      if (!target) {
        throw new AxError(Codes.DESKTOP_OP_FAILED,
          "Window not found (activate needs a title substring, pid, or window_id from ax_desktop_windows).",
          { hint: "List windows with ax_desktop_windows and retry.", retry: "retry" });
      }
      const atom = await c.internAtom("_NET_ACTIVE_WINDOW");
      // Source indication 1 (application); the target window rides data.l[2].
      await c.sendClientMessage(target, atom, [1, 0, target, 0, 0]);
      // WM-less fallback (plain Xvfb): focus the window directly so
      // subsequent XTEST key events have a target.
      try { await c.setInputFocus(target); } catch {}
      return { activated: true };
    });
  }

  /* -------------------------------------------------- AT-SPI structure ops */

  /** Lazy AT-SPI connection (structure-first layer, like macOS AX). */
  async ensureAtspi() {
    if (!this.atspi || !this.atspi.connected) {
      const { AtspiClient } = await import("./atspi.js");
      this.atspi = await new AtspiClient({ sessionBusAddress: this.atspiSessionBus }).connect();
    }
    return this.atspi;
  }

  /** Is the AT-SPI structure layer actually usable (tools mount only when
   *  true — matching the macOS driver's AX gating, where tools exist only
   *  when the platform AX tree answers)? Cached and BOUNDED: activating a
   *  dead at-spi registry can take seconds, so a slow/dead probe unmounts
   *  the ax tools instead of stalling startup — and its connection attempt
   *  is closed when it (eventually) lands, so nothing dangles on the event
   *  loop. */
  async axCapable() {
    if (this.#axCapableCache !== null) return this.#axCapableCache;
    const probe = this.ensureAtspi()
      .then(async (atspi) => (await atspi.apps()).some((a) => a.name))
      .catch(() => false);
    const verdict = await Promise.race([
      probe,
      new Promise((resolve) => setTimeout(() => resolve(null), 2_500)),
    ]);
    this.#axCapableCache = verdict === true;
    if (verdict !== true) {
      // Close a connection that already landed; a late one closes itself.
      if (this.atspi) {
        try { this.atspi.close(); } catch {}
        this.atspi = null;
      } else {
        probe.then(() => {
          if (this.#axCapableCache === false) {
            try { this.atspi?.close(); } catch {}
            this.atspi = null;
          }
        }).catch(() => {});
      }
    }
    return this.#axCapableCache;
  }

  #axCapableCache = null;

  /** Resolve the target app root (pid via EWMH cross-reference, exact name,
   *  or the frontmost app). Returns the AT-SPI ref. */
  async resolveAtspiApp({ pid, name, front } = {}) {
    const atspi = await this.ensureAtspi();
    const apps = await atspi.apps();
    if (!apps.length) {
      throw new AxError(Codes.DESKTOP_OP_FAILED, "No AT-SPI applications are registered.",
        { hint: "Structure-first desktop control needs apps exposing AT-SPI (GTK/Qt apps do).", retry: "reobserve" });
    }
    if (name) {
      const hit = apps.find((a) => a.name === name);
      if (!hit) {
        throw new AxError(Codes.REF_NOT_FOUND, `No AT-SPI application named "${name}".`,
          { hint: `Available: ${apps.map((a) => a.name).filter(Boolean).join(", ") || "none"}.`, retry: "reobserve" });
      }
      return hit.ref;
    }
    if (pid !== undefined) {
      // AT-SPI app roots carry the app's accessible name; map the EWMH pid
      // → WM_CLASS instance → AT-SPI app name (windows() already knows pids).
      const target = String(pid);
      const rows = (await this.windows()).windows.filter((w) => String(w.pid) === target);
      const candidates = new Set(rows.map((w) => (w.application ?? "").toLowerCase()));
      const hit = apps.find((a) => candidates.has(a.name.toLowerCase()));
      if (!hit) {
        throw new AxError(Codes.REF_NOT_FOUND, `No AT-SPI application matches pid ${pid} (window class: ${[...candidates].join(", ") || "unknown"}).`,
          { hint: `Available: ${apps.map((a) => a.name).filter(Boolean).join(", ") || "none"}.`, retry: "reobserve" });
      }
      return hit.ref;
    }
    // front (default): the app owning the ACTIVE top-level window.
    for (const app of apps) {
      try {
        const wins = await atspi.children(app.ref);
        for (const w of wins) {
          const states = await atspi.states(w);
          if (states.includes("active") || states.includes("focused")) return app.ref;
        }
      } catch {}
    }
    // No active window found (minimized desktop?) — fall back to the first
    // app that actually has UI children.
    for (const app of apps) {
      try {
        if ((await atspi.childCount(app.ref)) > 0) return app.ref;
      } catch {}
    }
    throw new AxError(Codes.DESKTOP_OP_FAILED, "No active AT-SPI application found.",
      { hint: `Available: ${apps.map((a) => a.name).filter(Boolean).join(", ") || "none"}.`, retry: "reobserve" });
  }

  /** Re-resolve an "ax0.3.2"-style ref (child-index path from the app root;
   *  "ax0" is the root itself, suffixes walk children). Refs are stale by
   *  construction — this fails typed, like macOS. */
  async resolveAtspiRef(ref, appRef) {
    const m = /^ax(\d+(?:\.\d+)*)$/.exec(String(ref ?? ""));
    if (!m) {
      throw new AxError(Codes.REF_NOT_FOUND, `Not an AT-SPI ref: ${JSON.stringify(ref)} (expected "ax0.3.2" from ax_desktop_ax_snapshot).`,
        { retry: "reobserve" });
    }
    const indices = m[1].split(".").map(Number);
    if (indices[0] !== 0) {
      throw new AxError(Codes.REF_NOT_FOUND, `AT-SPI refs are rooted at ax0 (got ${ref}).`,
        { retry: "reobserve" });
    }
    const atspi = await this.ensureAtspi();
    let node = appRef;
    for (const idx of indices.slice(1)) {
      const [child] = await atspi.bus.call(node[0], node[1], "org.a11y.atspi.Accessible", "GetChildAtIndex", "i", [idx]);
      // Out-of-range indices answer with the /org/a11y/atspi/null sentinel.
      if (!child || !child[1] || /\/null$/.test(String(child[1]))) {
        throw new AxError(Codes.REF_NOT_FOUND, `Ref ${ref} went stale (no child at index ${idx}).`,
          { hint: "Take a fresh ax_desktop_ax_snapshot.", retry: "reobserve" });
      }
      node = child;
    }
    return node;
  }

  async axSnapshot({ pid, name, front, maxNodes = 250, maxDepth = 10 } = {}) {
    const atspi = await this.ensureAtspi();
    const appRef = await this.resolveAtspiApp({ pid, name, front });
    const appName = await atspi.name(appRef);
    const nodes = [];
    let truncated = false;
    let frontier = [{ ref: appRef, depth: 0, refPath: "ax0" }];
    const TEXT_ROLES = new Set(["text", "entry", "text box", "spin button", "paragraph", "document text", "terminal"]);
    while (frontier.length) {
      if (nodes.length >= maxNodes) { truncated = true; break; }
      // Pipelined per level: role+name+interfaces for the whole frontier.
      const level = frontier;
      frontier = [];
      const infos = await Promise.all(level.map(async (item) => {
        const [role, nameText, ifaces] = await Promise.all([
          atspi.role(item.ref).catch(() => ""),
          atspi.name(item.ref).catch(() => ""),
          atspi.interfaces(item.ref).catch(() => []),
        ]);
        return { ...item, role, nameText, ifaces };
      }));
      for (const info of infos) {
        if (nodes.length >= maxNodes) { truncated = true; break; }
        const row = { ref: info.refPath, role: info.role || "unknown", name: info.nameText || "" };
        const has = (i) => info.ifaces.some((f) => String(f).endsWith(i));
        // Bounds and text/value fetches are best-effort and only when the
        // interface exists — keeps the walk's round trips bounded.
        if (has("Component")) {
          try {
            const b = await atspi.bounds(info.ref);
            // GNOME reports INT32_MIN sentinels for unplaced actors — drop.
            if (b.w > 0 && b.h > 0 && b.x > -1e9 && b.y > -1e9) row.bounds = b;
          } catch {}
        }
        if (has("Text") && TEXT_ROLES.has((info.role || "").toLowerCase())) {
          try {
            const n = await atspi.charCount(info.ref);
            if (n >= 0 && n <= 4000) row.text = await atspi.text(info.ref, 0, Math.min(n, 2000));
          } catch {}
        }
        if (has("Value")) {
          try { row.value = await atspi.value(info.ref); } catch {}
        }
        nodes.push(row);
        if (info.depth < maxDepth) {
          try {
            const kids = await atspi.children(info.ref);
            frontier.push(...kids.map((k, i) => ({ ref: k, depth: info.depth + 1, refPath: `${info.refPath}.${i}` })));
          } catch {}
        }
      }
    }
    return {
      app: appName,
      nodes,
      truncated,
      node_count: nodes.length,
      note: "AT-SPI snapshot (Linux structure-first): refs are child-index paths from the app root and re-resolve live at action time.",
    };
  }

  async axRead({ ref, pid, name, front } = {}) {
    const atspi = await this.ensureAtspi();
    const appRef = await this.resolveAtspiApp({ pid, name, front });
    const node = await this.resolveAtspiRef(ref, appRef);
    const [role, nameText, description, states, ifaces] = await Promise.all([
      atspi.role(node),
      atspi.name(node).catch(() => ""),
      atspi.description(node).catch(() => ""),
      atspi.states(node).catch(() => []),
      atspi.interfaces(node).catch(() => []),
    ]);
    const has = (i) => ifaces.some((f) => String(f).endsWith(i));
    const out = { ref, role, name: nameText, description, states, interfaces: ifaces };
    if (has("Component")) {
      try {
        const b = await atspi.bounds(node);
        if (b.w > 0 && b.h > 0 && b.x > -1e9 && b.y > -1e9) out.bounds = b;
      } catch {}
    }
    if (has("Text")) {
      try {
        const n = await atspi.charCount(node);
        // Some bridges reject a -1 end offset — clamp to the real count.
        out.text = n >= 0 && n <= 4000 ? await atspi.text(node, 0, Math.min(n, 2000)) : `(text of ${n} chars)`;
      } catch {}
    }
    if (has("Value")) {
      try { out.value = await atspi.value(node); } catch {}
    }
    if (has("Action")) {
      // Name lookups only — GetActions would crash GTK's atk-bridge.
      try {
        const count = await atspi.actionCount(node).catch(() => 0);
        const names = [];
        for (let i = 0; i < Math.min(count, 10); i++) {
          names.push(await atspi.actionName(node, i).catch(() => `action ${i}`));
        }
        if (count > 0) out.actions = names;
      } catch {}
    }
    return out;
  }

  async axClick({ ref, pid, name, front, fallbackToCoords = true } = {}) {
    const atspi = await this.ensureAtspi();
    const appRef = await this.resolveAtspiApp({ pid, name, front });
    const node = await this.resolveAtspiRef(ref, appRef);
    const ifaces = await atspi.interfaces(node).catch(() => []);
    const has = (i) => ifaces.some((f) => String(f).endsWith(i));
    if (has("Action")) {
      // NOTE: never call GetActions here — GTK's atk-bridge (2.4x) CRASHES
      // marshalling its a(sss) reply, killing the app's bus connection.
      // DoAction(i) directly is the safe universal path; the name lookup is
      // best-effort (missing on GTK, present on Qt's bridge).
      try {
        const done = await atspi.doAction(node, 0);
        if (done) {
          const name = await atspi.actionName(node, 0).catch(() => null);
          return { action_sent: "sent", via: "atspi-action", action_index: 0, ...(name ? { action: name } : {}) };
        }
      } catch {
        // Action interface present but refused → coordinate fallback below.
      }
    }
    if (!fallbackToCoords) {
      throw new AxError(Codes.COMMAND_REJECTED,
        `Element ${ref} (${await atspi.role(node)}) exposes no AT-SPI action and the coordinate fallback is disabled.`,
        { retry: "never" });
    }
    const b = await atspi.bounds(node);
    const x = b.x + (b.w >> 1);
    const y = b.y + (b.h >> 1);
    await this.click({ x, y });
    return { action_sent: "sent", via: "coordinate-fallback", clicked: { x, y } };
  }

  async axSet({ ref, value, pid, name, front } = {}) {
    const atspi = await this.ensureAtspi();
    const appRef = await this.resolveAtspiApp({ pid, name, front });
    const node = await this.resolveAtspiRef(ref, appRef);
    const ifaces = await atspi.interfaces(node).catch(() => []);
    const has = (i) => ifaces.some((f) => String(f).endsWith(i));
    if (!has("EditableText")) {
      throw new AxError(Codes.COMMAND_REJECTED,
        `Element ${ref} (${await atspi.role(node)}) is not AT-SPI-editable (interfaces: ${ifaces.join(", ") || "none"}).`,
        { hint: "Use ax_desktop_ax_click and type, or the browser tools for web fields.", retry: "reobserve" });
    }
    const ok = await atspi.setTextContents(node, String(value));
    if (!ok) {
      throw new AxError(Codes.DESKTOP_OP_FAILED, "EditableText.SetTextContents returned false.", { retry: "retry" });
    }
    const readBack = has("Text") ? await atspi.text(node, 0, -1).catch(() => null) : null;
    return { value_set: String(value), via: "atspi-editabletext", ...(readBack !== null ? { read_back_matches: readBack === String(value) } : {}) };
  }

  dispose() {
    try { this.client.close(); } catch {}
    try { this.atspi?.close(); } catch {}
  }
}

const BUTTON_DOWN = { left: 1, middle: 2, right: 3 };

function untypeableKeysym(keysym) {
  return new AxError(Codes.COMMAND_REJECTED,
    `Key with keysym 0x${keysym.toString(16)} has no keycode on this keyboard layout.`,
    { hint: "Prefer named keys (enter, tab, arrows, f1-f12) or the browser tools for text.", retry: "never" });
}

/** The non-modifier part of a combo string ("ctrl+shift+p" → "p"). */
function comboMainName(combo) {
  const parts = String(combo).toLowerCase().split("+").map((s) => s.trim()).filter(Boolean);
  const main = parts.find((p) => !(p in KEY_NAME_TO_KEYSYM && KEY_NAME_TO_KEYSYM[p] >= 0xffe0));
  return main ?? parts[parts.length - 1] ?? "";
}
