/**
 * Summarize suite results (one or more JSONL files) per arm and per task.
 *   node bench/suite/summarize.mjs results/a.jsonl [results/b.jsonl ...] [--json out.json]
 *
 * Token accounting (from Codex thread totals):
 *   total   = every input + output token the harness billed for the task
 *   fresh   = uncached input + output — what actually grows with tool output
 *             and with the number of steps (cached prefix excluded)
 */
import { readFileSync, writeFileSync } from "node:fs";

const files = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--json");
const jsonOut = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : null;
const rows = files.flatMap((f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));

const med = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); if (!s.length) return null; const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (xs) => { const s = xs.filter((x) => x != null); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null; };
const sum = (xs) => xs.filter((x) => x != null).reduce((a, b) => a + b, 0);
const total = (r) => r.tokens?.total_tokens ?? null;
// Runs where the agent stopped to ask the (absent) user for confirmation
// instead of acting — a safety-policy outcome, not a capability failure.
const asked = (r) => !r.success && /\b(confirm|confirmation|should I|shall I|do you want|proceed\?|approve)\b/i.test(r.answer ?? "");
const fresh = (r) => r.tokens ? (r.tokens.input_tokens - (r.tokens.cached_input_tokens ?? 0)) + r.tokens.output_tokens : null;

const arms = [...new Set(rows.map((r) => r.arm))];
const tasks = [...new Set(rows.map((r) => r.task))].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));

const perArm = {};
for (const a of arms) {
  const rs = rows.filter((r) => r.arm === a);
  const ok = rs.filter((r) => r.success);
  perArm[a] = {
    runs: rs.length,
    success: ok.length,
    successRate: ok.length / rs.length,
    askedConfirmation: rs.filter(asked).length,
    capabilityRate: ok.length / Math.max(1, rs.length - rs.filter(asked).length),
    tasksSolvedAll: tasks.filter((t) => { const x = rs.filter((r) => r.task === t); return x.length && x.every((r) => r.success); }).length,
    medianWallS: med(rs.map((r) => r.wallMs / 1000)),
    meanWallS: mean(rs.map((r) => r.wallMs / 1000)),
    medianTotalTok: med(rs.map(total)),
    meanTotalTok: mean(rs.map(total)),
    sumTotalTok: sum(rs.map(total)),
    medianFreshTok: med(rs.map(fresh)),
    meanFreshTok: mean(rs.map(fresh)),
    medianOutTok: med(rs.map((r) => r.tokens?.output_tokens)),
    medianCalls: med(rs.map((r) => r.toolCalls)),
    medianTurns: med(rs.map((r) => r.turns)),
    timeouts: rs.filter((r) => r.timedOut).length,
    violations: rs.filter((r) => r.violations?.length).length,
    // Efficiency on SUCCESSFUL runs only (cost of getting it right).
    succMedianWallS: med(ok.map((r) => r.wallMs / 1000)),
    succMedianTotalTok: med(ok.map(total)),
  };
}

const perTask = {};
for (const t of tasks) {
  perTask[t] = {};
  for (const a of arms) {
    const rs = rows.filter((r) => r.task === t && r.arm === a);
    if (!rs.length) continue;
    perTask[t][a] = {
      ok: rs.filter((r) => r.success).length, n: rs.length,
      wallS: med(rs.map((r) => r.wallMs / 1000)), tok: med(rs.map(total)), fresh: med(rs.map(fresh)), calls: med(rs.map((r) => r.toolCalls)),
      fails: rs.filter((r) => !r.success).map((r) => (r.timedOut ? "timeout" : r.violations?.length ? "violation" : !r.evidence ? "no-evidence" : r.foreign ? "foreign" : asked(r) ? "asked-confirmation" : `answer:${r.answer?.slice(0, 30)}`)),
    };
  }
}

const k = (n) => (n == null ? "—" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : Math.round(n).toString());
console.log(`\n${rows.length} runs · arms: ${arms.join(", ")} · tasks: ${tasks.length}\n`);
console.log("arm".padEnd(14) + "success".padEnd(12) + "capab.".padEnd(8) + "wall med".padEnd(10) + "tok med".padEnd(10) + "tok mean".padEnd(10) + "fresh med".padEnd(11) + "calls".padEnd(7) + "timeouts");
for (const a of arms) {
  const p = perArm[a];
  console.log(a.padEnd(14) + `${p.success}/${p.runs} ${(100 * p.successRate).toFixed(0)}%`.padEnd(12) + `${(100 * p.capabilityRate).toFixed(0)}%`.padEnd(8) + `${p.medianWallS?.toFixed(0)}s`.padEnd(10) + k(p.medianTotalTok).padEnd(10) + k(p.meanTotalTok).padEnd(10) + k(p.medianFreshTok).padEnd(11) + String(p.medianCalls).padEnd(7) + p.timeouts);
}
console.log("\nper task (ok/n · median wall · median total tokens):");
for (const t of tasks) {
  console.log(t.padEnd(5) + arms.map((a) => { const x = perTask[t][a]; return x ? `${a}: ${x.ok}/${x.n} ${x.wallS?.toFixed(0)}s ${k(x.tok)}${x.fails.length ? " ✗" + x.fails.join(",") : ""}` : ""; }).join("  |  "));
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ generated: new Date().toISOString(), files, perArm, perTask, rows: rows.map(({ sessionFile, ...r }) => r) }, null, 1));
