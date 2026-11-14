/**
 * Plugin system tests.
 *
 * Unit tests always run (loader, ABI validation, ctx JSON trap, dispatch).
 * Live tests are gated like the other browser tests: they skip when no
 * Chromium-family browser is found; the Turnstile demo (network) run is
 * additionally gated on AXUSE_TEST_LIVE_CAPTCHA=1.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { locateBrowser } from "../src/core/cdp.js";
import { Controller } from "../src/core/controller.js";
import {
  validateSolver, loadSolvers, buildSolveContext, solveWith,
} from "../src/plugins/index.js";

const hasBrowser = !!locateBrowser();
const liveOk = process.env.AXUSE_TEST_LIVE_CAPTCHA === "1";

/* ---------------------------------------------------------------- unit */

test("plugin ABI validation", () => {
  const good = validateSolver({
    id: "x-solver", version: "1.0.0", providers: ["turnstile"],
    solve: async (provider, ctx) => ({ solved: false }),
  }, "test");
  assert.equal(good.id, "x-solver");

  assert.throws(() => validateSolver({}, "t"), (e) => e.code === "PLUGIN_LOAD_FAILED");
  assert.throws(() => validateSolver({ id: "x", version: "1", providers: [], solve: async (p, c) => {} }, "t"), (e) => e.code === "PLUGIN_LOAD_FAILED");
  assert.throws(() => validateSolver({ id: "x", version: "1", providers: ["p"], solve: () => {} }, "t"), (e) => e.code === "PLUGIN_LOAD_FAILED"); // not async
  assert.throws(() => validateSolver({ id: "x", version: "1", providers: ["p"], solve: async () => {} }, "t"), (e) => e.code === "PLUGIN_LOAD_FAILED"); // arity < 2
});

test("loader: discovers index.js and package.json main, isolates failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "axuse-plugins-"));
  try {
    mkdirSync(join(dir, "good"));
    writeFileSync(join(dir, "good", "index.js"),
      `export const solver = { id: "good", version: "1.0.0", providers: ["p1"], solve: async (provider, ctx) => ({ solved: true }) };`);
    mkdirSync(join(dir, "pkgd"));
    writeFileSync(join(dir, "pkgd", "package.json"), `{ "main": "entry.mjs" }`);
    writeFileSync(join(dir, "pkgd", "entry.mjs"),
      `export default { id: "pkgd", version: "2.0.0", providers: ["p2"], solve: async (provider, ctx) => ({}) };`);
    mkdirSync(join(dir, "broken"));
    writeFileSync(join(dir, "broken", "index.js"), `export const solver = { nope: true };`);

    const { solvers, errors } = await loadSolvers([dir]);
    assert.equal(solvers.length, 2);
    assert.deepEqual(errors.map((e) => e.plugin), ["broken"]);
    const ids = solvers.map((s) => s.id).sort();
    assert.deepEqual(ids, ["good", "pkgd"]);
    assert.ok(solvers.find((s) => s.id === "pkgd").providers.includes("p2"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("solveWith: typed NO_SOLVER with install hint", async () => {
  await assert.rejects(
    () => solveWith([], "turnstile", null),
    (e) => e.code === "NO_SOLVER" && /plugins\//.test(e.hint ?? ""),
  );
});

test("ctx.evaluate parses the JSON string (kills the double-encoding trap)", { skip: !hasBrowser }, async (t) => {
  const c = new Controller();
  t.after(() => c.dispose());
  await c.execute("open", { url: "data:text/html,<h1>ctx test</h1>", headless: true, settle_ms: 100 });
  const ctx = buildSolveContext(c);
  const opened = await ctx.evaluate(`(() => ({ deep: { ok: 1 }, s: "x" }))()`);
  assert.deepEqual(opened, { deep: { ok: 1 }, s: "x" });
  const prim = await ctx.evaluate(`42`);
  assert.equal(prim, 42);
  const viaController = await c.execute("close", { browser: true });
  assert.ok(viaController);
});

/* ------------------------------------------------- live (gated, opt-in) */

test("example plugin solves the Turnstile demo end-to-end", { skip: !hasBrowser || !liveOk }, async (t) => {
  const exampleDir = fileURLToPath(new URL("../examples/plugin-turnstile-demo/", import.meta.url));
  const { solvers } = await loadSolvers([exampleDir]);
  assert.equal(solvers.length, 1, "example solver loads");
  const c = new Controller();
  t.after(() => c.dispose());
  await c.execute("open", { url: "https://demo.turnstile.workers.dev/", settle_ms: 4000 });
  const ctx = buildSolveContext(c);
  const result = await solveWith(solvers, "turnstile", ctx, {});
  assert.equal(result.solved, true, JSON.stringify(result));
  assert.ok(result.token && result.token.length > 0);
  await c.execute("close", { browser: true });
});

test("captcha-pro loads and its Turnstile path solves the official demo (test keys)", { skip: !hasBrowser || !liveOk }, async (t) => {
  const paidDir = fileURLToPath(new URL("../plugins/captcha-pro/", import.meta.url));
  const { solvers, errors } = await loadSolvers([paidDir]);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  const pro = solvers.find((s) => s.id === "captcha-pro");
  assert.ok(pro, "captcha-pro loads");
  assert.deepEqual(pro.providers.sort(), ["hcaptcha", "recaptcha-v2", "turnstile"]);
  // captcha-pro is license-gated like every paid package: mint a throwaway
  // test keypair + token and inject it through the opts.license QA seam.
  const { genKeyPair, issueLicense } = await import("../plugins/_shared/license.js");
  const kp = genKeyPair();
  const license = {
    token: issueLicense({ customer: "live-test", package: "captcha-pro", expires: Date.now() + 3600_000 }, kp.privateKey),
    publicKey: kp.publicKey,
  };
  const c = new Controller();
  t.after(() => c.dispose());
  await c.execute("open", { url: "https://2captcha.com/demo/cloudflare-turnstile", settle_ms: 5000 });
  const ctx = buildSolveContext(c);
  const result = await solveWith(solvers, "turnstile", ctx, { license });
  assert.equal(result.solved, true, JSON.stringify(result));
  await c.execute("close", { browser: true });
});
