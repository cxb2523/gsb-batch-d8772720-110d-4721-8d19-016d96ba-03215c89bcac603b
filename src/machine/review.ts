/**
 * Offline fault-bundle review (`a2flow review <fault-bundle-dir>`): a read-only, browser-free second
 * look at a fault bundle written by the flight recorder. From the files alone it answers:
 *
 *   - why the run faulted and in which machine state (reason.json)
 *   - whether the view the projector actually matched at the fault (projection.json) is the view the
 *     machine expected (reason.json / expected.view.json)
 *   - whether the recorded structure fingerprint (fingerprint.json) drifts below the expected view's
 *     declared minSimilarity (expected.view.json), falling back to the runtime default when the view
 *     declares none — reusing the runtime's own similarity/structural-diff logic (fingerprint.ts)
 *
 * Verdicts:
 *   consistent    evidence complete; matched view == expected view and similarity >= threshold
 *   mismatch      evidence complete; view and/or fingerprint disagree
 *   insufficient  required evidence files are missing or unreadable (named in `missing`)
 *
 * Nothing here opens a browser or writes to the bundle; missing/corrupt files are reported, never thrown.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { similarityParts, structuralDiff, type Fingerprint } from "./fingerprint.js";

/** Drift threshold when the view declares none — the same default the runtime uses (MachineRunner.compareDrift). */
export const DEFAULT_MIN_SIMILARITY = 0.5;

export type ReviewVerdict = "consistent" | "mismatch" | "insufficient";

export interface FingerprintReview {
  /** View the fingerprint belongs to (expected view). */
  view: string;
  /** Recomputed blended similarity (DOM shape + AX roles) between expected and observed. */
  similarity: number;
  dom: number;
  ax?: number;
  /** Threshold actually applied: the view's declared minSimilarity, else the runtime default. */
  threshold: number;
  thresholdSource: "view" | "default";
  belowThreshold: boolean;
  /** Similarity the runtime recorded in the bundle, for cross-checking. */
  recordedSimilarity?: number;
  /** Structural diff (expected → observed); populated when below threshold. */
  diff: string[];
}

export interface FaultReview {
  bundle: string;
  verdict: ReviewVerdict;
  /** Required evidence files that are absent or unreadable. */
  missing: string[];
  /** Fault reason (e.g. "run-failed", "drift", "unit-failed-video"). */
  reason?: string;
  error?: string;
  /** Machine state at the fault. */
  state?: string;
  url?: string;
  expectedView?: string;
  /** View the projector matched on the faulted page (projection.json). */
  matchedView?: string | null;
  viewConsistent?: boolean;
  fingerprint: FingerprintReview | null;
  notes: string[];
}

