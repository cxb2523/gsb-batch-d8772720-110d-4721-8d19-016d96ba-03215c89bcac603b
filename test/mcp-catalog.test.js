/**
 * End-to-end: the REAL MCP server with the REAL paid catalog loaded.
 * Spawns `node src/cli.js mcp` with the repo's plugins/ dir (paid tree
 * present locally; a fresh clone without it skips cleanly — same rule as
 * test/plugins.test.js) and asserts the full capability surface is mounted.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
const PLUGINS = join(dirname(fileURLToPath(import.meta.url)), "..", "plugins");
const catalogPresent = existsSync(join(PLUGINS, "session-vault", "index.js"));

const EXPECTED_TOOLS = [
  "ax_vault", "ax_net", "ax_capture", "ax_challenge", "ax_auth", "ax_extract",
  "ax_guard", "ax_grid", "ax_editor", "ax_ats", "ax_enterprise", "ax_commerce",
  "ax_remote", "ax_places",
];

function startServer() {
  const proc = spawn(process.execPath, [CLI, "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
  const buffer = { text: "", waiters: [] };
  proc.stdout.on("data", (d) => {
    buffer.text += String(d);
    let i;
    while ((i = buffer.text.indexOf("\n")) >= 0) {
      const line = buffer.text.slice(0, i).trim();
      buffer.text = buffer.text.slice(i + 1);
      if (!line) continue;
      const w = buffer.waiters.shift();
      if (w) w(JSON.parse(line));
    }
  });
  return {
    proc,
    async call(msg) {
      const p = new Promise((resolve, reject) => {
        buffer.waiters.push(resolve);
        setTimeout(() => reject(new Error("MCP response timeout")), 45_000);
      });
      proc.stdin.write(JSON.stringify(msg) + "\n");
      return p;
    },
    end() {
      proc.kill();
      // Await the child's exit — the file cannot finish while the server's
      // async shutdown holds the stdio pipes open.
      return new Promise((resolve) => {
        if (proc.exitCode !== null) return resolve();
        proc.once("exit", () => resolve());
        setTimeout(resolve, 8_000);
      });
    },
  };
}

test("real MCP server + real catalog: every capability tool mounts; solve signposts honestly", { skip: !catalogPresent }, async (t) => {
  const srv = startServer();
  t.after(async () => { await srv.end(); });
  await srv.call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  srv.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await srv.call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = list.result.tools.map((x) => x.name);
  for (const expected of EXPECTED_TOOLS) {
    assert.ok(names.includes(expected), `${expected} missing from the real MCP surface (have: ${names.join(", ")})`);
  }
  // The solve surface also grew: provider enum includes the new capability slugs.
  const solve = list.result.tools.find((x) => x.name === "ax_solve_captcha");
  for (const slug of ["session", "net", "guard", "grid", "challenge", "auth", "extract", "commerce", "places", "remote-app", "editor", "ats", "enterprise-app", "downloads", "print"]) {
    assert.ok(solve.inputSchema.properties.provider.enum.includes(slug), `provider enum missing ${slug}`);
  }
  // The persona surface: a solve that launches its own browser launches a
  // coherent persona (egress + clock + language), not a bare box.
  for (const p of ["proxy", "timezone", "lang"]) {
    assert.ok(solve.inputSchema.properties[p], `ax_solve_captcha must accept {${p}}`);
  }

  // A capability solve on the real surface: the honest signpost, typed-free.
  const plugins = await srv.call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ax_plugins", arguments: {} } });
  const info = JSON.parse(plugins.result.content[0].text);
  // 14 spec plugins + captcha-pro (wave 0) = 15.
  assert.equal(info.loaded.length, 15);
  assert.deepEqual(info.failed, []);
  const withTools = info.loaded.filter((s) => s.tools?.length);
  assert.equal(withTools.length, 14, "captcha-pro has no tools() by design; the other 14 do");
});