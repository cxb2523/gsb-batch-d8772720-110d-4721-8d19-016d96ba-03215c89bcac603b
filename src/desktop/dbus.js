/**
 * axuse — minimal zero-dependency D-Bus client (AT-SPI desktop layer).
 *
 * The macOS driver gets its platform AX tree from System Events over JXA;
 * Linux exposes the same thing — AT-SPI2 — over D-Bus at a Unix socket.
 * Node ships no D-Bus client, so this speaks the wire protocol directly:
 *
 *   - SASL EXTERNAL handshake (uid cookie — the standard user-bus auth)
 *   - Hello(), then method_call / method_return / error routing by serial
 *   - a general little-endian marshaller for the type grammar used by the
 *     AT-SPI interfaces: basics (y b n q i u x t d s o g), arrays, structs,
 *     variants and dict entries, with the alignment rules from the spec
 *
 * Scope: method calls + property access on the AT-SPI bus. No signals, no
 * file-descriptor passing, no peer-to-peer container gymnastics.
 */
import { connect as netConnect } from "node:net";
import { userInfo } from "node:os";
import { AxError, Codes } from "../core/errors.js";

const LITTLE = 0x6c; // 'l'

const MSG_METHOD_CALL = 1;
const MSG_METHOD_RETURN = 2;
const MSG_ERROR = 3;

// Header field codes.
const FIELD_PATH = 1, FIELD_INTERFACE = 2, FIELD_MEMBER = 3,
  FIELD_ERROR_NAME = 4, FIELD_REPLY_SERIAL = 5, FIELD_DESTINATION = 6,
  FIELD_SENDER = 7, FIELD_SIGNATURE = 8;

/* ------------------------------------------------------- type marshalling */

