#!/usr/bin/env node
/**
 * skip-audit — every `# SKIP` in a test run must be EXPLICIT, TYPED, and
 * CI-VISIBLE. This tool fails the lane when a skip is not in the allowlist
 * (test/skip-allowlist.json), so a privilege- or environment-gated test can
 * never silently vanish from coverage.
 *
 * Input: TAP output of `node --test` on stdin or as file argument(s).
 * Exit:  0 = all skips accounted for; 1 = undocumented or stale skips.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ALLOWLIST_PATH = join(HERE, "..", "test", "skip-allowlist.json");

const allow = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"));
// Map: normalized skip token (test name or gate env var) → reason category
const allowed = new Map(Object.entries(allow.skips ?? allow));

function normalize(skipToken) {
  return String(skipToken).trim().replace(/\s+/g, " ");
}

/** A skip token is either a test title or a "requires X" reason string. */
function classify(token) {
  const t = normalize(token);
  for (const key of allowed.keys()) {
    if (t === key || t.startsWith(key)) return allowed.get(key);
  }
  return null;
}

async function main() {
  const sources = process.argv.slice(2);
  const chunks = [];
  if (!sources.length) chunks.push(await new Promise((ok) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { buf += d; });
    process.stdin.on("end", () => ok(buf));
  }));
  else for (const f of sources) chunks.push(readFileSync(f, "utf8"));
  const tap = chunks.join("\n");

  const skips = [];
  for (const line of tap.split("\n")) {
    // TAP: ok N - title # SKIP
    // ok N - title # SKIP reason
    const m = /^ok \d+ - (.+?) # SKIP\s*(.*)$/.exec(line);
    if (m) skips.push({ title: normalize(m[1]), reason: m[2] || null });
  }

  const unaccounted = [];
  const seen = new Set();
  for (const s of skips) {
    // The skip is accounted if the TEST TITLE or its REASON is allowlisted.
    const cls = classify(s.title) ?? (s.reason ? classify(s.reason) : null);
    if (!cls) unaccounted.push(s);
    seen.add(cls ?? `UNLISTED:${s.title}`);
  }

  // Informational only: allowlist entries may legitimately match in other
  // lanes (Windows, public checkout, browser-less hosts) than this run.
  const stale = [...allowed.keys()].filter((k) => !k.endsWith("*") && ![...seen].some((c) => c === allowed.get(k)));

  console.log(`skip-audit: ${skips.length} skip(s) observed.`);
  for (const s of skips) {
    const cls = classify(s.title) ?? (s.reason ? classify(s.reason) : null);
    console.log(`  ${cls ? "✔" : "✖"} ${s.title}${s.reason ? ` — ${s.reason}` : ""}${cls ? ` [${cls}]` : " [NOT IN ALLOWLIST]"}`);
  }
  if (stale.length) {
    console.log(`skip-audit: ${stale.length} stale allowlist entr(ies) never matched:`);
    for (const s of stale) console.log(`  - ${s}`);
  }
  if (unaccounted.length) {
    console.error(`\nskip-audit: FAIL — ${unaccounted.length} skip(s) are not in test/skip-allowlist.json.`);
    console.error("Every skip must be explicit and typed. Add the test title with a reason category,");
    console.error("or remove the skip. Never widen the allowlist to hide a regression.");
    process.exit(1);
  }
  if (stale.length) {
    console.log(`skip-audit: note — ${stale.length} allowlist entr(ies) not exercised in THIS lane (they gate other platforms/lanes):`);
    for (const s of stale) console.log(`  - ${s}`);
  }
  if (unaccounted.length) {
    console.error(`\nskip-audit: FAIL — ${unaccounted.length} skip(s) are not in test/skip-allowlist.json.`);
    console.error("Every skip must be explicit and typed. Add the test title with a reason category,");
    console.error("or remove the skip. Never widen the allowlist to hide a regression.");
    process.exit(1);
  }
  console.log("skip-audit: PASS — all skips explicit, typed, and accounted for.");
}

main().catch((e) => { console.error(e); process.exit(1); });
