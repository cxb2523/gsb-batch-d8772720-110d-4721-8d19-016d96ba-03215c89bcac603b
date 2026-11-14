/**
 * Offline fault-bundle review (src/machine/review.ts):
 *  - synthetic bundles (no browser): the three verdicts, threshold fallback, missing-evidence handling
 *  - a real fault bundle from a failed run against fixtures/tiktok-mock + flows/tiktok-profile.a2flow.json
 *    (skip with A2FLOW_SKIP_E2E=1): the review agrees with the bundle's reason/projection/fingerprint files,
 *    and deleting dom.html/fingerprint.json or tampering with the matched view flips the verdict.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { reviewFaultBundle, DEFAULT_MIN_SIMILARITY } from "../src/machine/review.ts";

const skip = !!process.env.A2FLOW_SKIP_E2E;
const MANIFEST = fileURLToPath(new URL("../flows/tiktok-profile.a2flow.json", import.meta.url));

// ---------------- synthetic bundles (offline, always run) ----------------

const SHAPE_A = ["0:html", "1:head", "1:body", "2:div", "3:main", "4:h1"];
const SHAPE_B = ["0:html", "1:body", "2:section", "3:article", "4:span", "5:em"];

function makeBundle(dir: string, opts: { matchedView?: string; minSimilarity?: number; observedShape?: string[]; declareFingerprint?: boolean } = {}) {
  mkdirSync(dir, { recursive: true });
  const w = (f: string, d: unknown) => writeFileSync(join(dir, f), typeof d === "string" ? d : JSON.stringify(d));
  const fp: Record<string, unknown> = { simhash: "aaaa0000", shape: SHAPE_A };
  if (opts.minSimilarity != null) fp.minSimilarity = opts.minSimilarity;
  w("reason.json", { reason: "run-failed", error: "simulated crash", at: "2026-11-14T00:00:00Z", url: "http://mock/@chef.nova", state: "profileComplete", view: "profile", expectedView: "profile" });
  w("projection.json", { matchedView: opts.matchedView ?? "profile", url: "http://mock/@chef.nova", model: {} });
  w("dom.html", "<html><body><main><h1>Chef</h1></main></body></html>");
  w("expected.view.json", { id: "profile", match: { path: "^/@[^/]+/?$" }, ...(opts.declareFingerprint === false ? {} : { fingerprint: fp }) });
  if (opts.declareFingerprint !== false)
    w("fingerprint.json", { view: "profile", expected: fp, observed: { simhash: "bbbb1111", shape: opts.observedShape ?? SHAPE_A }, similarity: 1 });
  return dir;
}

test("review: complete evidence, view and fingerprint agree → consistent", () => {
  const dir = makeBundle(mkdtempSync(join(tmpdir(), "a2flow-review-")), { minSimilarity: 0.9 });
  const r = reviewFaultBundle(dir);
  assert.equal(r.verdict, "consistent");
  assert.deepEqual(r.missing, []);
  assert.equal(r.reason, "run-failed");
  assert.equal(r.state, "profileComplete");
  assert.equal(r.expectedView, "profile");
  assert.equal(r.matchedView, "profile");
  assert.equal(r.viewConsistent, true);
  assert.equal(r.fingerprint?.similarity, 1);
  assert.equal(r.fingerprint?.threshold, 0.9);
  assert.equal(r.fingerprint?.thresholdSource, "view");
  assert.equal(r.fingerprint?.belowThreshold, false);
});

test("review: view declares no minSimilarity → runtime default threshold", () => {
  const dir = makeBundle(mkdtempSync(join(tmpdir(), "a2flow-review-")));
  const r = reviewFaultBundle(dir);
  assert.equal(r.verdict, "consistent");
  assert.equal(r.fingerprint?.threshold, DEFAULT_MIN_SIMILARITY);
  assert.equal(r.fingerprint?.thresholdSource, "default");
});

test("review: fingerprint similarity below the declared threshold → mismatch", () => {
  const dir = makeBundle(mkdtempSync(join(tmpdir(), "a2flow-review-")), { minSimilarity: 0.9, observedShape: SHAPE_B });
  const r = reviewFaultBundle(dir);
  assert.equal(r.verdict, "mismatch");
  assert.equal(r.viewConsistent, true, "view still agrees — the fingerprint is what fails");
  assert.ok(r.fingerprint!.similarity < 0.9, `similarity ${r.fingerprint!.similarity} is below the declared 0.9`);
  assert.equal(r.fingerprint?.belowThreshold, true);
  assert.ok(r.fingerprint!.diff.length > 0, "structural diff is reported");
});

test("review: matched view differs from expected view → mismatch", () => {
  const dir = makeBundle(mkdtempSync(join(tmpdir(), "a2flow-review-")), { matchedView: "video" });
  const r = reviewFaultBundle(dir);
  assert.equal(r.verdict, "mismatch");
  assert.equal(r.viewConsistent, false);
  assert.equal(r.fingerprint?.belowThreshold, false, "fingerprint is fine — the view is what fails");
});

test("review: missing dom.html, fingerprint.json or reason.json → insufficient, files named", () => {
  for (const f of ["dom.html", "fingerprint.json", "reason.json"]) {
    const dir = makeBundle(mkdtempSync(join(tmpdir(), "a2flow-review-")));
    rmSync(join(dir, f));
    const r = reviewFaultBundle(dir);
    assert.equal(r.verdict, "insufficient", f);
    assert.ok(r.missing.includes(f), `missing names ${f}: ${r.missing}`);
  }
});

test("review: view without a declared fingerprint skips the fingerprint check", () => {
  const dir = makeBundle(mkdtempSync(join(tmpdir(), "a2flow-review-")), { declareFingerprint: false });
  const r = reviewFaultBundle(dir);
  assert.equal(r.verdict, "consistent");
  assert.equal(r.fingerprint, null);
  assert.ok(r.notes.some((n) => n.includes("declares no fingerprint")));
});

test("review: nonexistent dir and corrupt files degrade to insufficient, never throw", () => {
  const gone = reviewFaultBundle(join(tmpdir(), "a2flow-review-does-not-exist"));
  assert.equal(gone.verdict, "insufficient");
  assert.ok(gone.missing.includes("reason.json") && gone.missing.includes("dom.html"));
  const dir = makeBundle(mkdtempSync(join(tmpdir(), "a2flow-review-")));
  writeFileSync(join(dir, "reason.json"), "{not json");
  const r = reviewFaultBundle(dir);
  assert.equal(r.verdict, "insufficient");
  assert.ok(r.missing.includes("reason.json"));
});

// ---------------- real fault bundle from a failed run (needs a browser) ----------------

test("review: a real run-failed bundle agrees with its reason/projection/fingerprint files", { skip, timeout: 900_000 }, async () => {
  const { startMock } = await import("../fixtures/tiktok-mock/server.ts");
  const { launchAdapter } = await import("../src/adapters/index.ts");
  const { loadManifest } = await import("../src/manifest/load.ts");
  const { MachineRunner } = await import("../src/machine/runner.ts");
  const { server, url } = await startMock(0);
  const out = mkdtempSync(join(tmpdir(), "a2flow-review-run-"));
  try {
    const m = loadManifest(MANIFEST);
    m.target.baseUrl = url;
    (m as any).policies.rateLimit = { minDelayMs: 0, jitterMs: 0 };
    const a = await launchAdapter({ adapter: "playwright", headless: true, viewport: m.target.viewport });
    let videos = 0;
    const runner = new MachineRunner(m, a, { profiles: ["chef.nova"], resultsPerPage: 6 }, {
      outDir: out,
      afterStep: async (e) => {
        if (e.kind === "emit" && e.emitted?.route === "tiktok.video" && !e.emitted.duplicate && ++videos >= 3) runner.abort("simulated crash");
      },
    });
    const error = await runner.run().then(() => null, (e: unknown) => e);
    await runner.recorder?.drain(); // flush the bundle's background writes before reading it
    await a.close().catch(() => {});
    assert.match(String(error), /simulated crash/);
    const bundle = runner.faults.find((d) => d.includes("run-failed"));
    assert.ok(bundle, `a run-failed fault bundle was written (faults: ${runner.faults})`);

    // the genuine bundle: evidence complete, view and fingerprint consistent
    const review = reviewFaultBundle(bundle);
    const reason = JSON.parse(readFileSync(join(bundle, "reason.json"), "utf8"));
    const projection = JSON.parse(readFileSync(join(bundle, "projection.json"), "utf8"));
    const fp = JSON.parse(readFileSync(join(bundle, "fingerprint.json"), "utf8"));
    assert.equal(review.verdict, "consistent", review.notes.join("; "));
    assert.equal(review.reason, reason.reason);
    assert.equal(review.error, reason.error);
    assert.equal(review.state, reason.state);
    assert.equal(review.expectedView, reason.expectedView ?? reason.view);
    assert.equal(review.matchedView, projection.matchedView);
    assert.equal(review.viewConsistent, true);
    assert.equal(review.fingerprint?.view, fp.view);
    assert.ok(Math.abs(review.fingerprint!.similarity - fp.similarity) < 1e-9, "recomputed similarity matches the recorded one");
    assert.equal(review.fingerprint?.threshold, m.views[fp.view].fingerprint!.minSimilarity);
    assert.equal(review.fingerprint?.thresholdSource, "view");
    assert.equal(review.fingerprint?.belowThreshold, false);

    // deleting the page HTML or the fingerprint file → insufficient evidence
    for (const f of ["dom.html", "fingerprint.json"]) {
      const copy = `${out}-missing-${f.replace(/\W+/g, "_")}`;
      cpSync(bundle, copy, { recursive: true });
      rmSync(join(copy, f));
      const r = reviewFaultBundle(copy);
      assert.equal(r.verdict, "insufficient", f);
      assert.ok(r.missing.includes(f), `missing names ${f}`);
    }

    // expected view ≠ observed view → mismatch
    const copy = `${out}-wrong-view`;
    cpSync(bundle, copy, { recursive: true });
    const other = Object.keys(m.views).find((v) => v !== projection.matchedView)!;
    writeFileSync(join(copy, "projection.json"), JSON.stringify({ ...projection, matchedView: other }));
    const tampered = reviewFaultBundle(copy);
    assert.equal(tampered.verdict, "mismatch");
    assert.equal(tampered.viewConsistent, false);
    assert.equal(tampered.matchedView, other);
    assert.ok(existsSync(join(copy, "dom.html")), "review is read-only: the bundle copy is untouched");
  } finally {
    server.close();
  }
});
