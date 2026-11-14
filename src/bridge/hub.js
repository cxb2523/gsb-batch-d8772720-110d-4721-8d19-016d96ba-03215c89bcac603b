/**
 * axuse bridge hub.
 *
 * Lineage: Codex's side-panel ↔ app-server transport (localhost socket +
 * version handshake + the native-messaging port as the extension link).
 * The hub is the rendezvous point: Chrome spawns the native-messaging host
 * (nm-host.js) when the extension connects; the host dials the hub; the
 * axuse backend (in this or another process) drives the extension over the
 * same socket. NDJSON lines; token auth; ext-online/offline status events.
 *
 * Two deployment shapes, one API (`rpc`, `onEvent`, `extOnline`, `waitExt`):
 *   - BridgeHub  (server): started in-process by the controller, or
 *                standalone via `axuse bridge` (survives MCP restarts).
 *   - BridgeClient: used when an external hub is already running.
 */
import net from "node:net";
import { randomBytes, createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AxError, Codes } from "../core/errors.js";

const PING_MS = 20_000; // keeps the MV3 service worker alive
const RPC_TIMEOUT_MS = 30_000;

export function bridgeDir() {
  const override = process.env.AXUSE_BRIDGE_DIR?.trim();
  if (override) return resolve(override);
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? homedir(), "axuse");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "axuse");
  }
  return join(process.env.XDG_RUNTIME_DIR ?? join(homedir(), ".cache"), "axuse");
}

/** The bridge info file carries the hub auth token: the owner-only mode is
 *  enforced on POSIX (mkdir 0700 for the dir, chmod 0600 for the file), and
 *  pre-existing wider modes are tightened. Windows ACLs already scope
 *  %LOCALAPPDATA% to the user. */
