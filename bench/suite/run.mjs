/**
 * axuse benchmark suite v2 — head-to-head runner.
 *
 * Same harness (Codex CLI), same model, same reasoning effort, same tasks,
 * same machine. The ONLY variable is the browser layer:
 *
 *   codex-chrome  Codex's own browser use: the Codex Chrome extension driving
 *                 the user's real Chrome (Codex's built-in plugin + skill)
 *   axuse         axuse MCP server (its own headless Chromium)
 *   browser-use   browser-use 0.13 CLI + its official SKILL.md (dedicated
 *                 headless Chromium via BU_CDP_URL)
 *   playwright    Microsoft's @playwright/mcp (pinned, --playwright-cli) driving
 *                 the same headless Chrome build, isolated profile
 *
 * Fixtures are served over public HTTPS (Cloudflare quick tunnels) because the
 * Codex extension refuses localhost / private IPs. Success is scored on
 * SERVER-SIDE ground truth plus the final answer; runs that bypass the browser
 * (HTTP clients against the task host) or use another arm's browser layer are
 * disqualified. Each run gets an empty cwd outside the repo.
 *
 *   node bench/suite/run.mjs [--arms codex-chrome,axuse,browser-use]
 *        [--tasks t1,...] [--reps 3] [--effort medium] [--parallel]
 */
import { spawn, execSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { startSuite, TASK_IDS, PROMPTS, SCORE, LOCAL_TASKS } from "./server.mjs";
import { locateBrowser } from "../../src/core/cdp.js";

const AXUSE_DIR = process.env.AXBENCH_AXUSE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORK = process.env.AXBENCH_WORK ?? join(homedir(), ".axbench-tmp");
const SESSIONS_ROOT = join(homedir(), ".codex", "sessions");
// --codex-home <dir>: run every arm except codex-chrome in an isolated Codex
// home (same login, no bundled browser/computer-use plugins). The feature and
// plugin --disable flags do not remove Codex's built-in `cua`/node_repl REPL
// servers, so an arm could still reach another browser layer; a clean home
// takes them away for every arm identically.
const ISO_HOME = (() => { const i = process.argv.indexOf("--codex-home"); return i >= 0 ? process.argv[i + 1] : null; })();
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const MODEL = arg("--model", "gpt-5.6-luna");
const EFFORT = arg("--effort", "medium");
const ARMS = arg("--arms", "codex-chrome,axuse,browser-use").split(",");
const TASKS = arg("--tasks", TASK_IDS.join(",")).split(",");
const REPS = Number(arg("--reps", 1));
const PARALLEL = process.argv.includes("--parallel");
const RUN_TIMEOUT_MS = Number(arg("--timeout", 420_000));
const TAG = arg("--tag", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16));
const OUT = join(AXUSE_DIR, "bench", "suite", "results", `${TAG}.jsonl`);
mkdirSync(join(AXUSE_DIR, "bench", "suite", "results"), { recursive: true });
mkdirSync(WORK, { recursive: true });

const BU_SKILL = (() => {
  try {
    return readFileSync(join(AXUSE_DIR, "bench", "suite", "browser-use-SKILL.md"), "utf8");
  } catch { return null; }
})();

// ---------------------------------------------------------------- tunnels
function startTunnel(port) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.env.CLOUDFLARED ?? "cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    const t = setTimeout(() => reject(new Error("tunnel timeout: " + buf.slice(-500))), 60_000);
    const on = (d) => {
      buf += d;
      const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) { clearTimeout(t); resolve({ url: m[0], proc: p }); }
    };
    p.stdout.on("data", on); p.stderr.on("data", on);
    p.on("exit", (c) => reject(new Error(`cloudflared exited ${c}: ${buf.slice(-500)}`)));
  });
}
async function waitPublic(url) {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(url + "/healthz", { signal: AbortSignal.timeout(5000) }); if (r.ok) return; } catch {}
    await new Promise((ok) => setTimeout(ok, 2000));
  }
  throw new Error("public URL never became reachable: " + url);
}

