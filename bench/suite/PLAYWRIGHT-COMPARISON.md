# axuse vs Playwright MCP — benchmark result

Same harness (Codex CLI), same model (`gpt-5.6-luna`, reasoning `medium`), same 23 tasks,
same machine. Only the browser layer differs: axuse MCP vs `@playwright/mcp` 0.0.83
(`--headless --isolated --caps vision`). Both arms ran in an isolated Codex home with no
built-in `cua` / `node_repl` / bundled browser plugins, so neither arm could reach another
browser layer. Scoring is server-side ground truth, as in `README.md`.

## Result (71 runs per arm)

| | Playwright MCP | axuse |
|---|---|---|
| Passed (strict rules) | 71/71 | 71/71 |
| Median time per task | 16 s | **13 s** |
| Total time | 1493 s | **1183 s** (-21%) |
| Median total tokens | 168k | **144k** |
| Total tokens | 15.38 M | **11.84 M** (-23%) |
| Median tool calls | 8 | **5** |
| Total tool calls | 673 | **402** (-40%) |

Per task, axuse is equal or lower than Playwright on 21 of 23 tasks for time and 23 of 23
for tool calls. It is **behind on tokens in 9 tasks** (t1, t3, t8, t9, t12, t13, t14, t15,
t17, mostly by small margins) and **behind on time in 2** (t5, t10).

## Provenance (read before quoting)

The table merges two runs, as agreed, instead of re-running everything:

- **22 tasks** (all but t7): 3 repetitions each, build *v3* (post-action settling, stale-ref
  recovery, slimmer tool text, screenshot pixel-ratio fix). `results/pw-v3-full2.jsonl`.
- **t7** (infinite-scroll feed): 5 repetitions, build *v4* = v3 + the `ax_observe find`
  fix. `results/pw-t7-v4.jsonl`. The other 22 tasks were **not** re-run on v4.
- Merged file: `results/final-vs-playwright.jsonl` (each row carries its `build`).

The raw per-run logs (`results/*.jsonl`) record local file paths and are not committed; they are available on request (dev@ax-use.com). The harness that produced them is in this folder (see `README.md`, "Comparing against another MCP browser tool").

On v3, axuse **failed 2 of 3 t7 runs** (it liked the neighbouring post because `find`
printed the previous article's Like button next to the match; the task cannot recover from a
wrong like). Those two failures are the reason the t7 rows were replaced; the same v3 run had
Playwright at 3/3 on t7. After the fix, t7 is 5/5 for both arms. 5 runs is a small sample.

## Scoring notes

- Strict rule: a run is disqualified if any call reaches another arm's browser layer.
  `rescore.mjs` also reports a narrower rule (disqualify only if the foreign call touched
  the task site). On this merged set strict and narrow agree: 71/71 for both arms.
- An earlier axuse run was disqualified under the strict rule for one stray
  `cua.getState()` call (correct answer). The isolated Codex home removes that possibility
  for both arms.
- An invalid first full run (Playwright arm never started because of a config error in the
  new isolated home) is kept only as `results/INVALID-pw-v3-full-playwright-arm-never-started.jsonl`.

## Not covered

Public fixture pages with no login and no bot protection: this measures speed, tokens and
accuracy on generic browser tasks, not axuse's other advantages (the user's signed-in
Chrome, challenge handling, workflow plugins). Playwright MCP is also not slow here; the
gap is a median of 3 s and 24k tokens per task.