function secureBridgePaths(dir, file) {
  if (process.platform === "win32") return;
  try {
    const st = statSync(dir);
    if (st.isDirectory() && (st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  } catch {}
  try {
    const st = statSync(file);
    if (st.isFile() && (st.mode & 0o077) !== 0) chmodSync(file, 0o600);
  } catch {}
}

export function infoPath() {
  return join(bridgeDir(), "bridge.json");
}

export function readInfo() {
  try {
    return JSON.parse(readFileSync(infoPath(), "utf8"));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function offlineError() {
  return new AxError(Codes.ATTACH_FAILED,
    "The axuse extension is not connected (no browser running, extension not loaded, or hub unreachable).",
    {
      hint: "Run `axuse bridge install`, then launch Chrome normally with the axuse bridge extension loaded (unpacked). The service worker connects automatically.",
      retry: "retry",
    });
}

/** Server-side hub. */
export class BridgeHub {
  constructor() {
    this.server = null;
    this.port = null;
    this.token = null;
    this.extConn = null;
    this.clients = new Set();
    this.reqSeq = 0;
    this.pending = new Map(); // id → {resolve(msg), timer}
    this.eventHandlers = new Set();
    this.pingTimer = null;
  }

  async start() {
    mkdirSync(bridgeDir(), { recursive: true, mode: 0o700 });
    this.token = randomBytes(16).toString("hex");
    this.server = net.createServer((sock) => this.onConnection(sock));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    this.port = this.server.address().port;
    // The info file is how the native-messaging host (spawned by Chrome)
    // finds the hub: {port, token, pid}.
    writeFileSync(infoPath(), JSON.stringify({ port: this.port, token: this.token, pid: process.pid, ts: Date.now() }, null, 2));
    secureBridgePaths(bridgeDir(), infoPath());
    this.pingTimer = setInterval(() => {
      if (this.extConn) this.writeTo(this.extConn.sock, { t: "ping" });
    }, PING_MS);
    if (this.pingTimer.unref) this.pingTimer.unref();
    return this;
  }

  stop() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const [, p] of this.pending) { clearTimeout(p.timer); }
    this.pending.clear();
    for (const c of this.clients) { try { c.sock.destroy(); } catch {} }
    this.clients.clear();
    if (this.extConn) { try { this.extConn.sock.destroy(); } catch {} this.extConn = null; }
    try { this.server.close(); } catch {}
    try { writeFileSync(infoPath(), ""); } catch {}
  }

  writeTo(sock, obj) {
    try { sock.write(JSON.stringify(obj) + "\n"); } catch {}
  }

  onConnection(sock) {
    let authed = false;
    let role = null;
    let buffer = "";
    const conn = { sock, role, write: (o) => this.writeTo(sock, o) };
    sock.setNoDelay(true);
    sock.on("data", (d) => {
      buffer += String(d);
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { sock.destroy(); return; }
        if (!authed) {
          if (msg && msg.t === "hello" && msg.token === this.token &&
              (msg.role === "extension-host" || msg.role === "client")) {
            authed = true;
            conn.role = msg.role;
            if (msg.role === "extension-host") {
              if (this.extConn && this.extConn.sock !== sock) {
                // Superseded connection: fail in-flight requests immediately
                // instead of letting them hang to a timeout.
                for (const [, p] of this.pending) {
                  clearTimeout(p.timer);
                  p.reject(new AxError(Codes.ATTACH_FAILED,
                    "Extension connection was replaced mid-request (SW restart). Retry the command.",
                    { retry: "retry" }));
                }
                this.pending.clear();
                try { this.extConn.sock.destroy(); } catch {}
              }
              this.extConn = conn;
              this.writeTo(sock, { t: "hello-ack", ok: true });
              this.broadcastStatus();
              for (const h of this.eventHandlers) { try { h({ kind: "ext-online" }); } catch {} }
            } else {
              conn.openedTabs = new Set();
              this.clients.add(conn);
              this.writeTo(sock, { t: "hello-ack", ok: true, ext: !!this.extConn });
            }
          } else {
            this.writeTo(sock, { t: "hello-ack", ok: false, error: "bad token or role" });
            sock.destroy();
            return;
          }
          continue;
        }
        if (conn.role === "extension-host") this.onFromExt(msg);
        else this.onFromClient(conn, msg);
      }
    });
    sock.on("close", () => {
      if (conn.role === "client") {
        this.clients.delete(conn);
        // A client process that went away (MCP server killed, agent run
        // ended) leaves tabs nobody holds an id for: close them.
        for (const tabId of conn.openedTabs ?? []) {
          void this.rpc("close_tab", { tabId }, 5000).catch(() => {});
        }
      }
      if (this.extConn === conn) {
        this.extConn = null;
        this.broadcastStatus();
        for (const h of this.eventHandlers) { try { h({ kind: "ext-offline" }); } catch {} }
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(offlineError());
        }
        this.pending.clear();
      }
    });
    sock.on("error", () => {});
  }

  broadcastStatus() {
    for (const c of this.clients) c.write({ t: "status", ext: !!this.extConn });
  }

  onFromExt(msg) {
    if (!msg || typeof msg !== "object") return;
    if (process.env.AXUSE_BRIDGE_DEBUG) {
      process.stderr.write(`[axuse:hub] ext→ ${JSON.stringify(msg).slice(0, 300)}\n`);
    }
    if (msg.t === "res") {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve({ ok: !!msg.ok, result: msg.result, error: msg.error });
      } else if (process.env.AXUSE_BRIDGE_DEBUG) {
        process.stderr.write(`[axuse:hub] res for unknown id ${msg.id} (stale?)\n`);
      }
    } else if (msg.t === "evt") {
      const event = { sessionId: String(msg.tabId), method: msg.method, params: msg.params ?? {} };
      for (const h of this.eventHandlers) { try { h(event); } catch {} }
      for (const c of this.clients) c.write({ t: "evt", ...msg });
    } else if (msg.t === "ext-hello") {
      for (const c of this.clients) c.write({ t: "ext-hello", ...msg });
    }
    // "pong" ignored (keepalive reply)
  }

  async onFromClient(conn, msg) {
    if (!msg || msg.t !== "req") return;
    try {
      const res = await this.rpc(msg.method, msg.params);
      if (res.ok && msg.method === "open_tab" && res.result?.tabId != null) conn.openedTabs?.add(res.result.tabId);
      if (msg.method === "close_tab") conn.openedTabs?.delete(msg.params?.tabId);
      conn.write({ t: "res", id: msg.id, ok: res.ok, result: res.result, error: res.error });
    } catch (e) {
      conn.write({ t: "res", id: msg.id, ok: false, error: e instanceof AxError ? e.toJSON() : { code: Codes.INTERNAL, message: String(e.message ?? e) } });
    }
  }

  /** In-process request to the extension (client requests route through it). */
  rpc(method, params, timeoutMs = RPC_TIMEOUT_MS) {
    if (!this.extConn) return Promise.reject(offlineError());
    const id = "h" + ++this.reqSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AxError(Codes.TIMEOUT, `bridge rpc "${method}" timed out`, { retry: "retry" }));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (res) => resolve(res),
        reject,
        timer,
      });
      this.writeTo(this.extConn.sock, { t: "req", id, method, params });
    });
  }

  onEvent(handler) {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  extOnline() {
    return !!this.extConn;
  }

  async waitExt(timeoutMs = 20_000) {
    const t0 = Date.now();
    while (!this.extConn) {
      if (Date.now() - t0 > timeoutMs) throw offlineError();
      await new Promise((r) => setTimeout(r, 250));
    }
    return true;
  }
}

