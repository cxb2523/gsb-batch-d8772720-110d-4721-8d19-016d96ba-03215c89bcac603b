/**
 * axuse — minimal zero-dependency X11 protocol client (Linux desktop driver).
 *
 * Lineage: the Windows driver scripts PowerShell + SendInput, the macOS
 * driver scripts JXA + CoreGraphics. Linux has no comparable "scriptable
 * surface" guaranteed present — xdotool/wmctrl/scrot are extra apt packages
 * — but every X11 server speaks one wire protocol over a Unix socket, and
 * Node ships everything needed to speak it directly:
 *
 *   - connection setup + Xauthority cookie (MIT-MAGIC-COOKIE-1) with an
 *     empty-auth retry (SI:localuser grants local same-user clients)
 *   - core requests: WarpPointer, QueryPointer, GetImage, GetGeometry,
 *     TranslateCoordinates, InternAtom, GetProperty, SendEvent,
 *     GetKeyboardMapping
 *   - XTEST FakeInput — trusted server-side input synthesis, the X
 *     equivalent of SendInput (wire layout per the XTEST 2.2 encoding)
 *   - EWMH properties for the client window list + _NET_ACTIVE_WINDOW
 *
 * Scope notes (v1):
 *   - X11/XWayland only; native Wayland sessions refuse with a typed error.
 *   - The root window of the display's default screen is the coordinate
 *     space. On the standard single-X-screen layout the root spans every
 *     monitor, so warps and captures work across monitors.
 */
import { connect as netConnect } from "node:net";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AxError, Codes } from "../core/errors.js";

const NO_WINDOW = 0;

/** X core request opcodes used here. */
export const Op = Object.freeze({
  GetGeometry: 14, QueryTree: 15, InternAtom: 16, GetProperty: 20, SendEvent: 25,
  QueryPointer: 38, TranslateCoordinates: 40, WarpPointer: 41,
  GetImage: 73, QueryExtension: 98, GetKeyboardMapping: 101,
});

/** FAKE_EVENT_TYPE values (same as the core event codes). */
export const FakeEventType = Object.freeze({
  KeyPress: 2, KeyRelease: 3, ButtonPress: 4, ButtonRelease: 5, MotionNotify: 6,
});

/** Parse a display string ":1", ":1.0", "unix:1", "host:1" → parts. */
export function parseDisplay(display = process.env.DISPLAY ?? "") {
  const m = /^([a-zA-Z0-9._-]*):([0-9]+)(?:\.([0-9]+))?$/.exec(String(display).trim());
  if (!m) return null;
  return { host: m[1], display: Number(m[2]), screen: m[3] === undefined ? null : Number(m[3]) };
}

/** Xauthority records (little-endian u16 lengths, no padding between fields):
 *   family(u16) addrLen addr | numLen num | nameLen name | dataLen data */
export function readXauthority(path) {
  let buf;
  try {
    buf = readFileSync(path);
  } catch {
    return [];
  }
  const out = [];
  let o = 0;
  const u16 = () => { const v = buf.readUInt16LE(o); o += 2; return v; };
  const blob = () => { const n = u16(); const b = buf.subarray(o, o + n); o += n; return b; };
  while (o + 2 <= buf.length) {
    const start = o;
    try {
      const family = u16();
      const addr = blob();
      const num = blob();
      const name = blob();
      const data = blob();
      out.push({ family, addr, num: num.toString("latin1"), name: name.toString("latin1"), data });
    } catch {
      o = start;
      break; // truncated record
    }
  }
  return out;
}

/** Best MIT-MAGIC-COOKIE-1 for a display: exact display-number match first,
 *  then a wildcard-family record (FamilyWild=65535, FamilyLocal=256). */
function cookieFor(display) {
  const path = process.env.XAUTHORITY || join(homedir(), ".Xauthority");
  const cookies = readXauthority(path).filter((r) => r.name === "MIT-MAGIC-COOKIE-1");
  return cookies.find((r) => r.num === String(display))
    ?? cookies.find((r) => r.family === 65535 || r.family === 256)
    ?? null;
}

function describeXError(code) {
  const names = {
    1: "BadRequest", 2: "BadValue", 3: "BadWindow", 4: "BadPixmap", 5: "BadAtom",
    6: "BadCursor", 7: "BadFont", 8: "BadMatch", 9: "BadDrawable", 10: "BadAccess",
    11: "BadAlloc", 12: "BadColor", 13: "BadGC", 14: "BadIDChoice", 15: "BadName",
    16: "BadLength", 17: "BadImplementation",
  };
  return names[code] ?? `code ${code}`;
}

