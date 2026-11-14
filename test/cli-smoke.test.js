/**
 * Plugin CLI smoke tests — every plugin's own cli.js EXECUTED (they had only
 * ever been syntax-checked). Each runs its zero-risk op; with no license in
 * the environment the expected result is the typed LICENSE_INVALID JSON —
 * proving import + dispatch + gate wiring end to end. A stack crash
 * (non-JSON stderr) is the failure this test exists to catch.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGINS = join(HERE, "..", "plugins");
// Fresh public clones ship no paid tree (plugins/README.md only) — skip
// cleanly, same rule as test/plugins.test.js and test/mcp-catalog.test.js.
const paidPresent = existsSync(join(PLUGINS, "session-vault", "cli.js"));

const CLIS = [
  // [dir, args] — zero-risk ops only.
  ["session-vault", ["list"]],
  ["net-governor", ["report"]],
  ["challenge-handler", ["coverage"]],
  ["auth-bridge", ["status"]],
  ["portal-extractor", ["adapters"]],
  ["transaction-guard", ["ledger"]],
  ["virtual-grid-driver", ["model"]],
  ["rich-editor-driver", ["detect"]],
  ["ats-apply", ["detect"]],
  ["enterprise-app-driver", ["adapters"]],
  ["remote-app-driver", ["attach"]],
  ["places-extractor", ["search", "--query", "coffee", "--mode", "ui"]],
];

function runCli(cli, args, envOver = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [cli, ...args], {
      windowsHide: true,
      env: { ...process.env, AXUSE_PLUGINS: "", AXUSE_LICENSE: "", AXUSE_LICENSE_SESSION_VAULT: "", AXUSE_KEYCHAIN: "0", ...envOver },
    });
    let out = "", err = "", done = false;
    const timer = setTimeout(() => { if (!done) { done = true; try { p.kill(); } catch {} resolve({ status: null, stdout: out, stderr: err }); } }, 30_000);
    p.stdout.on("data", (d) => { out += String(d); });
    p.stderr.on("data", (d) => { err += String(d); });
    p.on("close", (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ status: code, stdout: out, stderr: err }); } });
  });
}

test("every plugin CLI executes: wired, licensed-gated, JSON-honest (no stack crashes)", { skip: !paidPresent }, async () => {
  const problems = [];
  const results = await Promise.all(CLIS.map(async ([dir, args]) => {
    const cli = join(PLUGINS, dir, "cli.js");
    if (!existsSync(cli)) return { dir, problem: "cli.js missing" };
    const r = await runCli(cli, args);
    return { dir, r };
  }));
  for (const { dir, r, problem } of results) {
    if (problem) { problems.push(`${dir}: ${problem}`); continue; }
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim();
    if (r.status === null) { problems.push(`${dir}: timed out`); continue; }
    if (/SyntaxError|ReferenceError|TypeError|Cannot find module|ERR_MODULE/.test(out)) {
      problems.push(`${dir}: crash — ${out.split("\n").slice(0, 2).join(" | ").slice(0, 160)}`);
      continue;
    }
    // Expected without a license: typed LICENSE_INVALID JSON (gate + wiring
    // proven). Errors print to stderr (exit != 0), results to stdout.
    const jsonish = (() => {
      for (const stream of [r.stdout, r.stderr]) {
        try { const j = JSON.parse(String(stream).trim()); if (j && typeof j === "object") return j; } catch {}
      }
      return null;
    })();
    if (!jsonish) {
      if (dir === "downloads-pdf" || dir === "commerce-operator") continue; // usage text, by design
      problems.push(`${dir}: no JSON result (stdout: ${String(r.stdout).slice(0, 100)})`);
      continue;
    }
    if (jsonish.code !== "LICENSE_INVALID" && jsonish.ok !== true) {
      problems.push(`${dir}: unexpected result ${JSON.stringify(jsonish).slice(0, 100)}`);
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("unlicensed --url invocations fail LICENSE_INVALID without launching a browser", async () => {
  const cases = [
    [join(PLUGINS, "ats-apply", "cli.js"), ["detect", "--url", "https://127.0.0.1:1/x"], "AXUSE_LICENSE_ATS_APPLY"],
    [join(PLUGINS, "virtual-grid-driver", "cli.js"), ["model", "--url", "https://127.0.0.1:1/x"], "AXUSE_LICENSE_VIRTUAL_GRID_DRIVER"],
  ];
  for (const [cli, args, gateVar] of cases) {
    if (!existsSync(cli)) continue;
    const r = await runCli(cli, args, { [gateVar]: "", AXUSE_LICENSE: "" });
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    assert.ok(out.includes("LICENSE_INVALID"), `${cli}: expected the typed license gate, got: ${out.slice(0, 100)}`);
    assert.ok(!/NAVIGATION_IN_PROGRESS|ERR_/.test(out), `${cli}: a browser was launched/navigated before the license gate`);
  }
});

test("downloads-pdf + commerce-operator CLIs reject bad usage with the usage line (no crash)", async () => {
  for (const dir of ["downloads-pdf", "commerce-operator"]) {
    const cli = join(PLUGINS, dir, "cli.js");
    if (!existsSync(cli)) continue;
    const r = await runCli(cli, []);
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim();
    assert.ok(!/SyntaxError|Cannot find module/.test(out), `${dir} crashed`);
    assert.notEqual(r.status, 0, `${dir} should reject empty usage`);
    // The license gate fires before usage validation on some CLIs — a typed
    // LICENSE_INVALID is equally proof of wiring; usage text is the other path.
    const jsonish = (() => { try { const j = JSON.parse(r.stderr.trim() || r.stdout.trim()); return j; } catch { return null; } })();
    assert.ok(
      jsonish?.code === "LICENSE_INVALID" || /usage|task|url/i.test(out),
      `${dir}: expected a usage hint or the typed license gate, got: ${out.slice(0, 80)}`,
    );
  }
});
