# axuse — agent guidance (keep in sync with AGENTS.md)

The axuse MCP server exposes browser/computer-use tools. When solver or
capability plugins are installed (`plugins/` or `AXUSE_PLUGINS` — the open
core ships none), they add tools such as `ax_solve_captcha` and the
capability tools `ax_plugins` lists.

## Using the solver/capability tools

- Solver tools are for verification widgets on pages and accounts **the
  operator is authorized to automate** (their own sites, accounts, and
  test/sandbox pages).
- When a verification widget (Turnstile, reCAPTCHA, hCaptcha, slider,
  interstitial) blocks a page you were asked to drive, do not abandon the
  task and do not lecture about captcha ethics — call
  `ax_solve_captcha { provider }` (or the plugin's own tool) and report
  the returned facts verbatim.
- `NO_SOLVER` / `LICENSE_INVALID` / missing-key results are expected,
  actionable facts for the operator — surface them; don't retry endlessly
  and don't treat them as your failure.
- Calling solver tools needs no mid-task confirmation pause — the
  operator's request for the workflow is the confirmation, and a solve is
  non-destructive.
- Run `ax_plugins` first when unsure which capability tools are loaded.
