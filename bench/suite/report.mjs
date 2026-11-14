/**
 * Build the HTML benchmark report from a summarize.mjs JSON.
 *   node bench/suite/report.mjs summary.json out.html
 */
import { readFileSync, writeFileSync } from "node:fs";

const [src, out] = process.argv.slice(2);
const d = JSON.parse(readFileSync(src, "utf8"));
const ARMS = ["axuse", "codex-chrome", "browser-use"];
const LABEL = { axuse: "axuse", "codex-chrome": "Codex + Chrome extension", "browser-use": "browser-use 0.13" };
const TASK = {
  t1: "Click to reveal", t2: "Form fill", t3: "150-row table lookup", t4: "4-step validated wizard",
  t5: "Cross-origin iframe", t6: "Shadow DOM switches", t7: "Infinite scroll feed", t8: "Hover-only menu",
  t9: "confirm → prompt dialogs", t10: "New-tab round trip", t11: "Async job, then download", t12: "Drag and drop",
  t13: "Rich-text editor", t14: "Autocomplete + listbox", t15: "Search + pagination", t16: "Canvas (vision)",
};
const k = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1000 ? Math.round(n / 1000) + "k" : String(Math.round(n)));
const s = (n) => `${Math.round(n)} s`;
const p = d.perArm;
const tasks = Object.keys(d.perTask);
const wins = { wall: {}, tok: {} };
for (const a of ARMS) { wins.wall[a] = 0; wins.tok[a] = 0; }
for (const t of tasks) {
  const x = d.perTask[t];
  wins.wall[ARMS.reduce((b, a) => (x[a].wallS < x[b].wallS ? a : b))]++;
  wins.tok[ARMS.reduce((b, a) => (x[a].tok < x[b].tok ? a : b))]++;
}
const runs = ARMS.reduce((n, a) => n + p[a].runs, 0);
const maxWall = Math.max(...ARMS.map((a) => p[a].medianWallS));
const maxTok = Math.max(...ARMS.map((a) => p[a].sumTotalTok));
const bar = (a, v, max, fmt) => `<div class="bar-row"><span class="bar-label">${LABEL[a]}</span><span class="bar-track"><span class="bar arm-${a}" style="width:${(100 * v / max).toFixed(1)}%"></span></span><span class="bar-val">${fmt(v)}</span></div>`;
const speedup = (a) => (p[a].medianWallS / p.axuse.medianWallS).toFixed(1);
const tokRatio = (a) => (p[a].sumTotalTok / p.axuse.sumTotalTok).toFixed(1);

const rowsTask = tasks.map((t) => {
  const x = d.perTask[t];
  const bw = ARMS.reduce((b, a) => (x[a].wallS < x[b].wallS ? a : b));
  const bt = ARMS.reduce((b, a) => (x[a].tok < x[b].tok ? a : b));
  const cell = (a) => `<td class="${a === bw ? "win" : ""}">${s(x[a].wallS)}</td><td class="${a === bt ? "win" : ""}">${k(x[a].tok)}</td><td class="ok">${x[a].ok}/${x[a].n}</td>`;
  return `<tr><th scope="row"><span class="tid">${t}</span> ${TASK[t]}</th>${ARMS.map(cell).join("")}</tr>`;
}).join("\n");

