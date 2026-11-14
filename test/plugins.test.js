/**
 * Premium plugin catalog harness.
 *
 * The paid tree under plugins/ is gitignored (never part of the open repo):
 * every entry below is conditional — a fresh clone without the paid packages
 * simply skips; a checkout that HAS them runs their offline unit suites in
 * child processes (env isolation per package: each plugin owns its env
 * namespace) plus one whole-catalog loader test.
 *
 * Live acceptance gates live inside each plugin's own test files and
 * self-gate on AXUSE_TEST_LIVE_<PKG>=1 (plus a located browser) — the same
 * pattern as test/plugin.test.js.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSolvers } from "../src/plugins/index.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PLUGINS = join(HERE, "..", "plugins");

/** The build-order catalog (ENGINEERING-PROMPT waves 1-4). */
const CATALOG = [
  { id: "session-vault", pkg: "VAULT" },
  { id: "net-governor", pkg: "NET" },
  { id: "downloads-pdf", pkg: "DLP" },
  { id: "challenge-handler", pkg: "CHALLENGE" },
  { id: "auth-bridge", pkg: "AUTH" },
  { id: "portal-extractor", pkg: "EXTRACT" },
  { id: "transaction-guard", pkg: "GUARD" },
  { id: "virtual-grid-driver", pkg: "GRID" },
  { id: "rich-editor-driver", pkg: "EDITOR" },
  { id: "ats-apply", pkg: "ATS" },
  { id: "enterprise-app-driver", pkg: "EA" },
  { id: "commerce-operator", pkg: "COMMERCE" },
  { id: "remote-app-driver", pkg: "REMOTE" },
  { id: "places-extractor", pkg: "PLACES" },
];

test("catalog: the paid shared library's own gates pass (curve, ledger, license, vision)", () => {
  const dir = join(PLUGINS, "_shared");
  if (!existsSync(join(dir, "test"))) return; // fresh clone: no paid tree
  const r = run(["--test", "test/*.test.js"], dir);
  assert.equal(r.status, 0, r.output);
});

test("catalog: every present plugin loads with zero loader errors (ABI + tools validated)", async () => {
  if (!existsSync(PLUGINS)) return; // fresh clone
  const { solvers, errors } = await loadSolvers();
  assert.deepEqual(errors, [], JSON.stringify(errors));
  const seenIds = solvers.map((s) => s.id);
  assert.deepEqual(new Set(seenIds).size, seenIds.length, "duplicate plugin ids");
  // If a plugin dir exists locally, it must have loaded.
  for (const { id } of CATALOG) {
    if (existsSync(join(PLUGINS, id, "index.js"))) {
      assert.ok(seenIds.includes(id), `${id} exists under plugins/ but did not load`);
    }
  }
  // The shared library is never a plugin (R0: `_`-prefixed dirs are skipped).
  assert.ok(!seenIds.includes("_shared"));
});

for (const { id } of CATALOG) {
  test(`catalog: ${id} offline unit suite`, () => {
    const dir = join(PLUGINS, id);
    if (!existsSync(join(dir, "index.js"))) {
      return; // paid package not installed locally — skip cleanly
    }
    assert.ok(existsSync(join(dir, "test")), `${id} ships no tests`);
    assert.ok(existsSync(join(dir, "README.md")), `${id} ships no README`);
    const r = run(["--test", "test/*.test.js"], dir);
    assert.equal(r.status, 0, `${id} unit suite failed:\n${r.output}`);
  });
}

/** Run `node --test` in a child process, capturing merged output.
 *  AXUSE_KEYCHAIN=0 severs the macOS Keychain fallback so unit suites are
 *  deterministic regardless of what the host has stored under service
 *  "axuse" (the fallback itself has its own injected-runner tests).
 *  NODE_TEST_CONTEXT (and friends) MUST be stripped: a `node --test` child
 *  spawned from inside a test file inherits it, Node then believes the run
 *  is recursive and SILENTLY SKIPS every file with a warning and exit 0 —
 *  the catalog suites would pass without ever running (verified live on
 *  Node 22/25). Deleting the marker makes the child a fresh root run.
 *  The glob (not a bare directory) keeps discovery working across Node
 *  versions: Node >= 25 rejects directory args with MODULE_NOT_FOUND. */
function run(args, cwd) {
  const env = { ...process.env, AXUSE_KEYCHAIN: "0" };
  for (const k of Object.keys(env)) if (k.startsWith("NODE_TEST_")) delete env[k];
  const r = spawnSync(process.execPath, args, {
    cwd, encoding: "utf8", timeout: 600_000, windowsHide: true, env,
  });
  return { status: r.status, output: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}
