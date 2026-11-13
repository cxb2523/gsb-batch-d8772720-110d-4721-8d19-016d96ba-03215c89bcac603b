import assert from "node:assert/strict";
import { test } from "node:test";

import { fillRate, fingerprint, rowsOf } from "../lib/rows.mjs";
import { estimate, planRuns, resultLine, runBatch, runSummary } from "../run.mjs";
import { markdown, median, summarise } from "../report.mjs";
import { runValendata } from "../tools/valendata.mjs";
import { runApify } from "../tools/apify.mjs";
import { lastJsonLine } from "../tools/browser_use.mjs";

const pricing = {
  valendata: { usd_per_credit: 0.01, estimate_credits_per_run: 4 },
  firecrawl: { estimate_usd_per_run: 0.05 },
  apify: { estimate_usd_per_run: 0.05 },
  browser_use: { estimate_usd_per_run: 0.03 },
};
const task = { id: "wikipedia", url: "https://x", prompt: "p", fields: ["headline", "link"], limit: 2,
  tools: { valendata: { slug: "wikipedia-current-events" }, browser_use: {} } };
const ready = { valendata: "ready", firecrawl: "needs FIRECRAWL_API_KEY", apify: "needs APIFY_TOKEN", browser_use: "ready" };

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

test("rows are found inside any answer shape, and measured the same way", () => {
  const rows = rowsOf({ data: { items: [{ Headline: "A", link: "u" }, { headline: "", link: "v" }] } });
  assert.equal(rows.length, 2);
  assert.equal(fillRate(rows, ["headline", "link"]), 0.75);
  assert.equal(fingerprint(rows, ["headline", "link"]), fingerprint([{ headline: "A ", LINK: "u" }, { headline: "", link: "v" }], ["headline", "link"]));
  assert.notEqual(fingerprint(rows, ["headline"]), fingerprint([{ headline: "B" }], ["headline"]));
});

test("the plan skips what is missing and says why; nothing is planned without its key", () => {
  const { planned, skipped } = planRuns([task], { taskIds: [], toolIds: ["valendata", "firecrawl", "browser_use"], runs: 2 }, ready);
  assert.equal(planned.length, 4);
  assert.deepEqual(skipped, [{ task: "wikipedia", tool: "firecrawl", why: "no entry for this tool" }]);
  const noSlug = { ...task, tools: { valendata: { slug: null, note: "create one first" } } };
  assert.equal(planRuns([noSlug], { taskIds: [], toolIds: ["valendata"], runs: 1 }, ready).skipped[0].why, "create one first");
});

test("the estimate is shown per tool before any spend", () => {
  const { planned } = planRuns([task], { taskIds: [], toolIds: ["valendata", "browser_use"], runs: 5 }, ready);
  const cost = estimate(planned, pricing);
  assert.equal(cost.credits, 20);
  assert.equal(Math.round(cost.usd * 100), 35);
});

test("a Valendata run is timed from request to rows and priced from the credits it charged", async () => {
  const { now, sleep } = clock();
  const calls = [];
  const states = [{ status: "running" }, { status: "success", rows: [{ headline: "A", link: "u" }, { headline: "B", link: "v" }, { headline: "C", link: "w" }], credits_charged: 2 }];
  const fetchImpl = async (url, init) => {
    calls.push([init.method, String(url)]);
    const body = init.method === "POST" ? { run_id: "r1", status: "running" } : states.shift();
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const keys = { valendata: { apiKey: "k", apiUrl: "https://api.test" } };
  const out = await runValendata({ task, config: task.tools.valendata, keys, pricing, fetchImpl, now, sleep });
  assert.equal(out.ok, true);
  assert.equal(out.output.length, 2, "rows are cut to the task's limit");
  assert.equal(out.usd, 0.02);
  assert.equal(out.seconds, 1);
  assert.deepEqual(calls[0], ["POST", "https://api.test/v1/skills/wikipedia-current-events/runs"]);
});

test("an Apify run reports the dollars Apify billed", async () => {
  const { now, sleep } = clock();
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.endsWith("/runs")) return new Response(JSON.stringify({ data: { id: "a1", status: "RUNNING" } }));
    if (u.includes("/actor-runs/")) return new Response(JSON.stringify({ data: { id: "a1", status: "SUCCEEDED", defaultDatasetId: "d1", usageTotalUsd: 0.031 } }));
    return new Response(JSON.stringify([{ name: "Dr A", phone: "1" }]));
  };
  const out = await runApify({ task, config: { actor: "compass~crawler-google-places", input: {} }, keys: { apify: "t" }, fetchImpl, now, sleep });
  assert.equal(out.ok, true);
  assert.equal(out.usd, 0.031);
  assert.equal(out.output.length, 1);
});