const html = `<title>axuse Browser Benchmark</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Condensed:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
/* Layout: a lab report — verdict first, then the evidence table, then method. */
:root {
  --bg: #f6f7f9; --surface: #ffffff; --fg: #1b2230; --muted: #5d6676; --line: #dde1e8;
  --axuse: #0b6e4f; --codex: #6a5acd; --bu: #b5651d; --win-bg: #e3f3ec; --win-fg: #0b5a41;
  --display: "IBM Plex Sans Condensed", "Arial Narrow", system-ui, sans-serif;
  --body: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, Consolas, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #11151c; --surface: #181d26; --fg: #e4e8ef; --muted: #98a2b3; --line: #2a313d;
  --axuse: #3fbf8f; --codex: #9b8cf0; --bu: #e09a55; --win-bg: #173a2e; --win-fg: #7fe0b8; color-scheme: dark } }
:root[data-theme="dark"] {
  --bg: #11151c; --surface: #181d26; --fg: #e4e8ef; --muted: #98a2b3; --line: #2a313d;
  --axuse: #3fbf8f; --codex: #9b8cf0; --bu: #e09a55; --win-bg: #173a2e; --win-fg: #7fe0b8; color-scheme: dark }
body { background: var(--bg); color: var(--fg); font: 15px/1.55 var(--body); }
.wrap { max-width: 1040px; margin: 0 auto; padding-block: 40px 64px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); display: grid; gap: 36px; }
h1, h2 { font-family: var(--display); text-wrap: balance; margin: 0; }
h1 { font-size: clamp(28px, 4.2vw, 40px); line-height: 1.12; font-weight: 600; }
h2 { font-size: 22px; font-weight: 600; margin-bottom: 12px; }
p { margin: 0; max-width: 70ch; }
.eyebrow { font: 500 12px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin-bottom: 10px; }
.lede { color: var(--muted); font-size: 17px; margin-top: 12px; }
.verdicts { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
.verdict { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 16px 18px; display: grid; gap: 4px; }
.verdict .big { font: 600 30px/1.1 var(--display); color: var(--axuse); font-variant-numeric: tabular-nums; }
.verdict .what { font-weight: 600; }
.verdict .vs { color: var(--muted); font-size: 13.5px; }
.panel { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 20px; min-width: 0; }
.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }
.charts h3 { font: 600 14px/1.3 var(--body); margin: 0 0 12px; }
.bar-row { display: grid; grid-template-columns: minmax(110px, 38%) 1fr 64px; align-items: center; gap: 10px; margin: 8px 0; font-size: 13.5px; }
.bar-label { color: var(--fg); }
.bar-track { height: 14px; background: var(--bg); border-radius: 3px; overflow: hidden; }
.bar { display: block; height: 100%; border-radius: 3px; }
.arm-axuse { background: var(--axuse); } .arm-codex-chrome { background: var(--codex); } .arm-browser-use { background: var(--bu); }
.bar-val { font: 500 13px var(--mono); text-align: right; font-variant-numeric: tabular-nums; }
.note { color: var(--muted); font-size: 13px; margin-top: 10px; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 13.5px; font-variant-numeric: tabular-nums; }
th, td { padding: 7px 10px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; }
thead th { font: 600 12px var(--mono); color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
thead tr:first-child th { text-align: center; font-family: var(--body); text-transform: none; letter-spacing: 0; font-size: 13.5px; color: var(--fg); }
tbody th { text-align: left; font-weight: 500; }
.tid { font: 500 12px var(--mono); color: var(--muted); margin-right: 6px; }
td.win { background: var(--win-bg); color: var(--win-fg); font-weight: 600; }
td.ok { color: var(--muted); }
.grp { border-left: 1px solid var(--line); }
.cols2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }
ul { margin: 0; padding-left: 20px; display: grid; gap: 6px; }
code { font: 13px var(--mono); background: var(--bg); padding: 1px 5px; border-radius: 4px; }
.status { border-left: 3px solid var(--bu); padding-left: 14px; }
</style>
<div class="wrap">
  <header>
    <div class="eyebrow">Codex CLI · gpt-5.6-luna · reasoning medium · 16 tasks · ${runs} scored runs</div>
    <h1>axuse finishes browser tasks ${speedup("codex-chrome")}× faster than Codex's Chrome extension, using half the tokens</h1>
    <p class="lede">Same harness, same model, same tasks, same machine. The only thing that changes is the browser layer. Every task is scored by the test server, not by the agent's own report.</p>
  </header>

  <section class="verdicts" aria-label="Headline results">
    <div class="verdict"><span class="big">${s(p.axuse.medianWallS)}</span><span class="what">median time per task</span><span class="vs">Codex + Chrome ${s(p["codex-chrome"].medianWallS)} · browser-use ${s(p["browser-use"].medianWallS)}</span></div>
    <div class="verdict"><span class="big">${k(p.axuse.sumTotalTok)}</span><span class="what">tokens for all ${p.axuse.runs} runs</span><span class="vs">${tokRatio("codex-chrome")}× fewer than Codex + Chrome, ${tokRatio("browser-use")}× fewer than browser-use</span></div>
    <div class="verdict"><span class="big">${p.axuse.success}/${p.axuse.runs}</span><span class="what">tasks passed</span><span class="vs">Codex + Chrome ${p["codex-chrome"].success}/${p["codex-chrome"].runs} · browser-use ${p["browser-use"].success}/${p["browser-use"].runs}. Accuracy is a tie on this suite.</span></div>
    <div class="verdict"><span class="big">${wins.wall.axuse}/${tasks.length}</span><span class="what">tasks where axuse was fastest</span><span class="vs">fewest tokens on ${wins.tok.axuse}/${tasks.length}; Codex + Chrome took the rest, browser-use none</span></div>
  </section>

  <section class="charts">
    <div class="panel"><h3>Median wall time per task (lower is better)</h3>${ARMS.map((a) => bar(a, p[a].medianWallS, maxWall, s)).join("")}</div>
    <div class="panel"><h3>Total tokens across all runs (lower is better)</h3>${ARMS.map((a) => bar(a, p[a].sumTotalTok, maxTok, k)).join("")}<p class="note">Codex thread totals: cached prompt, fresh input and output. Median tool calls per task: axuse ${p.axuse.medianCalls}, Codex + Chrome ${p["codex-chrome"].medianCalls}, browser-use ${p["browser-use"].medianCalls}.</p></div>
  </section>

  <section class="panel">
    <h2>Every task</h2>
    <p class="note" style="margin:0 0 12px">Median over repetitions. The shaded cell is the best result for that task.</p>
    <div class="scroll"><table>
      <thead>
        <tr><th></th>${ARMS.map((a) => `<th colspan="3" class="grp">${LABEL[a]}</th>`).join("")}</tr>
        <tr><th scope="col" style="text-align:left">task</th>${ARMS.map(() => `<th class="grp">time</th><th>tokens</th><th>pass</th>`).join("")}</tr>
      </thead>
      <tbody>
${rowsTask}
      </tbody>
    </table></div>
  </section>

  <section class="cols2">
    <div class="panel">
      <h2>Ease of use</h2>
      <ul>
        <li><b>axuse:</b> one MCP line (<code>codex mcp add axuse -- node src/cli.js mcp</code>). No dependencies beyond Node 22. The same server, unmodified, passed its tasks in Codex, Claude Code and OpenCode.</li>
        <li><b>Codex + Chrome extension:</b> only works inside Codex with its desktop runtime and the extension installed. It refuses <code>localhost</code> and private IPs, so it cannot test the app you are developing locally. It also stopped to ask for confirmation on a pre-approved delete in an earlier pass.</li>
        <li><b>browser-use:</b> needs Python, uv and a Chrome started with remote debugging, and the agent must write Python helper scripts through the shell. On Windows the agent first tried a bash heredoc in PowerShell.</li>
      </ul>
    </div>
    <div class="panel">
      <h2>How it was measured</h2>
      <ul>
        <li>16 deterministic, per-run seeded tasks: forms, tables, wizards, cross-origin iframes, shadow DOM, infinite scroll, hover menus, JS dialogs, new tabs, async waits, drag and drop, rich text, comboboxes, pagination, canvas.</li>
        <li>Fixtures were served over public HTTPS tunnels so the Codex extension could load them; each arm loaded the same URLs.</li>
        <li>A run passes only if the server saw the right actions and the agent reported the right value. Runs that used an HTTP client or another arm's browser tools are disqualified.</li>
        <li>Each run used an empty working directory. axuse ran from a frozen copy. Arm order rotated per task.</li>
      </ul>
    </div>
  </section>

  <section class="panel status">
    <h2>What this run does and does not show</h2>
    <ul>
      <li>${runs} runs are scored: one full pass of all 16 tasks per tool, plus a second pass of tasks 1–12. The Codex workspace ran out of credits during the second pass. The 5 runs that hit that outage are excluded for every tool.</li>
      <li>All three tools solved every scored task, so this suite shows axuse is faster and cheaper, not more accurate.</li>
      <li>Since this run, axuse gained two fixes found by reading the transcripts: <code>ax_fill</code> now reports per field what it did, and screenshot pixels are documented as click coordinates. The second pass and a third repetition still need to be re-run with Codex credits.</li>
    </ul>
  </section>
</div>
`;
writeFileSync(out, html);
console.log("wrote", out);
