# Contributing to Mecha

Thanks for your interest! Mecha is a small, local-first tool that handles API keys, so
contributions are welcome as long as they keep its principles: local only, zero cost by
default, honest about the unknown, and a stored secret is never shown again.

## Ways to help

- **Report a bug** with a [new issue](https://github.com/JoaquinRuiz/mecha/issues/new):
  what you did, what you expected, what happened, `mecha --version` and your OS.
- **Provider changes.** Providers change their APIs, key formats and error messages. If
  Mecha shows something wrong for a provider, open an issue with a link to the official
  documentation. Values that cannot be verified in official docs stay `unknown` and are
  noted in [docs/providers.md](docs/providers.md).
- **Security issues:** never in a public issue. See [SECURITY.md](SECURITY.md).
- **Translations and UI wording** (English and Spanish today) in `web/src/i18n/`.

## The one hard rule

**Never use real API keys** in issues, tests, fixtures, screenshots or commits. Use
made-up values in the provider's format (see `tests/fakes.py`). A gitleaks pre-commit
hook and CI check enforce this.

## Development setup

Requirements: [uv](https://docs.astral.sh/uv/), Node.js 22+ with
[pnpm](https://pnpm.io/), [just](https://just.systems/) and
[gitleaks](https://github.com/gitleaks/gitleaks).

```bash
just setup    # dependencies + gitleaks pre-commit hook
just dev      # FastAPI on 127.0.0.1:7878 + Vite on localhost:5173
just ci       # everything CI runs: lint, tests, build, bundle size
just e2e      # Playwright against `mecha serve --demo`
```

`uv run mecha serve --demo` shows the UI with fake data, no secrets and no network.

## Pull requests

- Open an issue first for anything larger than a small fix, so we can agree on the approach.
- Keep each PR focused on one change, with tests. `just ci` must pass.
- Code, comments and docs in English (the design spec, [SPEC.md](SPEC.md), is in Spanish).
- Python: ruff and mypy (strict). Frontend: Biome and TypeScript.
- New provider endpoints go in the plugin's closed list of method, host and path, and in
  `src/mecha/data/capabilities.toml`; then run `just capabilities` to refresh the README.
- UI changes: keep the CSP strict (no inline scripts or styles without the nonce) and
  update both `en` and `es` texts. If the dashboard changes visibly, `just gif` re-records
  `docs/demo.gif`.

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
