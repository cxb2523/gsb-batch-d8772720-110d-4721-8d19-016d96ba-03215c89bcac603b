/**
 * Harness portability check: the SAME axuse MCP server, unmodified, driven by
 * other agent harnesses. Uses the suite's server-side scoring.
 *   node bench/suite/portability.mjs [--harness claude,opencode] [--tasks t1,t5,t9]
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { startSuite, PROMPTS, SCORE } from "./server.mjs";

const AXUSE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AXUSE_CLI = join(AXUSE_ROOT, "src", "cli.js");
const WORK = join(homedir(), ".axbench-tmp", "port");
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const HARNESSES = arg("--harness", "claude").split(",");
const TASKS = arg("--tasks", "t1,t5,t9,t10").split(",");
const OUT = join(AXUSE_ROOT, "bench", "suite", "results", `portability-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16)}.jsonl`);
mkdirSync(WORK, { recursive: true });
const env = { ...process.env, AXUSE_HEADLESS: "1", AXUSE_PROFILE_DIR: join(homedir(), ".axbench-tmp", "axuse-profiles") };
const RULES = "You are running unattended; every action is pre-approved. Use the axuse MCP tools (ax_*) for all browser interaction; do not use HTTP clients. Reply with ONLY the requested value.\n\n";

function run(cmd, args, cwd) {
  return new Promise((ok) => {
    const t0 = Date.now();
    const p = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" && !cmd.endsWith(".exe") });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => p.kill(), 300_000);
    p.on("exit", (code) => { clearTimeout(t); ok({ code, out, err, ms: Date.now() - t0 }); });
  });
}

const H = {
  async claude(prompt, cwd) {
    const cfg = join(cwd, "mcp.json");
    writeFileSync(cfg, JSON.stringify({ mcpServers: { axuse: { command: "node", args: [AXUSE_CLI, "mcp"], env: { AXUSE_HEADLESS: "1" } } } }));
    const r = await run("claude", ["-p", JSON.stringify(prompt), "--mcp-config", cfg, "--strict-mcp-config", "--allowedTools", "mcp__axuse", "--output-format", "json"], cwd);
    let j = {}; try { j = JSON.parse(r.out.trim().split("\n").pop()); } catch {}
    return { answer: j.result ?? r.out, ms: r.ms, turns: j.num_turns, usage: j.usage, err: r.code ? r.err.slice(0, 300) : undefined };
  },
  async opencode(prompt, cwd) {
    writeFileSync(join(cwd, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: { axuse: { type: "local", command: ["node", AXUSE_CLI, "mcp"], enabled: true, environment: { AXUSE_HEADLESS: "1" } } } }));
    const r = await run("opencode", ["run", JSON.stringify(prompt)], cwd);
    return { answer: r.out.trim().split("\n").filter(Boolean).pop() ?? "", ms: r.ms, err: r.code ? r.err.slice(0, 300) : undefined };
  },
};

const s = await startSuite();
for (const h of HARNESSES) {
  for (const t of TASKS) {
    const runId = `port-${h}-${t}-${Date.now().toString(36)}`;
    const cwd = join(WORK, runId); mkdirSync(cwd, { recursive: true });
    const r = await H[h](RULES + PROMPTS[t](`${s.base.parent}/${t}?run=${runId}`, s.truth(runId)), cwd);
    const ok = SCORE[t](s.truth(runId), String(r.answer ?? ""));
    appendFileSync(OUT, JSON.stringify({ harness: h, task: t, success: ok, ...r }) + "\n");
    console.log(`${ok ? "PASS" : "FAIL"} ${h} ${t} ${Math.round(r.ms / 1000)}s answer=${String(r.answer).slice(0, 40)}${r.err ? " err=" + r.err : ""}`);
  }
}
s.close();
process.exit(0);