/** Static evdev keymap (keysym → [keycode = KEY_* + 8, shift]) for servers
 *  whose core keyboard map is empty (XKB-owned). US-layout punctuation; the
 *  server map wins whenever it is populated. */
const EVDEV_KEYMAP = (() => {
  const rows = [];
  const push = (keysym, keycode, shift) => rows.push([keysym, keycode, shift]);
  // Letters in QWERTY PHYSICAL order (evdev keycodes; X keycode = code + 8):
  // q w e r t y u i o p → 24..33, a s d f g h j k l → 38..46,
  // z x c v b n m → 52..58. Alphabetical order would be wrong — the map is
  // positional, not alphabetical.
  const letterRows = [
    ["qwertyuiop", 24],
    ["asdfghjkl", 38],
    ["zxcvbnm", 52],
  ];
  for (const [letters, base] of letterRows) {
    for (let i = 0; i < letters.length; i++) {
      const c = letters.charCodeAt(i);
      push(c, base + i, false); // lowercase
      push(c - 32, base + i, true); // uppercase (shift)
    }
  }
  // Digits row (KEY_1=2 → keycode 10 … KEY_0=11 → 19)
  const digits = "1234567890";
  const shifted = "!@#$%^&*()";
  for (let i = 0; i < 10; i++) {
    push(digits.charCodeAt(i), 10 + i, false);
    push(shifted.charCodeAt(i), 10 + i, true);
  }
  const named = [
    // [keysym, keycode, shift]
    [0xff0d, 36, false], [0xff09, 23, false], [0xff1b, 9, false], [0xff08, 22, false],
    [0xffff, 119, false], [0xff63, 118, false],
    [0xff52, 111, false], [0xff54, 116, false], [0xff51, 113, false], [0xff53, 114, false],
    [0xff50, 110, false], [0xff57, 115, false], [0xff55, 112, false], [0xff56, 117, false],
    [0x20, 65, false],
    [0xffe1, 50, false], [0xffe2, 62, false], // Shift_L/R
    [0xffe3, 37, false], [0xffe4, 105, false], // Control_L/R
    [0xffe9, 64, false], [0xffea, 108, false], // Alt_L/R
    [0xffeb, 133, false], [0xffec, 134, false], // Super_L/R
    [0xffe5, 66, false], [0xff7f, 77, false], // Caps_Lock, Num_Lock
    // US punctuation (unshifted, shifted)
    [0x2d, 20, false], [0x5f, 20, true], // - _
    [0x3d, 21, false], [0x2b, 21, true], // = +
    [0x5b, 34, false], [0x7b, 34, true], // [ {
    [0x5d, 35, false], [0x7d, 35, true], // ] }
    [0x5c, 51, false], [0x7c, 51, true], // \ |
    [0x3b, 47, false], [0x3a, 47, true], // ; :
    [0x27, 48, false], [0x22, 48, true], // ' "
    [0x60, 49, false], [0x7e, 49, true], // ` ~
    [0x2c, 59, false], [0x3c, 59, true], // , <
    [0x2e, 60, false], [0x3e, 60, true], // . >
    [0x2f, 61, false], [0x3f, 61, true], // / ?
  ];
  rows.push(...named);
  for (let i = 0; i < 12; i++) push(0xffbe + i, 67 + i, false); // F1-F12
  // Numeric keypad: KP_0=90, KP_1=87 … KP_9=81 (evdev + 8).
  const kpDigits = [[0xffb0, 90], [0xffb1, 87], [0xffb2, 88], [0xffb3, 89], [0xffb4, 83],
    [0xffb5, 84], [0xffb6, 85], [0xffb7, 79], [0xffb8, 80], [0xffb9, 81]];
  for (const [keysym, keycode] of kpDigits) push(keysym, keycode, false);
  push(0xffab, 86, false); // KP_Add
  push(0xffad, 82, false); // KP_Subtract
  push(0xaa, 63, false); // KP_Multiply
  push(0xaf, 106, false); // KP_Divide
  push(0xff8b, 104, false); // KP_Enter
  push(0xff9e, 91, false); // KP_Decimal
  return rows;
})();

/**
 * A small synchronous-request-at-a-time X11 client. Desktop input must be
 * strictly ordered anyway (the driver serializes ops like WindowsDriver),
 * so a sequence-keyed pending map is sufficient — no concurrent pipelines.
 */
