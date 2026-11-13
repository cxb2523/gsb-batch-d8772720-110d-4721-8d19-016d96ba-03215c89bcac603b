#!/usr/bin/env node
// Run the benchmark: every chosen task, on every chosen tool, N times, one result line each.
//
//   node bench/run.mjs                         plan only: what would run, what is missing, the cost
//   node bench/run.mjs --task wikipedia --tool valendata,browser_use --runs 5 --yes
//
// Nothing that costs money runs without --yes. Results are appended to bench/results/<date>.jsonl
// (every run, including failures) for bench/report.mjs. Keys are never printed.

import { appendFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { loadKeys, readiness } from "./lib/keys.mjs";
import { fillRate, fingerprint, rowsOf } from "./lib/rows.mjs";
import { correctShare, fetchPage, pageText, pageVersion } from "./lib/truth.mjs";
import { runApify } from "./tools/apify.mjs";
import { runBrowserUse } from "./tools/browser_use.mjs";
import { runFirecrawl } from "./tools/firecrawl.mjs";
import { requireValidated, runValendata } from "./tools/valendata.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const TOOLS = { valendata: runValendata, firecrawl: runFirecrawl, apify: runApify, browser_use: runBrowserUse };

/** The runs a selection makes, and why any task/tool pair is left out. */
export function planRuns(tasks, { taskIds, toolIds, runs }, ready) {
  const planned = [];
  const skipped = [];
  for (const task of tasks) {
    if (taskIds.length && !taskIds.includes(task.id)) continue;
    const runnable = [];
    for (const tool of toolIds) {
      const config = task.tools[tool];
      if (!config) skipped.push({ task: task.id, tool, why: "no entry for this tool" });
      else if (tool === "valendata" && !config.slug) skipped.push({ task: task.id, tool, why: config.note });
      else if (ready[tool] !== "ready") skipped.push({ task: task.id, tool, why: ready[tool] });
      else runnable.push({ tool, config });
    }
    // Tools take turns, run by run, so each meets the site and the network at the same moments.
    for (let i = 1; i <= runs; i += 1) for (const { tool, config } of runnable) planned.push({ task, tool, config, attempt: i });
  }
  return { planned, skipped };
}

/** Estimated spend of a plan, per tool, before anything runs. */
export function estimate(planned, pricing) {
  const byTool = {};
  for (const { tool } of planned) {
    const usd = tool === "valendata"
      ? pricing.valendata.estimate_credits_per_run * pricing.valendata.usd_per_credit
      : pricing[tool].estimate_usd_per_run;
    byTool[tool] = byTool[tool] || { runs: 0, usd: 0 };
    byTool[tool].runs += 1;
    byTool[tool].usd += usd;
  }
  const credits = (byTool.valendata?.runs || 0) * pricing.valendata.estimate_credits_per_run;
  return { byTool, credits, usd: Object.values(byTool).reduce((sum, t) => sum + t.usd, 0) };
}

/** One result line: what the tool said, measured the same way for every tool. */
/** A tool's rows with its own field names turned into the task's (config.fields_map: task field → tool field). */
export function inTaskFields(rows, fieldsMap) {
  if (!fieldsMap) return rows;
  return rows.map((row) => Object.fromEntries(Object.entries(fieldsMap).map(([mine, theirs]) => [mine, row[theirs]])));
}

export function resultLine({ task, tool, attempt, config }, outcome, at, page = null) {
  const rows = inTaskFields(rowsOf(outcome.output), config?.fields_map);
  // A run the tool calls successful that returns no rows is its own kind of failure ("empty"),
  // never the same "error" a thrown exception gets.
  const empty = Boolean(outcome.ok) && rows.length === 0;
  // An unreadable page (fetch failed or answered empty) is no page: correct stays unknown.
  const truth = page || null;
  return {
    at, task: task.id, tool, attempt,
    ok: Boolean(outcome.ok) && rows.length > 0,
    status: empty ? "empty" : outcome.status,
    seconds: Math.round(outcome.seconds * 100) / 100,
    usd: Math.round((outcome.usd || 0) * 10000) / 10000,
    usd_is_estimate: Boolean(outcome.usd_is_estimate),
    tokens: outcome.tokens ?? null,
    ai_used: outcome.ai_used ?? (outcome.tokens ? true : null),
    rows: rows.length,
    // No rows means nothing to measure: fill and correct stay unknown (null), never a made-up 0.
    fill: rows.length ? Math.round(fillRate(rows, task.fields) * 100) / 100 : null,
    correct: task.truth && truth && rows.length ? Math.round(correctShare(rows, task.truth.field, pageText(truth)) * 100) / 100 : null,
    page_version: truth ? pageVersion(truth) : null,
    answer: fingerprint(rows, task.fields),
    spent: outcome.spent || {},
    ref: outcome.ref || null,
    error: outcome.error || (empty ? "tool returned no rows" : null),
    sample: rows.slice(0, 3),
  };
}

/**
 * Run every planned item, in order. Whatever one item does — throws, answers empty, times out —
 * it becomes exactly one result line and the rest of the plan still runs, so the number of lines
 * a batch writes always equals the number of runs planned. `write` is called per line as it lands.
 */
export async function runBatch(planned, { keys, pricing, tools = TOOLS, fetchPageImpl = fetchPage, now = Date.now, write = null } = {}) {
  const lines = [];
  for (const item of planned) {
    const at = new Date().toISOString();
    const started = now();
    let outcome;
    try {
      outcome = await tools[item.tool]({ task: item.task, config: item.config, keys, pricing });
    } catch (error) {
      // One run's exception is that run's own failure line, never the end of the batch.
      outcome = { ok: false, status: "error", seconds: (now() - started) / 1000, output: [], usd: 0, spent: {}, error: String(error?.message || error) };
    }
    // The truth is read the moment the run ends, so every tool is checked against the page it saw.
    const page = item.task.truth ? await fetchPageImpl(item.task.url).catch(() => null) : null;
    const line = resultLine(item, outcome, at, page);
    if (write) await write(line);
    lines.push(line);
  }
  return lines;
}

/** Per-tool tally of the lines one batch actually wrote (skipped plan items were never lines). */
export function runSummary(lines) {
  const byTool = {};
  for (const line of lines) {
    const t = (byTool[line.tool] ||= { planned: 0, ok: 0, failed: 0, timeouts: 0, empty: 0 });
    t.planned += 1;
    if (line.ok) t.ok += 1;
    else {
      t.failed += 1;
      if (line.status === "timeout") t.timeouts += 1;
      if (line.status === "empty") t.empty += 1;
    }
  }
  return byTool;
}

function logLine(line) {
  return `${line.ok ? "ok  " : "FAIL"} ${line.task} × ${line.tool} #${line.attempt}: ${line.seconds}s, ` +
    `${line.rows} rows${line.fill === null ? "" : `, fill ${line.fill}`}${line.correct === null ? "" : `, correct ${line.correct}`}` +
    `, $${line.usd}${line.error ? `, ${line.error}` : ""}`;
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      task: { type: "string", default: "" },
      tool: { type: "string", default: "valendata,firecrawl,apify,browser_use" },
      runs: { type: "string", default: "5" },
      yes: { type: "boolean", default: false },
      out: { type: "string", default: "" },
      "allow-draft": { type: "boolean", default: false },
      tasks: { type: "string", default: "" },
    },
  });
  const { tasks } = JSON.parse(await readFile(values.tasks || join(HERE, "tasks.json"), "utf8"));
  const pricing = JSON.parse(await readFile(join(HERE, "pricing.json"), "utf8"));
  const keys = await loadKeys();
  const ready = readiness(keys);
  const selection = {
    taskIds: values.task ? values.task.split(",") : [],
    toolIds: values.tool.split(","),
    runs: Number(values.runs),
  };
  const { planned, skipped } = planRuns(tasks, selection, ready);
  const cost = estimate(planned, pricing);

  console.log("Tools:", ready);
  for (const s of skipped) console.log(`skip  ${s.task} × ${s.tool}: ${s.why}`);
  console.log(`\n${planned.length} runs planned. Estimated spend: about $${cost.usd.toFixed(2)}` +
    (cost.credits ? ` (${cost.credits} Valendata credits included)` : "") + ".");
  for (const [tool, t] of Object.entries(cost.byTool)) console.log(`  ${tool}: ${t.runs} runs ≈ $${t.usd.toFixed(2)}`);
  if (!values.yes) {
    console.log("\nNothing was run. Add --yes to spend it.");
    return;
  }

  for (const { config } of planned.filter((p) => p.tool === "valendata" && p.attempt === 1)) {
    if (!values["allow-draft"]) await requireValidated(keys.valendata, config.slug).catch((error) => {
      console.error(`Stopped before spending: ${error.message}`);
      process.exit(1);
    });
  }
  const day = new Date().toISOString().slice(0, 10);
  const out = values.out || join(HERE, "results", `${day}.jsonl`);
  const lines = await runBatch(planned, {
    keys,
    pricing,
    write: async (line) => {
      await appendFile(out, JSON.stringify(line) + "\n");
      console.log(logLine(line));
    },
  });
  const summary = runSummary(lines);
  console.log("\nThis run, by tool:");
  for (const [tool, t] of Object.entries(summary)) {
    console.log(`  ${tool}: ${t.planned} planned, ${t.ok} ok, ${t.failed} failed (${t.timeouts} timeout, ${t.empty} empty)`);
  }
  console.log(`\n${lines.length} result lines written to ${out}. Summarise with: node bench/report.mjs ${out}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}