class Writer {
  constructor() {
    this.chunks = [];
    this.length = 0;
    this.alignBuf = { 1: Buffer.from([0]), 2: Buffer.alloc(2), 4: Buffer.alloc(4), 8: Buffer.alloc(8) };
  }
  push(buf) {
    this.chunks.push(buf);
    this.length += buf.length;
  }
  align(n) {
    const pad = (n - (this.length % n)) % n;
    if (pad) this.push(Buffer.alloc(pad));
  }
  byte(v) { this.align(1); this.push(Buffer.from([v & 0xff])); }
  bool(v) { this.align(4); this.push(Buffer.from([v ? 1 : 0, 0, 0, 0])); }
  u16(v) { this.align(2); const b = Buffer.alloc(2); b.writeUInt16LE(v); this.push(b); }
  i16(v) { this.align(2); const b = Buffer.alloc(2); b.writeInt16LE(v); this.push(b); }
  u32(v) { this.align(4); const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); this.push(b); }
  i32(v) { this.align(4); const b = Buffer.alloc(4); b.writeInt32LE(v | 0); this.push(b); }
  u64(v) { this.align(8); const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); this.push(b); }
  string(v) {
    const s = Buffer.from(String(v), "utf8");
    this.u32(s.length);
    this.push(s);
    this.push(Buffer.from([0]));
  }
  signature(v) {
    const s = Buffer.from(String(v), "utf8");
    if (s.length > 255) throw new Error("signature too long");
    this.byte(s.length);
    this.push(s);
    this.push(Buffer.from([0]));
  }
  /** Write one value of the given single-complete-type signature. */
  value(sig, v) {
    switch (sig) {
      case "y": return this.byte(v);
      case "b": return this.bool(v);
      case "n": return this.i16(v);
      case "q": return this.u16(v);
      case "i": return this.i32(v);
      case "u": return this.u32(v);
      case "x": case "t": return this.u64(v);
      case "d": {
        this.align(8);
        const b = Buffer.alloc(8);
        b.writeDoubleLE(Number(v));
        this.push(b);
        return;
      }
      case "s": return this.string(v);
      case "o": return this.string(v);
      case "g": return this.signature(v);
      case "v": {
        const inner = v ?? { sig: "s", value: "" };
        this.signature(inner.sig);
        return this.value(inner.sig, inner.value);
      }
    }
    if (sig.startsWith("a")) {
      const elem = sig.slice(1);
      const body = new Writer();
      const elemAlign = alignmentOf(elem);
      for (const item of Array.isArray(v) ? v : []) {
        body.align(elemAlign); // every element starts at its alignment
        body.value(elem, item);
      }
      const bytes = body.finish();
      this.u32(bytes.length);
      this.align(elemAlign);
      return this.push(bytes);
    }
    if (sig.startsWith("(") || sig.startsWith("{")) {
      const inner = sig.slice(1, -1);
      this.align(8);
      if (sig.startsWith("{")) {
        // Dict entries are written as {key, value} objects (the reader's shape).
        const obj = Array.isArray(v) ? { key: v[0], value: v[1] } : v;
        return this.writeValues(inner, [obj?.key, obj?.value]);
      }
      return this.writeValues(inner, Array.isArray(v) ? v : []);
    }
    throw new Error(`unsupported D-Bus signature: ${sig}`);
  }
  /** Write a sequence of values for a multi-type signature ("is", "a(so)"…). */
  writeValues(sig, values) {
    let vi = 0;
    for (const [type] of splitSignature(sig)) {
      this.value(type, values[vi++]);
    }
  }
  finish() {
    return Buffer.concat(this.chunks);
  }
}

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  align(n) {
    this.pos += (n - (this.pos % n)) % n;
  }
  byte() { this.align(1); return this.buf[this.pos++]; }
  u16() { this.align(2); const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; }
  i16() { this.align(2); const v = this.buf.readInt16LE(this.pos); this.pos += 2; return v; }
  u32() { this.align(4); const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  i32() { this.align(4); const v = this.buf.readInt32LE(this.pos); this.pos += 4; return v; }
  u64() { this.align(8); const v = this.buf.readBigUInt64LE(this.pos); this.pos += 8; return Number(v); }
  string() {
    const len = this.u32();
    const s = this.buf.toString("utf8", this.pos, this.pos + len);
    this.pos += len + 1;
    return s;
  }
  signature() {
    const len = this.byte();
    const s = this.buf.toString("latin1", this.pos, this.pos + len);
    this.pos += len + 1;
    return s;
  }
  value(sig) {
    switch (sig) {
      case "y": return this.byte();
      case "b": { this.align(4); const v = this.u32(); return !!v; }
      case "n": return this.i16();
      case "q": return this.u16();
      case "i": return this.i32();
      case "u": return this.u32();
      case "x": case "t": return this.u64();
      case "d": { this.align(8); const v = this.buf.readDoubleLE(this.pos); this.pos += 8; return v; }
      case "s": case "o": return this.string();
      case "g": return this.signature();
      case "v": {
        const inner = this.signature();
        return { sig: inner, value: this.value(inner) };
      }
    }
    if (sig.startsWith("a")) {
      const elem = sig.slice(1);
      const len = this.u32();
      this.align(alignmentOf(elem));
      const end = this.pos + len;
      const out = [];
      // Guard against malformed lengths from hostile peers.
      if (end > this.buf.length + 8) throw new Error("bad array length in D-Bus message");
      while (this.pos < end) {
        out.push(this.value(elem));
        this.align(alignmentOf(elem)); // elements restart at their alignment
      }
      this.pos = end;
      return out;
    }
    if (sig.startsWith("(") || sig.startsWith("{")) {
      this.align(8);
      const inner = sig.slice(1, -1);
      const types = splitSignature(inner);
      const out = [];
      for (const [type] of types) out.push(this.value(type));
      return sig.startsWith("(") ? out : { key: out[0], value: out[1] };
    }
    throw new Error(`unsupported D-Bus signature while reading: ${sig}`);
  }
  values(sig) {
    const out = [];
    for (const [type] of splitSignature(sig)) out.push(this.value(type));
    return out;
  }
}

/** Split a signature into its top-level single-complete types. */
function splitSignature(sig) {
  const out = [];
  let i = 0;
  while (i < sig.length) {
    const start = i;
    let depth = 0;
    // Consume one complete type.
    for (;;) {
      const c = sig[i];
      if (c === "a") { i++; continue; }
      if (c === "(" || c === "{") { depth++; i++; continue; }
      if (c === ")" || c === "}") { depth--; i++; if (depth === 0) break; continue; }
      i++;
      if (depth === 0) break;
    }
    out.push([sig.slice(start, i)]);
  }
  return out;
}

function alignmentOf(sig) {
  if (sig.startsWith("a")) return alignmentOf(sig.slice(1));
  if (sig.startsWith("(") || sig.startsWith("{")) return 8;
  switch (sig) {
    case "y": case "g": return 1;
    case "n": case "q": return 2;
    case "b": case "i": case "u": case "s": case "o": return 4;
    case "x": case "t": case "d": case "v": return 8;
    default: return 1;
  }
}

/** Marshal a single value of `sig` (for tests and future direct users). */
export function marshalValue(sig, value) {
  const w = new Writer();
  w.value(sig, value);
  return w.finish();
}

