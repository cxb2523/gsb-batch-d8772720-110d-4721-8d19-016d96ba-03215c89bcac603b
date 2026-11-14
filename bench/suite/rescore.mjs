/**
 * Re-score recorded runs under the narrower "touched the task site" rule.
 *
 * run.mjs disqualifies a run when a call into another arm's browser layer
 * appears at all (strict). That also catches harmless calls: a status
 * inspection that returns nothing about the page. The relaxed rule keeps the
 * purpose of the check: a foreign call only disqualifies when it touched the
 * task site (its arguments reference this run's id or the tunnel host). It is
 * applied identically to every arm and every run, and the strict result is
 * always reported next to it.
 *
 *   node bench/suite/rescore.mjs results/a.jsonl [results/b.jsonl ...]
 */
import { readFileSync } from "node:fs";

const FOREIGN = {
  // Same patterns run.mjs uses to decide a call belongs to another arm's layer.
  axuse: (c) => (c.name === "js" && /cua\.|tabs\.new|playwright/.test(c.args)) || /browser-use/.test(c.args),
  playwright: (c) => /^ax_|mcp__axuse/.test(c.name) || /mcp__axuse|browser-use/.test(c.args) || (c.name === "js" && /cua\.|tabs\.new/.test(c.args)),
  "browser-use": (c) => /^ax_|mcp__axuse/.test(c.name) || /mcp__axuse/.test(c.args) || (c.name === "js" && /cua\.|tabs\.new/.test(c.args)),
  "codex-chrome": (c) => /^ax_|mcp__axuse/.test(c.name) || /mcp__axuse|browser-use/.test(c.args),
};

function calls(file) {
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const p = o.payload ?? {};
    if (p.type === "function_call" || p.type === "custom_tool_call") out.push({ name: p.name, args: String(p.arguments ?? p.input ?? "") });
  }
  return out;
}

const rows = [];
for (const f of process.argv.slice(2)) {
  for (const l of readFileSync(f, "utf8").trim().split("\n")) rows.push(JSON.parse(l));
}
const by = {};
for (const r of rows) {
  const isForeign = FOREIGN[r.arm] ?? (() => false);
  let touched = false;
  if (r.foreign && r.sessionFile) {
    touched = calls(r.sessionFile).some((c) => isForeign(c) && (c.args.includes(r.run) || /trycloudflare\.com/.test(c.args)));
  }
  const relaxed = r.scored && !r.violations?.length && r.evidence && !touched;
  (by[r.arm] ??= { n: 0, strict: 0, relaxed: 0, answer: 0 });
  by[r.arm].n++; by[r.arm].strict += r.success ? 1 : 0; by[r.arm].relaxed += relaxed ? 1 : 0; by[r.arm].answer += r.scored ? 1 : 0;
  if (r.success !== relaxed) console.log(`re-scored: ${r.task} ${r.arm} r${r.rep} strict=${r.success} relaxed=${relaxed} (foreign call touched task site: ${touched})`);
}
console.log("\narm            runs  strict  relaxed  answer-correct");
for (const [a, v] of Object.entries(by)) console.log(`${a.padEnd(14)} ${String(v.n).padStart(4)}  ${String(v.strict).padStart(6)}  ${String(v.relaxed).padStart(7)}  ${String(v.answer).padStart(14)}`);