test("browser-use's result is its last JSON line, whatever it logged before", () => {
  assert.deepEqual(lastJsonLine('INFO step 1\n{"seconds": 40.5, "ok": true}\n'), { seconds: 40.5, ok: true });
  assert.equal(lastJsonLine("crashed\n"), null);
});

test("the report gives medians and says whether every run gave the same answer", () => {
  const item = { task, tool: "valendata" };
  const rowsA = [{ headline: "A", link: "u" }];
  const lines = [
    resultLine({ ...item, attempt: 1 }, { ok: true, seconds: 1, usd: 0.02, output: rowsA }, "t"),
    resultLine({ ...item, attempt: 2 }, { ok: true, seconds: 3, usd: 0.02, output: rowsA }, "t"),
    resultLine({ ...item, tool: "browser_use", attempt: 1 }, { ok: true, seconds: 50, usd: 0.03, tokens: 9000, output: rowsA }, "t"),
    resultLine({ ...item, tool: "browser_use", attempt: 2 }, { ok: true, seconds: 70, usd: 0.04, tokens: 12000, output: [{ headline: "Z", link: "u" }] }, "t"),
  ];
  const [vd, bu] = summarise(lines);
  assert.equal(vd.median_seconds, 2);
  assert.equal(vd.same_answer_every_run, true);
  assert.equal(bu.same_answer_every_run, false);
  assert.equal(median([3, 1, 2]), 2);
  assert.match(markdown([vd, bu]), /\| wikipedia \| browser_use \| 2\/2 \| 60\.0 s/);
});

test("browser-use is priced from its own tokens once the prices are filled in", async () => {
  const { usdFromTokens } = await import("../tools/browser_use.mjs");
  const run = { input_tokens: 1_000_000, cached_tokens: 2_000_000, output_tokens: 100_000 };
  assert.equal(usdFromTokens(run, { input: null, cached_input: null, output: null }), null);
  assert.equal(usdFromTokens(run, { input: 0.3, cached_input: 0.03, output: 1.2 }), 0.3 + 0.06 + 0.12);
});

test("a tool's own field names are scored as the task's, and tools take turns run by run", async () => {
  const { inTaskFields } = await import("../run.mjs");
  const rows = inTaskFields([{ event_text: "A", article_url: "u", topic: "x" }], { headline: "event_text", link: "article_url" });
  assert.deepEqual(rows, [{ headline: "A", link: "u" }]);
  const { planned } = planRuns([task], { taskIds: [], toolIds: ["valendata", "browser_use"], runs: 2 }, ready);
  assert.deepEqual(planned.map((p) => `${p.tool}#${p.attempt}`), ["valendata#1", "browser_use#1", "valendata#2", "browser_use#2"]);
});

test("Valendata's AI use is reported as it was, never as a made-up zero", async () => {
  const { usedAi } = await import("../tools/valendata.mjs");
  assert.equal(usedAi({ scrape_mode_used: "deep" }), true);
  assert.equal(usedAi({ diagnosis: { per_field: { a: { where_tried: ["an AI read of the page"] } } } }), true);
  assert.equal(usedAi({ scrape_mode_used: "fast", diagnosis: {} }), false);
  const line = resultLine({ task, tool: "valendata", attempt: 1 }, { ok: true, seconds: 30, usd: 0.02, output: [{ headline: "A", link: "u" }], tokens: null, ai_used: true }, "t");
  assert.equal(line.tokens, null);
  assert.match(markdown(summarise([line])), /not reported \(AI read the page\)/);
});

test("a skill that never passed its own validation is refused before anything is spent", async () => {
  const { requireValidated } = await import("../tools/valendata.mjs");
  const fetchImpl = async () => new Response(JSON.stringify({ validation_status: "failed", validation_reason: "twin fields" }));
  await assert.rejects(requireValidated({ apiKey: "k", apiUrl: "https://api.test" }, "wiki", fetchImpl), /has not passed its own validation/);
});