/** Unmarshal a single value of `sig`; `offset` positions the reader
 *  (alignment is relative to the buffer + offset, like a message body). */
export function unmarshalValue(sig, buf, offset = 0) {
  const r = new Reader(buf);
  r.pos = offset;
  return r.value(sig);
}

/* ------------------------------------------------------------ connection */

/** Parse a D-Bus address like unix:path=/run/user/1000/bus. */
export function parseDbusAddress(address) {
  const m = /^unix:(path=[^,]+|abstract=[^,]+)/.exec(String(address ?? ""));
  if (!m) return null;
  const [, kv] = m;
  const [k, v] = kv.split("=");
  return k === "path" ? { path: v } : { abstract: v };
}

const MSG_TIMEOUT_MS = 12_000;

export class DbusClient {
  /**
   * @param {string} address D-Bus server address (unix:path=…)
   */
  constructor(address) {
    this.address = address;
    this.socket = null;
    this.serial = 0;
    this.pending = new Map(); // serial → {resolve, reject, timer}
    this.buffer = Buffer.alloc(0);
    this.dead = false;
  }

  async connect() {
    const parsed = parseDbusAddress(this.address);
    if (!parsed) {
      throw new AxError(Codes.DESKTOP_DRIVER_UNAVAILABLE,
        `Cannot parse D-Bus address: ${this.address}`,
        { retry: "never" });
    }
    this.socket = await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        // Never leave a half-created socket dangling on the event loop.
        try { sock.destroy(); } catch {}
        reject(new Error("D-Bus socket connect timed out"));
      }, 5_000);
      const sock = parsed.path !== undefined
        ? netConnect(parsed.path)
        : netConnect(`\0${parsed.abstract}`);
      sock.once("error", (e) => { clearTimeout(t); try { sock.destroy(); } catch {} reject(e); });
      sock.once("connect", () => { clearTimeout(t); sock.off("error", reject); resolve(sock); });
    });
    this.socket.on("close", () => this.failAll("D-Bus connection closed"));
    this.socket.on("error", () => this.failAll("D-Bus connection error"));

    // SASL EXTERNAL: leading NUL (needed on the transport), then the cookie.
    // BEGIN has NO reply — the next server bytes are already D-Bus messages,
    // so the message listeners attach only after the handshake completes.
    const uidHex = Buffer.from(String(userInfo().uid)).toString("hex");
    try {
      await this.sasl(`\0AUTH EXTERNAL ${uidHex}\r\n`, /^OK /);
    } catch (e) {
      try { this.socket.destroy(); } catch {}
      this.socket = null;
      throw e;
    }
    this.socket.write("BEGIN\r\n");
    this.socket.on("data", (d) => this.route(d));
    await this.call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "Hello", "", []);
    return this;
  }

  /** One SASL line exchange (BEFORE message framing starts), time-bounded:
   *  a wedged daemon must not dangle the socket on the event loop. */
  async sasl(request, expect) {
    const reply = await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        cleanup();
        try { this.socket?.destroy(); } catch {}
        reject(new Error("D-Bus SASL handshake timed out"));
      }, 5_000);
      let buf = "";
      const onData = (d) => {
        buf += d.toString("latin1");
        const i = buf.indexOf("\r\n");
        if (i >= 0) {
          clearTimeout(t);
          cleanup();
          resolve(buf.slice(0, i));
        }
      };
      const onErr = (e) => { clearTimeout(t); cleanup(); reject(e); };
      const cleanup = () => {
        this.socket?.off("data", onData);
        this.socket?.off("error", onErr);
      };
      this.socket.on("data", onData);
      this.socket.on("error", onErr);
      this.socket.write(request);
    });
    if (expect && !expect.test(reply)) {
      throw new AxError(Codes.DESKTOP_DRIVER_UNAVAILABLE,
        `D-Bus SASL handshake failed: ${reply.trim()}`,
        { retry: "never" });
    }
    return reply;
  }

  route(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 16) return;
      // Header "yyyyuua(yv)": [4..8) body length, [8..12) serial,
      // [12..16) fields-array length; elements start at 16 (8-aligned).
      const bodyLen = this.buffer.readUInt32LE(4);
      const arrLen = this.buffer.readUInt32LE(12);
      const headerLen = 16 + arrLen + ((8 - ((16 + arrLen) % 8)) % 8);
      const total = headerLen + bodyLen;
      if (this.buffer.length < total) return;
      const msg = Buffer.from(this.buffer.subarray(0, total));
      this.buffer = this.buffer.subarray(total);
      this.dispatch(msg, headerLen, arrLen);
    }
  }

  dispatch(msg, bodyStart, arrLen) {
    const type = msg[1];
    // Fields elements span [16, 16+arrLen) — the u32 length prefix sits at
    // 12..16 and the elements start 8-aligned at 16.
    const reader = new Reader(msg.subarray(16));
    let replySer = null, errorName = null, sig = "";
    try {
      const end = arrLen;
      for (;;) {
        if (reader.pos >= end) break;
        reader.align(8); // each (yv) struct element is 8-aligned
        const code = reader.byte();
        const v = reader.value("v");
        if (code === FIELD_REPLY_SERIAL) replySer = v.value;
        else if (code === FIELD_ERROR_NAME) errorName = String(v.value);
        else if (code === FIELD_SIGNATURE) sig = String(v.value);
      }
    } catch {
      return; // unparseable header — drop
    }
    const p = replySer !== null ? this.pending.get(replySer) : null;
    if (!p) return;
    this.pending.delete(replySer);
    clearTimeout(p.timer);
    if (type === MSG_ERROR) {
      const body = new Reader(msg.subarray(bodyStart));
      p.reject(new AxError(Codes.DESKTOP_OP_FAILED,
        `D-Bus error: ${errorName ?? "unknown"}${sig ? ` (${body.value("s")})` : ""}`,
        { retry: "retry" }));
      return;
    }
    if (type === MSG_METHOD_RETURN) {
      const body = new Reader(msg.subarray(bodyStart));
      p.resolve(sig ? body.values(sig) : []);
    }
    // Signals (type 4) are ignored — v1 polls.
  }

  failAll(reason) {
    this.dead = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new AxError(Codes.DESKTOP_OP_FAILED, reason));
    }
    this.pending.clear();
  }

  /**
   * Method call. `argsSig` is the argument signature, `args` the values.
   * Resolves with the array of reply values.
   */
  call(destination, path, iface, member, argsSig, args) {
    if (!this.socket || this.dead) {
      return Promise.reject(new AxError(Codes.DESKTOP_OP_FAILED, "D-Bus connection is not open"));
    }
    const serial = ++this.serial;
    const body = new Writer();
    if (argsSig) body.writeValues(argsSig, args);
    const bodyBytes = body.finish();

    // Header "yyyyuua(yv)": [4..8) body length, [8..12) serial,
    // [12..16) fields-array length, elements from 16 (8-aligned),
    // header padded to a multiple of 8 before the body.
    const fields = new Writer();
    const field = (code, sig, value) => {
      fields.align(8); // struct element alignment
      fields.byte(code);
      fields.value("v", { sig, value });
    };
    field(FIELD_PATH, "o", path);
    field(FIELD_DESTINATION, "s", destination);
    field(FIELD_INTERFACE, "s", iface);
    field(FIELD_MEMBER, "s", member);
    if (argsSig) field(FIELD_SIGNATURE, "g", argsSig);
    const fieldsBytes = fields.finish();

    const head = Buffer.alloc(16);
    head[0] = LITTLE;
    head[1] = MSG_METHOD_CALL;
    head[2] = 0; // flags
    head[3] = 1; // protocol version
    head.writeUInt32LE(bodyBytes.length, 4);
    head.writeUInt32LE(serial, 8);
    head.writeUInt32LE(fieldsBytes.length, 12);
    const headerPad = (8 - ((16 + fieldsBytes.length) % 8)) % 8;
    const msg = Buffer.concat([
      head,
      fieldsBytes,
      Buffer.alloc(headerPad),
      bodyBytes,
    ]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(serial);
        reject(new AxError(Codes.TIMEOUT, `D-Bus call ${iface}.${member} timed out after ${MSG_TIMEOUT_MS}ms`, { retry: "retry" }));
      }, MSG_TIMEOUT_MS);
      this.pending.set(serial, { resolve, reject, timer });
      this.socket.write(msg);
    });
  }

  /** org.freedesktop.DBus.Properties.Get — returns the variant value. */
  async prop(destination, path, iface, name) {
    const [variant] = await this.call(destination, path, "org.freedesktop.DBus.Properties", "Get", "ss", [iface, name]);
    return variant?.value;
  }

  close() {
    this.dead = true;
    this.failAll("D-Bus client closed");
    try { this.socket?.end(); } catch {}
    try { this.socket?.destroy(); } catch {}
    this.socket = null;
  }
}