/** Client to an already-running standalone hub. Same surface as BridgeHub. */
export class BridgeClient {
  constructor() {
    this.sock = null;
    this.seq = 0;
    this.pending = new Map();
    this.eventHandlers = new Set();
    this.online = false;
  }

  async connect(info, timeoutMs = 5000) {
    const sock = net.connect(info.port, "127.0.0.1");
    this.sock = sock;
    sock.setNoDelay(true);
    let buffer = "";
    let authed = false;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { sock.destroy(); reject(new AxError(Codes.ATTACH_FAILED, "hub connect/handshake timed out")); }, timeoutMs);
      sock.once("connect", () => {
        sock.write(JSON.stringify({ t: "hello", role: "client", token: info.token }) + "\n");
      });
      sock.once("error", (e) => {
        clearTimeout(timer);
        reject(new AxError(Codes.ATTACH_FAILED, `hub connect failed: ${e.message}`));
      });
      sock.on("data", (d) => {
        buffer += String(d);
        let i;
        while ((i = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, i).trim();
          buffer = buffer.slice(i + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (!authed) {
            if (msg.t === "hello-ack" && msg.ok) {
              authed = true;
              this.online = !!msg.ext;
              clearTimeout(timer);
              resolve();
            } else if (msg.t === "hello-ack") {
              clearTimeout(timer);
              sock.destroy();
              reject(new AxError(Codes.ATTACH_FAILED, `hub auth failed: ${msg.error}`));
            }
            continue;
          }
          this.onMessage(msg);
        }
      });
    });
    return this;
  }

  onMessage(msg) {
    if (msg.t === "res") {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve({ ok: !!msg.ok, result: msg.result, error: msg.error });
      }
    } else if (msg.t === "evt") {
      const event = { sessionId: String(msg.tabId), method: msg.method, params: msg.params ?? {} };
      for (const h of this.eventHandlers) { try { h(event); } catch {} }
    } else if (msg.t === "status") {
      this.online = !!msg.ext;
      for (const h of this.eventHandlers) { try { h({ kind: msg.ext ? "ext-online" : "ext-offline" }); } catch {} }
    }
  }

  rpc(method, params, timeoutMs = RPC_TIMEOUT_MS) {
    const id = "c" + ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AxError(Codes.TIMEOUT, `bridge rpc "${method}" timed out`, { retry: "retry" }));
      }, timeoutMs);
      this.pending.set(id, { resolve: (res) => resolve(res), reject, timer });
      this.sock.write(JSON.stringify({ t: "req", id, method, params }) + "\n");
    });
  }

  onEvent(handler) {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  extOnline() {
    return this.online;
  }

  close() {
    for (const [, p] of this.pending) clearTimeout(p.timer);
    this.pending.clear();
    try { this.sock?.destroy(); } catch {}
    this.sock = null;
    this.online = false;
  }

  async waitExt(timeoutMs = 20_000) {
    const t0 = Date.now();
    while (!this.online) {
      if (Date.now() - t0 > timeoutMs) throw offlineError();
      await new Promise((r) => setTimeout(r, 250));
    }
    return true;
  }
}

let cachedBridge = null;

/** Get the bridge: an external hub if one is alive, else start one here. */
export async function getBridge() {
  if (cachedBridge) return cachedBridge;
  const info = readInfo();
  if (info && info.port && info.token && info.pid && pidAlive(info.pid) && info.pid !== process.pid) {
    // Opportunistically tighten a pre-existing info file (token hygiene).
    secureBridgePaths(bridgeDir(), infoPath());
    try {
      const client = await new BridgeClient().connect(info, 3000);
      cachedBridge = client;
      return cachedBridge;
    } catch { /* fall through: start our own */ }
  }
  const hub = await new BridgeHub().start();
  cachedBridge = hub;
  return hub;
}

/** Test/tool hook: forget the cached bridge so the next getBridge() starts
 *  fresh (stops nothing — the caller owns the previous instance's lifecycle). */
export function __resetBridgeForTests() {
  cachedBridge = null;
}

/** For the CLI's standalone mode. */
export async function runStandaloneHub() {  const info = readInfo();
  if (info && info.pid && pidAlive(info.pid) && info.pid !== process.pid) {
    console.log(`axuse bridge: another hub is already running (pid ${info.pid}, port ${info.port}) — this process will exit.`);
    return;
  }
  const hub = await new BridgeHub().start();
  console.log(`axuse bridge: hub listening on 127.0.0.1:${hub.port} (info: ${infoPath()})`);
  console.log("Waiting for the axuse extension to connect (load it in Chrome and it dials in automatically).");
  hub.onEvent((e) => {
    if (e.kind === "ext-online") console.log("axuse bridge: extension connected.");
    if (e.kind === "ext-offline") console.log("axuse bridge: extension disconnected.");
  });
  await new Promise(() => {}); // run until killed
}