test("a row counts as correct only when its text is really on the page", async () => {
  const { correctShare, pageText } = await import("../lib/truth.mjs");
  const page = pageText('<ul><li><a href="/g">Gaza genocide</a> – Israel launches an airstrike against a tent in <a>Khan Yunis</a>, Gaza Strip.</li></ul>');
  const real = { headline: "Israel launches an airstrike against a tent in Khan Yunis, Gaza Strip." };
  const madeUp = { headline: "Israel announces a ceasefire across the whole Gaza Strip today." };
  const category = { headline: "Armed conflicts and attacks" };
  assert.equal(correctShare([real], "headline", page), 1);
  assert.equal(correctShare([real, madeUp, category], "headline", page), 1 / 3);
});

test("same answer is judged within one page version, so a page that changed is no tool's fault", async () => {
  const { pageVersion } = await import("../lib/truth.mjs");
  const before = pageVersion('<script>"wgCurRevisionId":42</script><li>A number of militants and several civilians are killed.</li>');
  const after = pageVersion('<script>"wgCurRevisionId":42</script><li>Several civilians are killed.</li>');
  assert.notEqual(before, after, "an edited sentence is a new page version even when the revision number stays");
  const mk = (attempt, answer, version) => ({ task: "w", tool: "t", attempt, ok: true, seconds: 1, usd: 0, rows: 5, fill: 1, answer, page_version: version });
  const [steady] = summarise([mk(1, "a", "rev:1"), mk(2, "b", "rev:2"), mk(3, "a", "rev:1")]);
  assert.equal(steady.same_answer_every_run, true);
  const [shaky] = summarise([mk(1, "a", "rev:1"), mk(2, "c", "rev:1")]);
  assert.equal(shaky.same_answer_every_run, false);
});

test("an actor that returns one object holding the rows is read from that field", async () => {
  const { now, sleep } = clock();
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.endsWith("/runs")) return new Response(JSON.stringify({ data: { id: "a1", status: "RUNNING" } }));
    if (u.includes("/actor-runs/")) return new Response(JSON.stringify({ data: { id: "a1", status: "SUCCEEDED", defaultDatasetId: "d1", usageTotalUsd: 0.01 } }));
    return new Response(JSON.stringify([{ username: "nasa", latestPosts: [{ url: "p1", caption: "c", likesCount: 5 }, { url: "p2" }] }]));
  };
  const out = await runApify({ task, config: { actor: "x", input: {}, rows_from: "latestPosts" }, keys: { apify: "t" }, fetchImpl, now, sleep });
  assert.equal(out.output.length, 2);
  assert.equal(out.output[0].url, "p1");
});

test("a thrown tool fails its own line and the rest of the plan still runs", async () => {
  const { planned } = planRuns([task], { taskIds: [], toolIds: ["valendata", "browser_use"], runs: 2 }, ready);
  const written = [];
  const tools = {
    valendata: async () => { throw new Error("boom"); },
    browser_use: async () => ({ ok: true, status: "done", seconds: 5, usd: 0.03, output: [{ headline: "A", link: "u" }] }),
  };
  const lines = await runBatch(planned, { keys: {}, pricing, tools, write: (line) => written.push(line) });
  assert.equal(lines.length, planned.length, "one line per planned run, whatever happened");
  assert.equal(written.length, planned.length, "every line was written");
  const [first, second, third, fourth] = lines;
  assert.equal(first.ok, false);
  assert.equal(first.status, "error");
  assert.equal(first.tool, "valendata");
  assert.equal(first.attempt, 1);
  assert.match(first.error, /boom/);
  assert.equal(first.usd, 0, "a thrown run records what it was charged: nothing");
  assert.equal(second.ok, true, "the next planned item still ran");
  assert.equal(third.status, "error");
  assert.equal(fourth.ok, true);
});

test("a Valendata run that never finishes is a timeout that keeps its run id as ref", async () => {
  const { now, sleep } = clock();
  const fetchImpl = async (url, init) => new Response(JSON.stringify(
    init.method === "POST" ? { run_id: "r9", status: "running" } : { status: "running" }), { status: 200 });
  const keys = { valendata: { apiKey: "k", apiUrl: "https://api.test" } };
  const out = await runValendata({ task, config: task.tools.valendata, keys, pricing, fetchImpl, now, sleep, maxWaitMs: 5000 });
  assert.equal(out.ok, false);
  assert.equal(out.status, "timeout");
  assert.equal(out.ref, "r9");
  assert.match(out.error, /wait limit/);
});

