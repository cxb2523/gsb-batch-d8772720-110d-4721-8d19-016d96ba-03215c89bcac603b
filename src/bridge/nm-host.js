#!/usr/bin/env node
/**
 * axuse bridge — native messaging host.
 *
 * Chrome spawns this process when the extension calls connectNative()
 * (the manifest the installer wrote points here). Native messaging framing
 * on stdio is [4-byte LE length][UTF-8 JSON]; the hub speaks NDJSON lines.
 * This process is a dumb, robust relay between the two, plus the
 * authenticated hello to the hub (the extension never sees the token).
 *
 * Spawned via:
 *   - Windows: the batch launcher (axuse-nm.bat) → node nm-host.js
 *   - macOS/Linux: a shebang launcher script (exec node nm-host.js)
 */
import net from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { bridgeDir } from "./hub.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function die(msg) {
  process.stderr.write(`[axuse:nm-host] ${msg}\n`);
  process.exit(1);
}

let info;
try {
  info = JSON.parse(readFileSync(join(bridgeDir(), "bridge.json"), "utf8"));
} catch (e) {
  die(`no bridge info at ${join(bridgeDir(), "bridge.json")} — is the hub running? (axuse mcp starts it automatically; or run: axuse bridge)`);
}
if (!info || !info.port || !info.token) die("bridge info is malformed — restart the hub (axuse bridge).");

const sock = net.connect(info.port, "127.0.0.1");
sock.setNoDelay(true);
let hubBuf = "";

sock.on("connect", () => {
  // Authenticated hello first; then pure relay.
  sock.write(JSON.stringify({ t: "hello", role: "extension-host", token: info.token }) + "\n");
});

sock.on("data", (d) => {
  hubBuf += String(d);
  let i;
  while ((i = hubBuf.indexOf("\n")) >= 0) {
    const line = hubBuf.slice(0, i).trim();
    hubBuf = hubBuf.slice(i + 1);
    if (!line) continue;
    if (process.env.AXUSE_BRIDGE_DEBUG) {
      process.stderr.write(`[axuse:nm-host] hub→ ${line.slice(0, 300)}\n`);
    }
    writeNative(line); // hub → extension, framed
  }
});

sock.on("close", () => process.exit(0));
sock.on("error", () => process.exit(0));

// ---- native messaging framing on stdio ----

function writeNative(text) {
  const payload = Buffer.from(text, "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(payload.length, 0);
  process.stdout.write(Buffer.concat([head, payload]));
}

let stdinBuf = Buffer.alloc(0);

process.stdin.on("data", (d) => {
  stdinBuf = Buffer.concat([stdinBuf, d]);
  while (stdinBuf.length >= 4) {
    const len = stdinBuf.readUInt32LE(0);
    if (stdinBuf.length < 4 + len) break;
    const payload = stdinBuf.subarray(4, 4 + len).toString("utf8");
    stdinBuf = stdinBuf.subarray(4 + len);
    let msg;
    try {
      msg = JSON.parse(payload);
    } catch {
      if (process.env.AXUSE_BRIDGE_DEBUG) {
        process.stderr.write(`[axuse:nm-host] stdin JSON parse failed: ${payload.slice(0, 200)}\n`);
      }
      continue;
    }
    if (process.env.AXUSE_BRIDGE_DEBUG) {
      process.stderr.write(`[axuse:nm-host] ext→ ${payload.slice(0, 300)}\n`);
    }
    // The extension's own hello becomes ext-hello for the hub/backend.
    if (msg && msg.t === "hello") {
      msg = { t: "ext-hello", ext: msg.ext, ua: msg.ua };
    }
    sock.write(JSON.stringify(msg) + "\n");
  }
});

process.stdin.on("end", () => process.exit(0)); // Chrome closed the port (SW died)
process.stdin.on("error", () => process.exit(0));

// Never let a stray exception kill the relay silently.
process.on("uncaughtException", (e) => {
  process.stderr.write(`[axuse:nm-host] ${e && e.stack ? e.stack : e}\n`);
});
