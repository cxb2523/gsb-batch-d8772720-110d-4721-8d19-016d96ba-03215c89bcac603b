# axuse benchmark suite v2

A head-to-head benchmark of browser-use **tool layers** for coding-agent
harnesses. Same harness (Codex CLI), same model (`gpt-5.6-luna`, reasoning
`medium`), same 16 tasks, same machine. The **only** variable is the browser
layer:

| arm | what the model drives |
|---|---|
| `codex-chrome` | Codex's own browser use: the Codex Chrome extension in the user's real Chrome (Codex's built-in plugin + skill) |
| `axuse` | the axuse MCP server (its own headless Chromium) |
| `browser-use` | [browser-use](https://github.com/browser-use/browser-use) 0.13 CLI + its official `SKILL.md`, attached to a dedicated headless Chrome via `BU_CDP_URL` |
| `playwright` | Microsoft's [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) (pinned local install via `--playwright-cli`), headless Chrome, isolated profile, `--caps vision` |

## Tasks

Deterministic, per-run seeded pages (`server.mjs`) covering what real browser
agents trip over:

| id | capability | pass condition (server-side) |
|---|---|---|
| t1 | click → reveal | claim endpoint hit + code reported |
| t2 | form fill (text, email, select, checkbox) | exact values submitted |
| t3 | 150-row table lookup | price + stock reported |
| t4 | 4-step wizard with server validation | all steps + token |
| t5 | cross-origin iframe (OOPIF) | click inside iframe |
| t6 | nested shadow DOM switches + radios | exact settings saved |
| t7 | infinite scroll feed (300 posts, lazy pages) | exactly the target post liked |
| t8 | hover-only menu | export clicked, never "Delete account" |
| t9 | `confirm()` → `prompt()` dialog chain | only the target file deleted, reason "cleanup" |
| t10 | `target=_blank` new tab round trip | help tab visited + code verified |
| t11 | async job (5 s) then download | download after ready |
| t12 | pointer-events drag & drop (kanban) | card in Done |
| t13 | contenteditable editor | exact text published |
| t14 | ARIA autocomplete combobox + custom listbox | Zurich / Switzerland saved |
| t15 | debounced search + pagination | right order's details opened |
| t16 | canvas (no DOM) — needs vision | click inside the red circle |

## Fairness and anti-cheat

- **Public HTTPS fixtures.** The Codex extension refuses localhost / private
  IPs (`ERR_BLOCKED_BY_CLIENT`), so the fixtures are served through two
  Cloudflare quick tunnels (two origins → the t5 iframe is genuinely
  cross-origin). Every arm loads the same public URLs.
- **Server-side scoring.** Every state change POSTs to the fixture server;
  success = server ground truth **and** the reported value. Ground truth is
  only readable with a random bench key.
- **Browser-only endpoints.** Scored endpoints require `Sec-Fetch-*` headers;
  the runner also audits every tool call and disqualifies runs that hit the
  task host with a shell HTTP client.
- **Isolation.** Each run gets an empty working directory outside the repo
  (no peeking at the fixture source). The axuse and browser-use arms run with
  Codex's browser/computer-use features and plugins disabled; the
  codex-chrome and browser-use arms run with axuse disabled; any call into
  another arm's browser layer disqualifies the run.
- **Same instructions.** All arms get the same task text plus the same
  "unattended, pre-approved, no HTTP clients" rules; each arm gets one line
  naming its tools (browser-use additionally gets its official SKILL.md, the
  content Codex would load when that skill triggers).
- **Frozen subject.** The axuse arm runs a frozen copy (`--axuse-cli`), so
  development edits cannot leak into a benchmark in flight.
- **Order rotation.** Arm order rotates per task and repetition.

## Metrics

From the Codex session log of each run: wall time, turns, tool calls, and
thread token totals (`total`, and `fresh` = uncached input + output).
`capability success` excludes runs where the agent stopped to ask the absent
user for confirmation (a safety-policy outcome — reported separately, never
hidden).

## Reproduce

```bash
# once: browser-use CLI + its skill text, cloudflared
uv tool install browser-use==0.13.11
browser-use skill show > bench/suite/browser-use-SKILL.md
winget install Cloudflare.cloudflared

# sanity: every task is solvable and scoring is correct (scripted, no LLM)
node bench/suite/oracle.mjs

# the benchmark (freeze axuse first)
cp -r src package.json bridge /path/to/axuse-frozen/
node bench/suite/run.mjs --reps 3 --tag final --axuse-cli /path/to/axuse-frozen/src/cli.js
node bench/suite/summarize.mjs bench/suite/results/final.jsonl

# portability: the same axuse server in other harnesses
node bench/suite/portability.mjs --harness claude,opencode
```

Results land in `results/*.jsonl` (one line per run, with the session file
path for audit).

### Comparing against another MCP browser tool, in a clean agent home

```bash
# pinned Playwright MCP, installed once
mkdir -p ~/.axbench-tmp/pw-mcp && (cd ~/.axbench-tmp/pw-mcp && npm init -y && npm i @playwright/mcp@0.0.83)

# a Codex home with the same login but none of Codex's bundled browser /
# computer-use plugins (the --disable flags do not remove its built-in `cua`
# and `node_repl` servers, so without this an arm can still reach another layer)
mkdir -p ~/.axbench-tmp/codex-home && cp ~/.codex/auth.json ~/.axbench-tmp/codex-home/ && : > ~/.axbench-tmp/codex-home/config.toml

node bench/suite/run.mjs --arms axuse,playwright --reps 3 --tag compare   --codex-home ~/.axbench-tmp/codex-home   --axuse-cli /path/to/axuse-frozen/src/cli.js   --playwright-cli ~/.axbench-tmp/pw-mcp/node_modules/@playwright/mcp/cli.js
node bench/suite/summarize.mjs bench/suite/results/compare.jsonl
node bench/suite/rescore.mjs bench/suite/results/compare.jsonl   # strict vs "touched the task site" rule
```

`auth.json` holds your login: delete the benchmark home when you are done. A run
that produces no agent session prints the agent's own error (`NO-SESSION`) instead of
a bare FAIL. The result of one such comparison, with its caveats, is in
`PLAYWRIGHT-COMPARISON.md`.
