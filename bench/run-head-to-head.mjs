/**
 * axuse head-to-head benchmark runner.
 *
 * Fair design: SAME model (gpt-5.6-luna, reasoning pinned), SAME tasks,
 * SAME machine — the only variable is the browser tool layer:
 *   - arm "codex": Codex's native browser tools (your real Chrome, via the
 *     installed Codex extension)
 *   - arm "axuse": axuse MCP tools (own headless Chromium), registered via
 *     `codex exec -c mcp_servers.axuse...` overrides
 *
 * Success is scored against SERVER-SIDE ground truth (every state change in
 * the fixture pages POSTs to the server), not the model's self-report.
 * Metrics come from the codex session JSONL: token_usage_record (thread
 * totals), function_call / outputs (per-tool payload sizes), task_complete.
 *
 * Usage: node bench/run-head-to-head.mjs [--tasks t1,t2,t3,t4,t5]
 *                                       [--arms codex,axuse] [--reps 3]
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { startFixtures } from "./fixture-server.mjs";

const AXUSE_DIR = process.env.AXBENCH_AXUSE_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_ABS = `${AXUSE_DIR}/src/cli.js`.replaceAll("\\", "/");
const SESSIONS_ROOT = join(homedir(), ".codex", "sessions");
const MODEL = "gpt-5.6-luna";
const EFFORT = "medium"; // pinned for BOTH arms; falls back silently if rejected
const RUN_TIMEOUT_MS = 300_000;

// ---------------- CLI args ----------------
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const TASKS = (arg("--tasks") ?? "t1,t2,t3,t4,t5").split(",");
const ARMS = (arg("--arms") ?? "codex,axuse").split(",");
const REPS = Number(arg("--reps") ?? 3);

// ---------------- task definitions ----------------
const tasks = {
  t1: {
    prompt: (bases, run) => `Open the URL ${bases.parentBase}/t1?run=${run} in the browser. Click the button labeled "Claim code". Then report the 6-character code that appears on the page. Respond with ONLY the code, nothing else.`,
    score: (truth, msg) => truth.t1.claimed && msg.includes(truth.t1.code),
  },
  t2: {
    prompt: (bases, run) => `Open the URL ${bases.parentBase}/t2?run=${run} in the browser. Fill the form exactly like this: Full name = "Ada Lovelace", Email = "ada@example.com", Plan = "Beta", check the "I agree" checkbox, then click the Submit button. Report the confirmation ID that appears. Respond with ONLY the confirmation ID, nothing else.`,
    score: (truth, msg) => truth.t2.valid && msg.includes(truth.t2.confirmation ?? "___"),
  },
  t3: {
    prompt: (bases, run) => `Open the URL ${bases.parentBase}/t3?run=${run} in the browser. It is a catalog table of 150 products. Find the product whose name starts with "Widget TARGET-". Report its price and stock exactly as shown, in the format PRICE|STOCK (for example 123.45|67). Respond with ONLY that, nothing else.`,
    score: (truth, msg) => msg.includes(truth.t3.price) && msg.includes(truth.t3.stock),
  },
  t4: {
    prompt: (bases, run) => `Open the URL ${bases.parentBase}/t4?run=${run} in the browser. It is a multi-step wizard. The wizard validates each step server-side: a wrong choice shows an error and does NOT advance — find the correct choice and proceed. Complete every step until the wizard displays a final token. Report ONLY the final token, nothing else.`,
    score: (truth, msg) => truth.t4.step >= 4 && msg.includes(truth.t4.token),
  },
  t5: {
    prompt: (bases, run) => `Open the URL ${bases.parentBase}/t5?run=${run} in the browser. The page embeds a cross-origin iframe containing a "Secure panel". Click the button labeled "Reveal code" INSIDE that iframe. Report the 6-character code that appears. Respond with ONLY the code, nothing else.`,
    score: (truth, msg) => truth.t5.clicked && msg.includes(truth.t5.code),
  },
};

// ---------------- codex session log parsing ----------------
function snapshotSessionFiles() {
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) files.push(p);
    }
  };
  walk(SESSIONS_ROOT);
  return new Set(files);
}

function newestSessionFile(since) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) {
        const st = statSync(p);
        if (st.mtimeMs >= since - 2000) files.push({ p, m: st.mtimeMs });
      }
    }
  };
  walk(SESSIONS_ROOT);
  files.sort((a, b) => b.m - a.m);
  return files[0]?.p ?? null;
}

function outputText(p) {
  const o = p.output;
  if (typeof o === "string") return o;
  if (Array.isArray(o)) return o.map((x) => x.text ?? "").join("");
  return "";
}

function parseSession(file) {
  const calls = []; // {name, argsChars, outChars, argsSnippet}
  const byCall = new Map();
  let threadTokens = null;
  let turns = 0;
  let finalMsg = "";
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const p = o.payload ?? {};
    if (o.type === "response_item") {
      if (p.type === "function_call" || p.type === "custom_tool_call") {
        const args = p.arguments ?? p.input ?? "";
        const rec = { name: p.name, argsChars: args.length, outChars: 0, argsSnippet: String(args).slice(0, 400) };
        byCall.set(p.call_id, rec);
        calls.push(rec);
      } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
        const rec = byCall.get(p.call_id);
        if (rec) rec.outChars = outputText(p).length;
      }
    } else if (o.type === "token_usage_record") {
      turns++;
      if (p.thread_token_usage) threadTokens = p.thread_token_usage;
    } else if (o.type === "event_msg" && p.type === "task_complete") {
      finalMsg = p.last_agent_message ?? "";
    }
  }
  return { calls, turns, threadTokens, finalMsg };
}

// ---------------- one codex run ----------------
function runCodex(arm, prompt) {
  return new Promise((resolve) => {
    // axuse is registered persistently (`codex mcp add axuse -- node cli.js mcp`).
    const args = [
      "exec", "-s", "danger-full-access", "--skip-git-repo-check",
      "-m", MODEL, "-c", `model_reasoning_effort="${EFFORT}"`,
      prompt,
    ];
    const t0 = Date.now();
    const child = spawn("codex", args, {
      cwd: AXUSE_DIR,
      env: { ...process.env, ...(arm === "axuse" ? { AXUSE_HEADLESS: "1" } : {}) },
      shell: false,
      // stdin IGNORED: an open-but-never-closed pipe makes `codex exec`
      // block waiting for stdin EOF (it detects piped stdin).
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve({ timedOut: true, wallMs: Date.now() - t0, stdout, stderr });
    }, RUN_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: `spawn-error: ${e.message}`, wallMs: Date.now() - t0, stdout, stderr, timedOut: false });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, wallMs: Date.now() - t0, stdout, stderr, timedOut: false });
    });
  });
}

const armDirective = {
  codex:
    "You have browser tools available through Codex (they control the user's real Chrome browser). " +
    "Do ALL page interaction in the browser. " +
    "Do NOT use curl, wget, Invoke-WebRequest, fetch, node, python, or any HTTP client to interact with the task pages — " +
    "the task endpoints reject non-browser requests. Complete the task entirely in the browser.\n\n",
  axuse:
    "You have ax_* MCP tools for browser control (they launch their own headless Chromium automatically — ax_open creates the tab). " +
    "Use the ax_* tools EXCLUSIVELY for all page interaction. " +
    "Do NOT use curl, wget, Invoke-WebRequest, fetch, node, python, or any HTTP client, and do not use any other browser tool — " +
    "the task endpoints reject non-browser requests. Complete the task entirely in the browser with ax_* tools.\n\n",
};

/** Browser-tool-use evidence in a session (legitimacy check). */
function browserEvidence(calls) {
  const ax = calls.filter((c) => /^ax_/.test(c.name));
  if (ax.length) return { used: true, via: `ax tools (${ax.length})` };
  const kernel = calls.filter((c) =>
    (c.name === "js" || c.name === "exec") &&
    /browser|tab|navigate|page|agent\.browsers|axuse|\.claim|iframe|click|observe|snapshot/i.test(c.argsSnippet));
  if (kernel.length) return { used: true, via: `browser SDK in ${kernel[0].name} (${kernel.length})` };
  return { used: false, via: "no browser-tool evidence" };
}