// --------------------------------------------------- browser-use's Chrome
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
async function launchChromeForBU(runId) {
  const port = await freePort();
  const dir = join(WORK, "bu-profiles", runId);
  mkdirSync(dir, { recursive: true });
  const exe = locateBrowser();
  const proc = spawn(exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, "--headless", "--no-first-run", "--no-default-browser-check", "--remote-allow-origins=*", "about:blank"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) break; } catch {}
    await new Promise((ok) => setTimeout(ok, 200));
  }
  return { port, proc, dir };
}

/** Kill only Chrome processes launched with this bench-owned profile dir. */
function killByProfile(dir) {
  const needle = dir.split(/[\\/]/).pop();
  if (process.platform === "win32") {
    spawn("powershell", ["-NoProfile", "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match '${needle}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: "ignore" });
    return;
  }
  // POSIX: pgrep over full command lines, then TERM by pid. Never pkill by
  // bare name — that would take down the user's daily browser.
  try {
    const out = execSync(`pgrep -f '${needle.replace(/'/g, "'\\''")}' || true`, { encoding: "utf8" });
    for (const pid of out.split("\n").map((s) => Number(s.trim())).filter((p) => Number.isInteger(p) && p > 0 && p !== process.pid)) {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
  } catch {}
}

// ---------------------------------------------------------- codex runs
const DISABLE_NATIVE = [
  "--disable", "browser_use", "--disable", "browser_use_external", "--disable", "computer_use",
  "-c", 'plugins."chrome@openai-bundled".enabled=false', "-c", 'plugins."browser@openai-bundled".enabled=false',
  "-c", 'plugins."unified-computer-use@openai-bundled".enabled=false', "-c", 'plugins."computer-use@openai-bundled".enabled=false',
];
const NO_AXUSE = ["-c", "mcp_servers.axuse.enabled=false"];
// An isolated Codex home has no axuse entry to disable, and disabling an
// undefined server is an invalid config (Codex refuses to start).
const NO_AXUSE_ISO = ISO_HOME ? [] : NO_AXUSE;
// The axuse arm runs a FROZEN copy (--axuse-cli), so edits to the working
// tree can never leak into a benchmark in flight.
const AXUSE_CLI = arg("--axuse-cli", null);
// The playwright arm runs a pinned local install of @playwright/mcp (cli.js).
const PW_CLI = arg("--playwright-cli", null);
const PW_FLAGS = PW_CLI ? ["-c", `mcp_servers.playwright.command="node"`, "-c", `mcp_servers.playwright.args=["${PW_CLI.replaceAll("\\", "/")}","--headless","--isolated","--caps","vision","--executable-path","${locateBrowser().replaceAll("\\", "/")}"]`] : [];
const AXUSE_FLAGS = AXUSE_CLI ? ["-c", `mcp_servers.axuse.command="node"`, "-c", `mcp_servers.axuse.args=["${AXUSE_CLI.replaceAll("\\", "/")}","mcp"]`] : [];

const COMMON_RULES =
  "You are running unattended: the user owns this test site and pre-approves every action the task asks for (including changing settings, deleting, submitting) — do not stop to ask for confirmation. " +
  "Rules: do ALL page interaction in the browser. Do NOT use curl, wget, Invoke-WebRequest, Invoke-RestMethod, Python/Node HTTP clients, " +
  "or any other non-browser HTTP request against the task site — those endpoints reject non-browser requests. " +
  "Do not read local files to find answers. When done, reply with ONLY the requested value.\n\n";

const ARM = {
  "codex-chrome": {
    flags: [...NO_AXUSE],
    env: {},
    directive: () => "Use your built-in browser tools (the Codex Chrome browser extension, which controls the user's Chrome) for this task.\n",
    evidence: (calls) => calls.some((c) => (c.name === "js" || c.name === "exec") && /tab|browser|goto|playwright|cua\./i.test(c.args)),
    foreign: (calls) => calls.some((c) => /^ax_|mcp__axuse/.test(c.name) || /mcp__axuse|browser-use/.test(c.args)),
  },
  axuse: {
    flags: [...DISABLE_NATIVE, ...AXUSE_FLAGS],
    env: { AXUSE_HEADLESS: "1", AXUSE_PROFILE_DIR: join(WORK, "axuse-profiles") },
    directive: () => "Use the axuse MCP browser tools (ax_open, ax_click, ax_type, …) for this task. They launch their own browser.\n",
    evidence: (calls) => calls.some((c) => /ax_/.test(c.name) || /mcp__axuse__ax_/.test(c.args)),
    foreign: (calls) => calls.some((c) => (c.name === "js" && /cua\.|tabs\.new|playwright/.test(c.args)) || /browser-use/.test(c.args)),
  },
  playwright: {
    flags: [...DISABLE_NATIVE, ...NO_AXUSE_ISO, ...PW_FLAGS],
    env: {},
    directive: () => "Use the Playwright MCP browser tools (browser_navigate, browser_snapshot, browser_click, …) for this task. They launch their own browser.\n",
    evidence: (calls) => calls.some((c) => /mcp__playwright__browser_/.test(c.args) || /playwright/.test(c.name)),
    foreign: (calls) => calls.some((c) => /^ax_|mcp__axuse/.test(c.name) || /mcp__axuse|browser-use/.test(c.args) || (c.name === "js" && /cua\.|tabs\.new/.test(c.args))),
  },
  "browser-use": {
    flags: [...DISABLE_NATIVE, ...NO_AXUSE_ISO],
    env: {},
    directive: () =>
      "Use the browser-use CLI (`browser-use`, already installed and on PATH) for this task. A dedicated Chrome is already running and configured via BU_CDP_URL. " +
      "Its official skill documentation follows.\n\n<skill name=\"browser-use\">\n" + BU_SKILL + "\n</skill>\n\n",
    evidence: (calls) => calls.some((c) => /browser-use/.test(c.args)),
    foreign: (calls) => calls.some((c) => /^ax_|mcp__axuse/.test(c.name) || /mcp__axuse/.test(c.args) || (c.name === "js" && /cua\.|tabs\.new/.test(c.args))),
  },
};

function runCodex(armName, prompt, cwd, extraEnv) {
  const arm = ARM[armName];
  const args = ["exec", "-s", "danger-full-access", "--skip-git-repo-check", "-m", MODEL, "-c", `model_reasoning_effort="${EFFORT}"`, ...arm.flags, prompt];
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn("codex", args, { cwd, env: { ...process.env, ...arm.env, ...extraEnv, ...(ISO_HOME && armName !== "codex-chrome" ? { CODEX_HOME: ISO_HOME } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => { try { child.kill(); } catch {} ; spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }); }, RUN_TIMEOUT_MS);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, wallMs: Date.now() - t0, stdout, stderr, timedOut: Date.now() - t0 >= RUN_TIMEOUT_MS - 1000 }); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: "spawn-error " + e.message, wallMs: Date.now() - t0, stdout, stderr, timedOut: false }); });
  });
}