export class X11Client {
  /** @param {string} [display] */
  constructor(display) {
    this.display = String(display ?? process.env.DISPLAY ?? "");
    this.displaySpec = parseDisplay(this.display);
    this.socket = null;
    this.seq = 0;
    this.pending = new Map(); // seq → {resolve, reject}
    this.buffer = Buffer.alloc(0);
    this.setupWaiters = []; // pre-handshake readers (waitFor)
    this.rootWindow = 0;
    this.rootCandidates = [];
    this.screenWidth = 0;
    this.screenHeight = 0;
    this.minKeycode = 0;
    this.maxKeycode = 0;
    this.imageByteOrder = 0; // 0 LSBFirst, 1 MSBFirst
    this.pixmapFormats = new Map(); // depth → bits-per-pixel
    this.xtestOpcode = 0;
    this.atoms = new Map();
    this.keysymToKey = new Map(); // keysym → {keycode, shift}
    this.dead = false;
  }

  get connected() {
    return !!this.socket && !this.dead;
  }

  /* ----------------------------------------------------------- connection */

  async connect() {
    this.dead = false; // a disposed client may reconnect (driver respawn)
    if (!this.displaySpec) {
      throw new AxError(Codes.DESKTOP_DRIVER_UNAVAILABLE,
        process.env.WAYLAND_DISPLAY
          ? "This looks like a native Wayland session with no usable DISPLAY; the Linux desktop driver speaks X11 (XWayland covers most desktop apps — set DISPLAY, usually :0, :1 or similar)."
          : "DISPLAY is not set; the Linux desktop driver needs an X11 session (run the harness inside the desktop session, or under xvfb-run for a virtual display).",
        { hint: "Desktop control on Linux targets X11/XWayland; browser tools work everywhere.", retry: "never" });
    }
    const { host, display } = this.displaySpec;
    await new Promise((resolve, reject) => {
      const sock = (host === "" || host === "unix")
        ? netConnect(`/tmp/.X11-unix/X${display}`)
        : netConnect({ host, port: 6000 + display });
      const fail = (e) => reject(new AxError(Codes.DESKTOP_DRIVER_UNAVAILABLE,
        `Cannot open X display ${process.env.DISPLAY ?? ""}: ${e.message}`,
        { hint: "Run inside the X session (XAUTHORITY may need to point at the session cookie), or under xvfb-run.", retry: "never" }));
      sock.once("error", fail);
      sock.once("connect", () => {
        sock.off("error", fail);
        this.socket = sock;
        resolve();
      });
    });

    try {
      await this.handshake(cookieFor(display));
    } catch (e) {
      // A mismatched cookie is the common cause; SI:localuser access control
      // admits same-user clients without any cookie — retry cookie-less.
      if (e instanceof AxError && e.code === Codes.DESKTOP_DRIVER_UNAVAILABLE) {
        this.teardownSocket();
        await this.reopenSocket();
        await this.handshake(null);
      } else {
        throw e;
      }
    }
    this.socket.on("data", (d) => this.routeData(d));
    this.socket.on("close", () => this.failAll("X11 connection closed"));
    this.socket.on("error", () => this.failAll("X11 connection error"));

    if (!(await this.resolveRoot())) {
      throw new AxError(Codes.INTERNAL, "No candidate root window answered GetGeometry.");
    }
    this.xtestOpcode = (await this.queryExtension("XTEST")).majorOpcode;
    if (!this.xtestOpcode) {
      throw new AxError(Codes.DESKTOP_DRIVER_UNAVAILABLE,
        "The X server does not support the XTEST extension; trusted input synthesis is unavailable.",
        { retry: "never" });
    }
    await this.loadKeyboardMap();
    return this;
  }

  async reopenSocket() {
    const { host, display } = this.displaySpec;
    await new Promise((resolve, reject) => {
      const sock = (host === "" || host === "unix")
        ? netConnect(`/tmp/.X11-unix/X${display}`)
        : netConnect({ host, port: 6000 + display });
      sock.once("error", reject);
      sock.once("connect", () => { this.socket = sock; resolve(); });
    });
    this.buffer = Buffer.alloc(0);
    this.dead = false;
  }

  teardownSocket() {
    try { this.socket?.destroy(); } catch {}
    this.socket = null;
  }