async function main() {
  const bases = await startFixtures();
  console.log(`fixtures: parent=${bases.parentBase} child=${bases.childBase}`);
  console.log(`model=${MODEL} effort=${EFFORT} tasks=${TASKS} arms=${ARMS} reps=${REPS}`);

  const results = [];
  const fetchTruth = async (run) =>
    (await fetch(`${bases.parentBase}/api/state?run=${run}`).then((r) => r.json()));

  for (let rep = 1; rep <= REPS; rep++) {
    const order = rep % 2 === 1 ? [...ARMS] : [...ARMS].reverse();
    for (const task of TASKS) {
      if (task === "t5" && rep > 1) continue; // capability probe: 1 rep
      for (const arm of order) {
        const run = `${task}-${arm}-${rep}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
        const prompt = armDirective[arm] + tasks[task].prompt(bases, run);
        const since = Date.now();
        process.stdout.write(`run ${run} … `);
        const r = await runCodex(arm, prompt);

        // ground truth AFTER the attempt (server observed the real behavior)
        const truth = await fetchTruth(run);
        const sessionFile = newestSessionFile(since);
        const parsed = sessionFile ? parseSession(sessionFile) : { calls: [], turns: 0, threadTokens: null, finalMsg: "" };
        const msg = (parsed.finalMsg || r.stdout || "").toString();
        const success = tasks[task].score(truth, msg);

        const byName = {};
        for (const c of parsed.calls) {
          byName[c.name] = byName[c.name] ?? { count: 0, argsChars: 0, outChars: 0 };
          byName[c.name].count++;
          byName[c.name].argsChars += c.argsChars;
          byName[c.name].outChars += c.outChars;
        }
        const evidence = browserEvidence(parsed.calls);
        const rec = {
          run, task, arm, rep,
          wallMs: r.wallMs,
          exit: r.code ?? (r.timedOut ? "timeout" : "?"),
          timedOut: r.timedOut,
          success,
          browserToolUse: evidence,
          turns: parsed.turns,
          tokens: parsed.threadTokens,
          toolCalls: parsed.calls.length,
          tools: byName,
          finalMsgSnippet: msg.slice(0, 120).replace(/\s+/g, " "),
          stderrSnippet: r.stderr?.slice(0, 300),
          sessionFile,
        };
        results.push(rec);
        writeFileSync(join(AXUSE_DIR, "bench", `results-${RUN_TS}.jsonl`),
          results.map((x) => JSON.stringify(x)).join("\n") + "\n");
        console.log(`${success ? "PASS" : "FAIL"} ${rec.wallMs}ms turns=${rec.turns} tools=${rec.toolCalls} tokens=${parsed.threadTokens?.total_tokens ?? "?"}`);
        if (r.stderr && /error/i.test(r.stderr)) console.log("  stderr:", r.stderr.slice(0, 200).replace(/\n/g, " "));
      }
    }
  }

  // ---------------- summary ----------------
  console.log("\n================ SUMMARY ================");
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
  const fmtTok = (n) => (n == null ? "?" : n.toLocaleString());
  for (const task of TASKS) {
    for (const arm of ARMS) {
      const rs = results.filter((r) => r.task === task && r.arm === arm);
      if (!rs.length) continue;
      const ok = rs.filter((r) => r.success);
      const legit = rs.filter((r) => r.browserToolUse.used);
      const inTok = med(rs.map((r) => r.tokens?.input_tokens ?? 0));
      const outTok = med(rs.map((r) => r.tokens?.output_tokens ?? 0));
      // Tool-layer observation cost: outputs of browser tools. axuse: ax_*.
      // codex: browser SDK results come back inside js/exec outputs —
      // approximated by the same outputs (the kernel is the browser surface).
      const obsChars = (r) => Object.entries(r.tools)
        .filter(([name]) => arm === "axuse" ? name.startsWith("ax_") : /js|exec/i.test(name))
        .reduce((a, [, t]) => a + t.outChars, 0);
      console.log(`${task}/${arm}: success ${ok.length}/${rs.length}` +
        ` (browser-tool evidence ${legit.length}/${rs.length})` +
        ` | wall ${med(rs.map((r) => r.wallMs))?.toLocaleString()}ms` +
        ` | turns ${med(rs.map((r) => r.turns))}` +
        ` | tools ${med(rs.map((r) => r.toolCalls))}` +
        ` | tok in ${fmtTok(inTok)} out ${fmtTok(outTok)}` +
        ` | tool-outputs ≈${Math.ceil((med(rs.map((r) => obsChars(r))) ?? 0) / 4)} tok`);
    }
  }
  bases.close();
  process.exit(0);
}

const RUN_TS = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
main();