function findSession(sessionId) {
  if (!sessionId) return null;
  const hits = [];
  const walk = (d) => { let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.includes(sessionId)) hits.push(p); } };
  walk(SESSIONS_ROOT);
  if (ISO_HOME) walk(join(ISO_HOME, "sessions"));
  return hits[0] ?? null;
}
const outText = (p) => typeof p.output === "string" ? p.output : Array.isArray(p.output) ? p.output.map((x) => x.text ?? "").join("") : "";
function parseSession(file) {
  const calls = [], byId = new Map();
  let tokens = null, turns = 0, finalMsg = "", images = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const p = o.payload ?? {};
    if (o.type === "response_item") {
      if (p.type === "function_call" || p.type === "custom_tool_call") {
        const rec = { name: p.name, args: String(p.arguments ?? p.input ?? ""), outChars: 0 };
        byId.set(p.call_id, rec); calls.push(rec);
      } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
        const rec = byId.get(p.call_id);
        if (rec) {
          rec.outChars = outText(p).length;
          if (Array.isArray(p.output)) images += p.output.filter((x) => x.type === "input_image").length;
        }
      }
    } else if (o.type === "token_usage_record") {
      turns++;
      if (p.thread_token_usage) tokens = p.thread_token_usage;
    } else if (o.type === "event_msg" && p.type === "token_count" && p.info?.total_token_usage) {
      tokens ??= null; // older format fallback
      if (!tokens) tokens = p.info.total_token_usage;
    } else if (o.type === "event_msg" && p.type === "task_complete") {
      finalMsg = p.last_agent_message ?? "";
    }
  }
  return { calls, tokens, turns, finalMsg, images };
}