  /** Send the connection setup with an (optional) auth cookie and parse it. */
  async handshake(cookie) {
    const name = "MIT-MAGIC-COOKIE-1";
    const data = cookie?.data ?? Buffer.alloc(0);
    const pad4 = (n) => (4 - (n % 4)) % 4;
    const head = Buffer.alloc(12);
    head.writeUInt8(0x6c, 0); // 'l' — little-endian
    head.writeUInt8(0, 1);
    head.writeUInt16LE(11, 2); // protocol 11.0
    head.writeUInt16LE(0, 4);
    head.writeUInt16LE(name.length, 6);
    head.writeUInt16LE(data.length, 8);
    head.writeUInt16LE(0, 10);
    this.socket.write(Buffer.concat([
      head,
      Buffer.from(name, "latin1"), Buffer.alloc(pad4(name.length)),
      data, Buffer.alloc(pad4(data.length)),
    ]));

    const first = await this.waitFor(8);
    // The setup length field counts 4-byte units AFTER the 8-byte header,
    // INCLUDING the 32-byte fixed part (release/ids/keycodes…): the whole
    // packet is 8 + length*4 bytes (verified against Xorg 1.21 wire).
    const total = 8 + first.readUInt16LE(6) * 4;
    const full = Buffer.concat([first, await this.waitFor(total - 8)]);
    if (full[0] === 2) {
      // SetupFailed: [2][reasonLen][major][minor][len16][reason…]
      const reason = full.subarray(8).toString("utf8").replace(/\0.*$/s, "").trim();
      throw new AxError(Codes.DESKTOP_DRIVER_UNAVAILABLE,
        `The X server refused the connection${reason ? `: ${reason}` : ""}.`,
        { hint: "Auth mismatch — run inside the X session or point XAUTHORITY at the session cookie.", retry: "never" });
    }
    if (full[0] !== 1) throw new AxError(Codes.INTERNAL, `Unexpected X11 setup reply type ${full[0]}`);
    // Fixed-field layout verified byte-by-byte against Xorg 1.21.1 wire
    // (Ubuntu 22.04–26.04 family; LSB connection):
    //   vlen@24, maxReqLen@26, pad@28, nformats@29, imageByteOrder@30,
    //   bitmapBitOrder@31, scanlineUnit@32, scanlinePad@33, minKey@34,
    //   maxKey@35, unused4@36..40, vendor@40, formats (8·nformats),
    //   then screens. Single-byte fields are junk-guarded (some builds
    //   leave "unused" slots uninitialized).
    this.imageByteOrder = full[30] <= 1 ? full[30] : 0;
    this.minKeycode = full[34];
    this.maxKeycode = full[35];
    if (!(this.minKeycode < this.maxKeycode)) {
      // Fallback: the canonical evdev range every mainstream server uses.
      this.minKeycode = 8;
      this.maxKeycode = 255;
    }
    const vendorLen = full.readUInt16LE(24);
    const afterVendor = 40 + vendorLen + ((4 - (vendorLen % 4)) % 4);
    // Pixmap formats ([depth, bits-per-pixel, scanline-pad, 5 junk] × 8):
    // Xorg maps depth 24 → 32 bpp — GetImage rows must use this, not depth/8.
    this.pixmapFormats = new Map();
    const fmtCount = full[29] >= 1 && full[29] <= 16 ? full[29] : 6;
    for (let i = 0; i < fmtCount && afterVendor + i * 8 + 2 <= full.length; i++) {
      const depth = full[afterVendor + i * 8];
      const bitsPerPixel = full[afterVendor + i * 8 + 1];
      if (depth > 0 && bitsPerPixel > 0) this.pixmapFormats.set(depth, bitsPerPixel);
    }
    // Screen 0 root candidates: the declared pixmap-format count when it
    // parses sanely, else a scan — the true root is confirmed against the
    // live server by GetGeometry in resolveRoot().
    this.rootCandidates = [];
    const nformats = full[29] >= 1 && full[29] <= 16 ? full[29] : null;
    for (const formats of nformats !== null ? [nformats] : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16]) {
      const s = afterVendor + formats * 8;
      if (s + 24 > full.length) break;
      const root = full.readUInt32LE(s);
      // Screen record: root(4) colormap(4) white(4) black(4) masks(4)
      // then width/height in pixels at s+20/s+22.
      const w = full.readUInt16LE(s + 20);
      const h = full.readUInt16LE(s + 22);
      if (root !== 0 && w > 0 && h > 0 && w <= 32767 && h <= 32767) {
        this.rootCandidates.push({ root, w, h });
      }
    }
    if (!this.rootCandidates.length) {
      throw new AxError(Codes.INTERNAL, "Could not parse the X11 connection setup screen list.");
    }
  }

  /** Pick the real root window: the candidate whose GetGeometry round-trips
   *  on the live connection (formats/visual bytes can masquerade as screens
   *  to a heuristic, but only a real window answers GetGeometry). */
  async resolveRoot() {
    for (const cand of this.rootCandidates ?? []) {
      try {
        const g = await this.getGeometry(cand.root);
        if (g.w > 0 && g.h > 0) {
          this.rootWindow = cand.root;
          this.screenWidth = g.w;
          this.screenHeight = g.h;
          return true;
        }
      } catch {
        // BadWindow → wrong candidate, keep scanning.
      }
    }
    return false;
  }

  /** Accumulate `n` bytes during setup (sole consumer of socket data). */
  waitFor(n) {
    if (this.buffer.length >= n) {
      const out = this.buffer.subarray(0, n);
      this.buffer = this.buffer.subarray(n);
      return Promise.resolve(out);
    }
    return new Promise((resolve, reject) => {
      const w = { n, resolve, reject };
      this.setupWaiters.push(w);
      const onChunk = (d) => { this.buffer = Buffer.concat([this.buffer, d]); this.pumpSetup(); };
      const onClose = () => {
        this.setupWaiters.splice(this.setupWaiters.indexOf(w), 1);
        reject(new AxError(Codes.DESKTOP_DRIVER_UNAVAILABLE, "X11 connection closed during handshake"));
      };
      this.socket.on("data", onChunk);
      this.socket.once("close", onClose);
      w.cleanup = () => { this.socket.off("data", onChunk); this.socket.off("close", onClose); };
      this.pumpSetup();
    });
  }

  pumpSetup() {
    while (this.setupWaiters.length && this.buffer.length >= this.setupWaiters[0].n) {
      const w = this.setupWaiters.shift();
      const out = this.buffer.subarray(0, w.n);
      this.buffer = this.buffer.subarray(w.n);
      w.cleanup?.();
      w.resolve(out);
    }
  }

  /* ------------------------------------------------------- reply routing */

  routeData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 32) return;
      const first = this.buffer[0];
      if (first === 0) {
        // X error: [0][code][seq][value(4)][minor(2)][major(1)][pad(21)]
        const code = this.buffer[1];
        const seq = this.buffer.readUInt16LE(2);
        const value = this.buffer.readUInt32LE(4);
        const minor = this.buffer.readUInt16LE(8);
        const major = this.buffer[10];
        this.buffer = this.buffer.subarray(32);
        const p = this.pending.get(seq);
        if (p) {
          this.pending.delete(seq);
          p.reject(new AxError(Codes.DESKTOP_OP_FAILED,
            `X11 ${describeXError(code)} on request ${major}.${minor} (value ${value})`, { retry: "retry" }));
        }
        continue;
      }
      if (first === 1) {
        const seq = this.buffer.readUInt16LE(2);
        const extra = this.buffer.readUInt32LE(4) * 4;
        const total = 32 + extra;
        if (this.buffer.length < total) return;
        const reply = Buffer.from(this.buffer.subarray(0, total)); // copy: buffer window gets sliced
        this.buffer = this.buffer.subarray(total);
        const p = this.pending.get(seq);
        if (p) {
          this.pending.delete(seq);
          p.resolve(reply);
        }
        continue;
      }
      // Event (2..64): v1 routes nothing — skip one 32-byte frame.
      this.buffer = this.buffer.subarray(32);
    }
  }

  failAll(reason) {
    this.dead = true;
    for (const [, p] of this.pending) p.reject(new AxError(Codes.DESKTOP_OP_FAILED, reason));
    this.pending.clear();
  }

  /** Send a fully-assembled request buffer (length slot at bytes 2..4 is
   *  filled in here from the buffer size). Resolves on the reply when
   *  `wantReply`, else immediately after the write. */
  send(buf, wantReply = false) {
    if (!this.socket || this.dead) {
      return Promise.reject(new AxError(Codes.DESKTOP_OP_FAILED, "X11 connection is not open"));
    }
    if (buf.length % 4 !== 0) throw new Error("X11 request must be 4-byte aligned");
    buf.writeUInt16LE(buf.length / 4, 2);
    // The server numbers EVERY request (replies AND no-reply requests);
    // the counter must advance even when we expect nothing back.
    const seq = (this.seq = (this.seq + 1) & 0xffff);
    if (!wantReply) {
      this.socket.write(buf);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
      this.socket.write(buf);
    });
  }

  /* ------------------------------------------------------------- requests */

  async queryExtension(name) {
    const n = Buffer.byteLength(name);
    const buf = Buffer.alloc(4 + 4 + n + ((4 - (n % 4)) % 4));
    buf.writeUInt8(Op.QueryExtension, 0);
    buf.writeUInt16LE(2 + (4 + n) / 4, 2);
    buf.writeUInt16LE(n, 4);
    buf.write(name, 8, "latin1");
    const rep = await this.send(buf, true);
    // Field layout verified on the wire (Xorg 1.21 LSB): present BOOL at
    // byte 8, major opcode / first event / first error as single bytes.
    return rep[8] === 1 ? { present: true, majorOpcode: rep[9] } : { present: false, majorOpcode: 0 };
  }

  async internAtom(name) {
    const cached = this.atoms.get(name);
    if (cached) return cached;
    const n = Buffer.byteLength(name);
    const buf = Buffer.alloc(4 + 4 + n + ((4 - (n % 4)) % 4));
    buf.writeUInt8(Op.InternAtom, 0);
    buf.writeUInt8(1, 1); // only if exists
    buf.writeUInt16LE(2 + (4 + n) / 4, 2);
    buf.writeUInt16LE(n, 4);
    buf.write(name, 8, "latin1");
    const rep = await this.send(buf, true);
    const atom = rep.readUInt32LE(8);
    this.atoms.set(name, atom);
    return atom;
  }

  async getProperty(window, name, { longLength = 4096 } = {}) {
    const prop = typeof name === "string" ? await this.internAtom(name) : name;
    if (!prop) {
      // Atom not present (e.g. EWMH atoms without a running window manager):
      // the property cannot exist — report empty rather than BadAtom.
      return { format: 0, typeAtom: 0, bytesAfter: 0, valueLen: 0, value: Buffer.alloc(0) };
    }
    const buf = Buffer.alloc(24);
    buf.writeUInt8(Op.GetProperty, 0);
    buf.writeUInt8(0, 1); // delete = false
    buf.writeUInt16LE(6, 2);
    buf.writeUInt32LE(window, 4);
    buf.writeUInt32LE(prop, 8);
    buf.writeUInt32LE(0, 12); // type = AnyPropertyType
    buf.writeUInt32LE(0, 16); // long-offset
    buf.writeUInt32LE(longLength, 20);
    const rep = await this.send(buf, true);
    return {
      format: rep[1],
      typeAtom: rep.readUInt32LE(8),
      bytesAfter: rep.readUInt32LE(12),
      valueLen: rep.readUInt32LE(16),
      value: rep.subarray(32, 32 + rep.readUInt32LE(16)),
    };
  }

  /** GetProperty value as a CARD32 list (window ids, pids…). */
  async getPropertyU32s(window, name) {
    const { format, value } = await this.getProperty(window, name);
    if (format !== 32) return [];
    const out = [];
    for (let o = 0; o + 4 <= value.length; o += 4) out.push(value.readUInt32LE(o));
    return out;
  }

  async getGeometry(drawable) {
    const buf = Buffer.alloc(8);
    buf.writeUInt8(Op.GetGeometry, 0);
    buf.writeUInt16LE(2, 2);
    buf.writeUInt32LE(drawable, 4);
    const rep = await this.send(buf, true);
    return {
      depth: rep[1],
      root: rep.readUInt32LE(8),
      x: rep.readInt16LE(12),
      y: rep.readInt16LE(14),
      w: rep.readUInt16LE(16),
      h: rep.readUInt16LE(18),
    };
  }

  async queryPointer() {
    const buf = Buffer.alloc(8);
    buf.writeUInt8(Op.QueryPointer, 0);
    buf.writeUInt16LE(2, 2);
    buf.writeUInt32LE(this.rootWindow, 4);
    const rep = await this.send(buf, true);
    return {
      sameScreen: rep[1] === 1,
      child: rep.readUInt32LE(12),
      rootX: rep.readInt16LE(16),
      rootY: rep.readInt16LE(18),
    };
  }

  async warpPointer(x, y) {
    // 24 bytes (length 6): dst-x/dst-y are INT16 per the protocol encoding
    // (verified against Xorg 1.21 — a 28-byte form draws BadLength).
    const buf = Buffer.alloc(24);
    buf.writeUInt8(Op.WarpPointer, 0);
    buf.writeUInt16LE(6, 2);
    buf.writeUInt32LE(NO_WINDOW, 4); // src = None
    buf.writeUInt32LE(this.rootWindow, 8); // dst = root
    buf.writeInt16LE(0, 12); // src x
    buf.writeInt16LE(0, 14); // src y
    buf.writeUInt16LE(0, 16); // src width 0 = whole
    buf.writeUInt16LE(0, 18); // src height
    buf.writeInt16LE(Math.round(x), 20); // dst x
    buf.writeInt16LE(Math.round(y), 22); // dst y
    await this.send(buf);
  }

  /** XTEST FakeInput (36 bytes, length 9): keys use server keycodes, buttons
   *  1-7 (4/5 = wheel up/down, 6/7 = wheel left/right), motion with
   *  detail 0 = absolute rootX/rootY. delay 0 = immediate. */
  async fakeInput({ type, detail = 0, delayMs = 0, x, y } = {}) {
    if (!this.xtestOpcode) throw new AxError(Codes.DESKTOP_OP_FAILED, "XTEST extension not available");
    const buf = Buffer.alloc(36);
    buf.writeUInt8(this.xtestOpcode, 0);
    buf.writeUInt8(2, 1); // FakeInput
    buf.writeUInt8(type, 4);
    buf.writeUInt8(detail, 5);
    buf.writeUInt32LE(delayMs, 8);
    // root (0 = current root) at 12; 8 unused; rootX/rootY at 24/26.
    if (x !== undefined) buf.writeInt16LE(Math.round(x), 24);
    if (y !== undefined) buf.writeInt16LE(Math.round(y), 26);
    await this.send(buf);
  }

  /** ZPixmap grab of the root window (clamped to bounds by the caller).
   *  Returns raw rows + layout facts for the RGB conversion step. */
  async getImage(x, y, w, h) {
    const buf = Buffer.alloc(20); // 5 units: opcode, format, drawable, x/y/w/h, plane-mask
    buf.writeUInt8(Op.GetImage, 0);
    buf.writeUInt8(2, 1); // format = ZPixmap
    buf.writeUInt32LE(this.rootWindow, 4);
    buf.writeInt16LE(Math.round(x), 8);
    buf.writeInt16LE(Math.round(y), 10);
    buf.writeUInt16LE(w, 12);
    buf.writeUInt16LE(h, 14);
    buf.writeUInt32LE(0xffffffff, 16); // plane mask = all
    const rep = await this.send(buf, true);
    const depth = rep[1];
    const data = rep.subarray(32);
    const bitsPerPixel = this.pixmapFormats?.get(depth) ?? (depth >= 24 ? 32 : depth);
    const bytesPerPixel = Math.max(1, bitsPerPixel / 8);
    const stride = Math.ceil((w * bytesPerPixel) / 4) * 4;
    return { depth, bytesPerPixel, stride, w, h, data, byteOrder: this.imageByteOrder };
  }

  /** Fill keysym → {keycode, shift} from the server keyboard map. Servers
   *  whose keyboard is fully owned by XKB (Xvfb, some minimal setups) answer
   *  the core query with an empty map — then fall back to the static evdev
   *  table (X keycode = Linux KEY_* + 8, stable across distros). */
  async loadKeyboardMap() {
    const count = this.maxKeycode - this.minKeycode + 1;
    if (count > 0) {
      const buf = Buffer.alloc(8);
      buf.writeUInt8(Op.GetKeyboardMapping, 0);
      buf.writeUInt8(this.minKeycode, 1);
      buf.writeUInt16LE(2, 2);
      buf.writeUInt8(count, 4);
      const rep = await this.send(buf, true);
      const perKeycode = rep[1] || 2;
      const nKeysyms = rep.readUInt32LE(4); // reply length in CARD32 units
      this.keysymToKey.clear();
      for (let k = 0; k < count; k++) {
        for (let col = 0; col < perKeycode; col++) {
          const idx = k * perKeycode + col;
          if (idx >= nKeysyms) break;
          const keysym = rep.readUInt32LE(32 + idx * 4);
          if (!keysym) continue;
          // Column parity encodes Shift on the primary group; register the
          // first mapping for each keysym (group-2 columns only add).
          if (!this.keysymToKey.has(keysym)) {
            this.keysymToKey.set(keysym, { keycode: this.minKeycode + k, shift: col % 2 === 1 });
          }
        }
      }
      if (this.keysymToKey.size > 0) return this.keysymToKey.size;
    }
    this.applyEvdevMap();
    return this.keysymToKey.size;
  }

  /** The static evdev/XKB fallback map: [keysym, keycode, needsShift]. */
  applyEvdevMap() {
    this.keysymToKey.clear();
    for (const [keysym, keycode, shift] of EVDEV_KEYMAP) {
      this.keysymToKey.set(keysym, { keycode, shift: !!shift });
    }
  }

  keyForKeysym(keysym) {
    return this.keysymToKey.get(keysym) ?? null;
  }

  /** A child window's origin in root coordinates. */
  async translateCoordinates(window) {
    const buf = Buffer.alloc(16);
    buf.writeUInt8(Op.TranslateCoordinates, 0);
    buf.writeUInt16LE(4, 2);
    buf.writeUInt32LE(window, 4);
    buf.writeUInt32LE(this.rootWindow, 8);
    buf.writeInt16LE(0, 12);
    buf.writeInt16LE(0, 14);
    const rep = await this.send(buf, true);
    return { child: rep.readUInt32LE(8), x: rep.readInt16LE(12), y: rep.readInt16LE(14) };
  }

  /** SetInputFocus — the WM-less fallback so XTEST keys have a target. */
  async setInputFocus(window) {
    const buf = Buffer.alloc(12);
    buf.writeUInt8(42, 0); // SetInputFocus
    buf.writeUInt8(1, 1); // revert-to: PointerRoot
    buf.writeUInt16LE(3, 2);
    buf.writeUInt32LE(window, 4);
    buf.writeUInt32LE(0, 8); // CurrentTime
    await this.send(buf);
  }

  /* ------------------------------------------------------------ RandR ---- */

  #randrOpcode = 0;
  #randrConfigTimestamp = 0;

  async randrOpcode() {
    if (this.#randrOpcode === 0) {
      const { present, majorOpcode } = await this.queryExtension("RANDR");
      this.#randrOpcode = present ? majorOpcode : -1;
    }
    return this.#randrOpcode > 0 ? this.#randrOpcode : 0;
  }

  /** Active monitor layout via RandR 1.2 (RRGetScreenResourcesCurrent +
   *  RRGetCrtcInfo + RRGetOutputPrimary). Returns [] without RandR. */
  async getMonitors() {
    const ext = await this.randrOpcode();
    if (!ext) return [];
    try {
      // RRGetScreenResourcesCurrent (minor 25, per randrproto encoding)
      const req = Buffer.alloc(8);
      req.writeUInt8(ext, 0);
      req.writeUInt8(25, 1);
      req.writeUInt16LE(2, 2);
      req.writeUInt32LE(this.rootWindow, 4);
      const res = await this.send(req, true);
      this.#randrConfigTimestamp = res.readUInt32LE(12);
      const numCrtcs = res.readUInt16LE(16);
      const crtcs = [];
      for (let i = 0; i < numCrtcs; i++) {
        crtcs.push(res.readUInt32LE(32 + i * 4));
      }
      // RRGetOutputPrimary (minor 31) → xid
      const pReq = Buffer.alloc(8);
      pReq.writeUInt8(ext, 0);
      pReq.writeUInt8(31, 1);
      pReq.writeUInt16LE(2, 2);
      pReq.writeUInt32LE(this.rootWindow, 4);
      let primary = 0;
      try {
        const p = await this.send(pReq, true);
        primary = p.readUInt32LE(8);
      } catch {}

      const monitors = [];
      for (const crtc of crtcs) {
        // RRGetCrtcInfo (minor 20): reply carries timestamp, x/y/w/h, mode…
        const cReq = Buffer.alloc(12);
        cReq.writeUInt8(ext, 0);
        cReq.writeUInt8(20, 1);
        cReq.writeUInt16LE(3, 2);
        cReq.writeUInt32LE(crtc, 4);
        cReq.writeUInt32LE(this.#randrConfigTimestamp, 8);
        const info = await this.send(cReq, true);
        const mode = info.readUInt32LE(20);
        if (!mode) continue; // disabled crtc
        const numOutputs = info.readUInt16LE(28);
        const firstOutput = numOutputs ? info.readUInt32LE(32) : 0;
        monitors.push({
          x: info.readInt16LE(12),
          y: info.readInt16LE(14),
          w: info.readUInt16LE(16),
          h: info.readUInt16LE(18),
          primary: firstOutput === primary,
        });
      }
      return monitors;
    } catch {
      return []; // RandR shapes vary; the root union stays the source of truth
    }
  }

  /** SendEvent of a format-32 ClientMessage to the root window (EWMH).
   *  44-byte request: SendEvent header (12) + 32-byte event, where the
   *  ClientMessage event packs type(1) format(1) seq(2) window(4)
   *  message-type(4) data.l[5](20) with no pad. */
  async sendClientMessage(window, messageTypeAtom, data = [0, 0, 0, 0, 0]) {
    const buf = Buffer.alloc(44);
    buf.writeUInt8(Op.SendEvent, 0);
    buf.writeUInt8(1, 1); // propagate
    buf.writeUInt16LE(11, 2);
    buf.writeUInt32LE(this.rootWindow, 4); // destination
    buf.writeUInt32LE((1 << 19) | (1 << 20), 8); // SubstructureNotify|SubstructureRedirect
    buf.writeUInt8(33, 12); // ClientMessage
    buf.writeUInt8(32, 13); // format 32
    buf.writeUInt32LE(window, 16);
    buf.writeUInt32LE(messageTypeAtom, 20);
    for (let i = 0; i < 5; i++) buf.writeUInt32LE((data[i] ?? 0) >>> 0, 24 + i * 4);
    await this.send(buf);
  }

  close() {
    this.dead = true;
    this.failAll("X11 client closed");
    this.teardownSocket();
  }
}
