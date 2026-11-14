# Solver plugins — the paid install target

axuse's open core ships **no solvers**. CAPTCHA solvers (Cloudflare Turnstile,
hCaptcha, reCAPTCHA) are **separate, commercially licensed packages** that plug
into axuse through the thin plugin seam in `src/plugins/`.

This directory is the default install target. It is git-ignored except for this
README: whatever you drop here stays on your machine and out of the open repo.

## Install

1. Obtain a solver package (e.g. `captcha-pro`), either as a directory or a
   `.tgz`.
2. Place it here: `plugins/captcha-pro/` (must contain `index.js` or a
   `package.json` with a `main`).
3. Configure the package (its own env vars — see its README).
4. Verify:

   ```bash
   node src/cli.js plugins      # → ✓ captcha-pro@1.0.0 — providers: ...
   node src/cli.js solve turnstile --url https://demo.turnstile.workers.dev/
   ```

Or point axuse elsewhere (before the MCP server starts):

```bash
set AXUSE_PLUGINS=D:\paid-solvers;E:\more-solvers
```

## Where solvers appear

- CLI: `axuse plugins`, `axuse solve <provider> [--url …]`
- MCP tools: `ax_solve_captcha { provider, url? }` and `ax_plugins`
  (both present in every harness once a plugin is loaded)
- Plugins may also contribute their **own MCP tools** (a validated `tools()`
  export — e.g. `ax_vault`, `ax_net`, `ax_guard`); see
  [`docs/plugins.md`](../docs/plugins.md) for the exact contract.

## Authoring your own

See [`docs/plugins.md`](../docs/plugins.md) for the frozen plugin ABI and
[`examples/plugin-turnstile-demo/`](../examples/plugin-turnstile-demo/) for a
complete, free, working reference solver.
