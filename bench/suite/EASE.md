# Ease of use — measured

Measured on the benchmark machine (Windows 11, 2026-10-15).

| | axuse | Codex + Chrome extension | browser-use 0.13.11 |
|---|---|---|---|
| Install size | **0.2 MB** (src + bridge) | 46.7 MB bundled plugins + 59 MB extension | 228.5 MB (uv tool env) |
| Runtime dependencies | **0** — Node ≥ 22 only | Codex desktop runtime, Chrome + extension | 106 Python packages, uv, Python |
| Setup per harness | **1 line** (`codex mcp add axuse -- node src/cli.js mcp`; `claude mcp add …`; an `opencode.json` block) | built into Codex; not available to other harnesses | `uv tool install`, a Chrome with remote debugging (or `BU_CDP_URL`), plus a skill install per harness |
| Integration surface | MCP (standard tool calls) | Codex-internal JS REPL | shell + Python heredocs written by the model |
| Harnesses verified in this repo | Codex, Claude Code (4/4), OpenCode (2/2) — same server, unmodified | Codex only | any harness with a shell (not separately verified) |

Observed friction during the benchmark (transcripts in each run's Codex session file):

- **Codex + Chrome extension** stopped to ask for confirmation on pre-approved destructive or submitting steps (delete, place order, sign up) in unattended runs. Localhost access was blocked (`ERR_BLOCKED_BY_CLIENT`) on 2026-10-14 but worked on 2026-10-15, so treat it as intermittent.
- **browser-use** relies on the model writing bash heredocs; under PowerShell the first attempt failed with a parse error before the model switched to a PowerShell here-string.
- **axuse** needed no workaround in any harness; the model discovers it through the standard MCP tool list and server instructions.