test("an Apify run that never finishes is a timeout that keeps the actor run id as ref", async () => {
  const { now, sleep } = clock();
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.endsWith("/runs")) return new Response(JSON.stringify({ data: { id: "a9", status: "RUNNING" } }));
    return new Response(JSON.stringify({ data: { id: "a9", status: "RUNNING" } }));
  };
  const out = await runApify({ task, config: { actor: "x", input: {} }, keys: { apify: "t" }, fetchImpl, now, sleep, maxWaitMs: 6000 });
  assert.equal(out.ok, false);
  assert.equal(out.status, "timeout");
  assert.equal(out.ref, "a9");
  assert.match(out.error, /wait limit/);
});

test("empty rows are their own failure kind, not an error, and fake no fill or correct", () => {
  const truthTask = { ...task, truth: { field: "headline" } };
  const page = "<html><body>some page</body></html>";
  const empty = resultLine({ task: truthTask, tool: "valendata", attempt: 1 },
    { ok: true, status: "success", seconds: 2, usd: 0.02, output: [] }, "t", page);
  assert.equal(empty.ok, false);
  assert.equal(empty.status, "empty");
  assert.equal(empty.fill, null, "no rows: fill is unknown, not 0");
  assert.equal(empty.correct, null, "no rows: correct is unknown, not 0");
  assert.match(empty.error, /no rows/);
  const thrown = resultLine({ task: truthTask, tool: "valendata", attempt: 2 },
    { ok: false, status: "error", seconds: 0, usd: 0, output: [], error: "boom" }, "t", page);
  assert.equal(thrown.status, "error");
  assert.notEqual(empty.status, thrown.status, "empty and thrown are different kinds of failure");
  assert.notEqual(empty.error, thrown.error);
});

test("when the truth page cannot be read, correct is unknown, never 0", async () => {
  const truthTask = { ...task, truth: { field: "headline" } };
  const outcome = { ok: true, status: "done", seconds: 1, usd: 0, output: [{ headline: "A headline long enough to check", link: "u" }] };
  assert.equal(resultLine({ task: truthTask, tool: "browser_use", attempt: 1 }, outcome, "t", null).correct, null);
  assert.equal(resultLine({ task: truthTask, tool: "browser_use", attempt: 1 }, outcome, "t", "").correct, null);
  const { planned } = planRuns([truthTask], { taskIds: [], toolIds: ["browser_use"], runs: 1 }, ready);
  const lines = await runBatch(planned, {
    keys: {}, pricing,
    tools: { browser_use: async () => outcome },
    fetchPageImpl: async () => { throw new Error("offline"); },
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].ok, true, "the run itself worked");
  assert.equal(lines[0].correct, null, "but the truth check never happened");
});

test("the end-of-run tally counts exactly the lines written, by tool", async () => {
  const { planned } = planRuns([task], { taskIds: [], toolIds: ["valendata", "browser_use"], runs: 2 }, ready);
  let valendataCalls = 0;
  const tools = {
    valendata: async () => (++valendataCalls === 1
      ? { ok: false, status: "timeout", seconds: 600, usd: 0.01, spent: { credits: 1 }, output: [], ref: "r1", error: "wait limit reached" }
      : { ok: true, status: "success", seconds: 3, usd: 0.02, output: [] }),
    browser_use: async () => ({ ok: true, status: "done", seconds: 5, usd: 0.03, output: [{ headline: "A", link: "u" }] }),
  };
  const written = [];
  const lines = await runBatch(planned, { keys: {}, pricing, tools, write: (line) => written.push(line) });
  assert.equal(written.length, planned.length);
  const summary = runSummary(written);
  assert.deepEqual(summary.valendata, { planned: 2, ok: 0, failed: 2, timeouts: 1, empty: 1 });
  assert.deepEqual(summary.browser_use, { planned: 2, ok: 2, failed: 0, timeouts: 0, empty: 0 });
  const total = Object.values(summary).reduce((n, t) => n + t.planned, 0);
  assert.equal(total, lines.length, "the tally covers every line the batch wrote");
});