/** Review a fault bundle directory read-only. Never throws: any gap lands in `missing`/`notes`. */
export function reviewFaultBundle(bundle: string): FaultReview {
  const review: FaultReview = { bundle, verdict: "insufficient", missing: [], fingerprint: null, notes: [] };
  const readJson = (f: string): any => {
    try {
      const p = join(bundle, f);
      if (!existsSync(p)) return undefined;
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return undefined; // corrupt JSON counts as missing evidence
    }
  };
  const hasFile = (f: string) => {
    try {
      return existsSync(join(bundle, f)) && statSync(join(bundle, f)).size > 0;
    } catch {
      return false;
    }
  };

  const reason = readJson("reason.json");
  if (!reason) review.missing.push("reason.json");
  const projection = readJson("projection.json");
  if (!projection) review.missing.push("projection.json");
  if (!hasFile("dom.html")) review.missing.push("dom.html");
  const expectedDecl = readJson("expected.view.json");
  if (!expectedDecl) review.missing.push("expected.view.json");
  // fingerprint.json is required evidence only when the expected view declares a fingerprint —
  // the recorder doesn't write one otherwise
  const declaresFingerprint = expectedDecl?.fingerprint != null;
  const fp = readJson("fingerprint.json");
  if (declaresFingerprint && !fp) review.missing.push("fingerprint.json");
  if (review.missing.length) {
    review.notes.push(`insufficient evidence: missing ${review.missing.join(", ")}`);
    return review;
  }

  review.reason = reason.reason;
  review.error = reason.error;
  review.state = reason.state;
  review.url = reason.url;
  const expectedView: string | undefined = reason.expectedView ?? expectedDecl.id;
  review.expectedView = expectedView;
  review.matchedView = projection.matchedView ?? null;
  if (!expectedView) {
    review.missing.push("expected view (reason.json expectedView / expected.view.json id)");
    review.notes.push("insufficient evidence: no expected view recorded");
    return review;
  }
  review.viewConsistent = review.matchedView === expectedView;
  if (!review.viewConsistent)
    review.notes.push(`view mismatch: machine expected "${expectedView}" but the page matched "${review.matchedView ?? "none"}"`);

  if (declaresFingerprint) {
    if (!fp?.expected?.shape || !fp?.observed?.shape) {
      review.missing.push("fingerprint.json (expected/observed)");
      review.notes.push("insufficient evidence: fingerprint.json lacks expected/observed fingerprints");
      return review;
    }
    const expected = fp.expected as Fingerprint, observed = fp.observed as Fingerprint;
    const parts = similarityParts(expected, observed);
    const declared = expectedDecl.fingerprint.minSimilarity ?? expected.minSimilarity;
    const threshold = declared ?? DEFAULT_MIN_SIMILARITY;
    review.fingerprint = {
      view: fp.view ?? expectedView,
      similarity: parts.combined,
      dom: parts.dom,
      ax: parts.ax,
      threshold,
      thresholdSource: declared != null ? "view" : "default",
      belowThreshold: parts.combined < threshold,
      recordedSimilarity: typeof fp.similarity === "number" ? fp.similarity : undefined,
      diff: parts.combined < threshold ? structuralDiff(expected, observed) : [],
    };
    if (fp.view && fp.view !== expectedView)
      review.notes.push(`fingerprint.json is for view "${fp.view}" but the expected view is "${expectedView}"`);
    if (typeof fp.similarity === "number" && Math.abs(fp.similarity - parts.combined) > 1e-9)
      review.notes.push(`recorded similarity ${fp.similarity} recomputes to ${parts.combined}`);
    if (review.fingerprint.belowThreshold)
      review.notes.push(`fingerprint drift: similarity ${parts.combined.toFixed(3)} < threshold ${threshold} (${review.fingerprint.thresholdSource === "view" ? "declared by view" : "runtime default"})`);
  } else {
    review.notes.push(`view "${expectedView}" declares no fingerprint — fingerprint check skipped`);
  }

  review.verdict = !review.viewConsistent || review.fingerprint?.belowThreshold ? "mismatch" : "consistent";
  return review;
}

/** One-paragraph human-readable rendering for the CLI. */
export function formatReview(r: FaultReview): string {
  const lines = [`verdict: ${r.verdict}`];
  if (r.reason) lines.push(`reason: ${r.reason}${r.error ? ` — ${r.error}` : ""}`);
  if (r.state) lines.push(`state: ${r.state}${r.url ? ` · url: ${r.url}` : ""}`);
  if (r.missing.length) lines.push(`missing evidence: ${r.missing.join(", ")}`);
  if (r.expectedView)
    lines.push(`view: expected "${r.expectedView}", matched "${r.matchedView ?? "none"}" — ${r.viewConsistent ? "consistent" : "MISMATCH"}`);
  if (r.fingerprint) {
    const f = r.fingerprint;
    lines.push(`fingerprint: similarity ${f.similarity.toFixed(3)} ${f.belowThreshold ? "<" : ">="} threshold ${f.threshold} (${f.thresholdSource === "view" ? `view "${f.view}"` : "runtime default"}) — ${f.belowThreshold ? "DRIFT" : "ok"}`);
  }
  for (const n of r.notes) lines.push(`· ${n}`);
  return lines.join("\n");
}