const HTTP_CLIENT = /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|requests\.(get|post)|urllib|http\.client|httpx|aiohttp|WebClient|net\/http)\b|(^|[^.\w])fetch\(/i;
function violations(calls, hosts) {
  const v = [];
  for (const c of calls) {
    const text = c.args;
    if (!hosts.some((h) => text.includes(h))) continue;
    // In-browser JS (page context) is browser behaviour; shell HTTP is not.
    const isShell = c.name === "exec_command" || c.name === "shell" || (c.name === "exec" && /exec_command|shell/.test(text));
    if (isShell && HTTP_CLIENT.test(text) && !/browser-use\s*<</.test(text)) v.push(text.slice(0, 200));
  }
  return v;
}

// ------------------------------------------------------------------ main
async function main() {
  if (ARMS.includes("playwright") && !PW_CLI) throw new Error("playwright arm needs --playwright-cli <path to @playwright/mcp/cli.js>");
  if (ARMS.includes("browser-use") && !BU_SKILL) throw new Error("bench/suite/browser-use-SKILL.md missing (run: browser-use skill show > that file)");
  const suite = await startSuite();
  const [tp, tc] = await Promise.all([startTunnel(suite.parentPort), startTunnel(suite.childPort)]);
  suite.setPublic({ parent: tp.url, child: tc.url });
  await Promise.all([waitPublic(tp.url), waitPublic(tc.url)]);
  const hosts = [new URL(tp.url).host, new URL(tc.url).host, `127.0.0.1:${suite.parentPort}`, `127.0.0.1:${suite.childPort}`];
  console.log(`public: parent=${tp.url} child=${tc.url}`);
  console.log(`model=${MODEL} effort=${EFFORT} arms=${ARMS} tasks=${TASKS.length} reps=${REPS} parallel=${PARALLEL} → ${OUT}`);

  const one = async (task, armName, rep) => {
    const run = `${task}-${armName}-${rep}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
    // Local-dev tasks use the loopback address, exactly like testing your own dev server.
    const url = LOCAL_TASKS.has(task) ? `http://127.0.0.1:${suite.parentPort}/${task}?run=${run}` : `${tp.url}/${task}?run=${run}`;
    const cwd = join(WORK, "ws", run); mkdirSync(cwd, { recursive: true });
    let uploadFile = null;
    if (task === "t23") { // the file to upload lives in the run's working dir
      const g = suite.truth(run);
      uploadFile = join(cwd, g.t23.want).replaceAll("\\", "/");
      writeFileSync(uploadFile, g.t23.content);
    }
    const prompt = ARM[armName].directive() + COMMON_RULES + PROMPTS[task](url, suite.truth(run), uploadFile);
    let bu = null, extraEnv = {};
    if (armName === "browser-use") {
      bu = await launchChromeForBU(run);
      extraEnv = { BU_CDP_URL: `http://127.0.0.1:${bu.port}`, BU_NAME: run.replace(/[^a-z0-9]/gi, "").slice(-12), BH_TAB_MARKER: "0", PYTHONUTF8: "1" };
    }
    const r = await runCodex(armName, prompt, cwd, extraEnv);
    if (bu) {
      spawn("browser-use", ["--reload"], { env: { ...process.env, ...extraEnv }, stdio: "ignore" });
      try { bu.proc.kill(); } catch {}
      killByProfile(bu.dir);
      setTimeout(() => { try { rmSync(bu.dir, { recursive: true, force: true }); } catch {} }, 4000);
    }
    const truth = suite.truth(run);
    const sid = (r.stderr.match(/session id:\s*([0-9a-f-]{36})/) ?? [])[1];
    const file = findSession(sid);
    const s = file ? parseSession(file) : { calls: [], tokens: null, turns: 0, finalMsg: "", images: 0 };
    const answer = String(s.finalMsg || r.stdout || "").trim();
    const viol = violations(s.calls, hosts);
    const evidence = ARM[armName].evidence(s.calls);
    const foreign = ARM[armName].foreign(s.calls);
    const scored = SCORE[task](truth, answer);
    const success = scored && !viol.length && evidence && !foreign;
    const toolOut = s.calls.reduce((a, c) => a + c.outChars, 0);
    const rec = {
      run, task, arm: armName, rep, model: MODEL, effort: EFFORT,
      success, scored, violations: viol, evidence, foreign,
      wallMs: r.wallMs, timedOut: r.timedOut, exit: r.code,
      turns: s.turns, toolCalls: s.calls.length, images: s.images, toolOutChars: toolOut,
      tokens: s.tokens, answer: answer.slice(0, 120), sessionFile: file,
      // Server-side truth for this task (audit trail; large static data omitted).
      truth: (() => { const t = { ...truth[task] }; delete t.rows; delete t.feed; delete t.orders; delete t.circles; return t; })(),
      tools: Object.entries(s.calls.reduce((m, c) => ((m[c.name] = (m[c.name] ?? 0) + 1), m), {})).map(([k, v]) => `${k}:${v}`).join(" "),
    };
    appendFileSync(OUT, JSON.stringify(rec) + "\n");
    const tok = s.tokens ? `${s.tokens.total_tokens?.toLocaleString()} (in ${s.tokens.input_tokens?.toLocaleString()}, cached ${s.tokens.cached_input_tokens?.toLocaleString()}, out ${s.tokens.output_tokens?.toLocaleString()})` : "?";
    console.log(`${success ? "PASS" : "FAIL"} ${task.padEnd(4)} ${armName.padEnd(12)} r${rep} ${String(Math.round(r.wallMs / 1000)).padStart(4)}s turns=${s.turns} calls=${s.calls.length} tok=${tok}${viol.length ? " VIOLATION" : ""}${!evidence ? " NO-EVIDENCE" : ""}${foreign ? " FOREIGN" : ""}${!scored ? ` [answer="${answer.slice(0, 40)}"]` : ""}${!file ? ` NO-SESSION [codex: ${String(r.stderr).trim().split("\n").slice(-1)[0].slice(0, 160)}]` : ""}`);
    try { rmSync(cwd, { recursive: true, force: true }); } catch {}
    return rec;
  };

  for (let rep = 1; rep <= REPS; rep++) {
    for (const task of TASKS) {
      // Arm order rotates per task+rep so no arm systematically goes first.
      const k = (TASKS.indexOf(task) + rep) % ARMS.length;
      const order = [...ARMS.slice(k), ...ARMS.slice(0, k)];
      if (PARALLEL) await Promise.all(order.map((a) => one(task, a, rep)));
      else for (const a of order) await one(task, a, rep);
    }
  }
  tp.proc.kill(); tc.proc.kill(); suite.close();
  console.log(`done → ${OUT}\nsummarize: node bench/suite/summarize.mjs ${OUT}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
