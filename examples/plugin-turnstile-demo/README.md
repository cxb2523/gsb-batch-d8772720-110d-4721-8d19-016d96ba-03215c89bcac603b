# Example solver plugin — `turnstile-demo` (free for noncommercial use, PolyForm Noncommercial 1.0.0)

A complete, minimal, working solver for **Cloudflare Turnstile on demo/test
pages**. Shipped with axuse under the PolyForm Noncommercial 1.0.0 license to
prove the plugin seam end-to-end —
production CAPTCHA solving (all providers, image challenges, vision loops) is
the domain of separate commercial packages such as `captcha-pro`.

## What it demonstrates

- The full plugin ABI: `{ id, version, providers, solve(provider, ctx, opts) }`
- The narrow `ctx` in action: `evaluate`, `click`, `waitFor`/`wait`, deadline math
- Facts-only results: `{ solved, token, elapsedMs, notes }` — never a fabricated token
- Zero-dependency, single-file, no configuration

## Run it

```bash
# Load it without copying: point the search path at this directory
set AXUSE_PLUGINS=E:\path\to\axuse\examples\plugin-turnstile-demo
node src/cli.js plugins

# Solve (Cloudflare's official demo, test sitekey)
node src/cli.js solve turnstile --url https://demo.turnstile.workers.dev/
```

Or copy this folder into axuse's `plugins/` directory — same effect.

## Authoring your own solver

Read [`docs/plugins.md`](../../docs/plugins.md) for the contract, the `ctx`
reference, and packaging/licensing guidance.
