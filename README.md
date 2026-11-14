<div align="center">

# 🧨 Mecha

**How much fuse is left on your API keys?**

[![CI](https://github.com/JoaquinRuiz/mecha/actions/workflows/ci.yml/badge.svg)](https://github.com/JoaquinRuiz/mecha/actions/workflows/ci.yml)
[![PyPI](https://img.shields.io/pypi/v/mecha-keys?logo=pypi&logoColor=white&label=PyPI)](https://pypi.org/project/mecha-keys/)
[![Python](https://img.shields.io/badge/python-3.12%20%7C%203.13%20%7C%203.14-3776AB?logo=python&logoColor=white)](https://pypi.org/project/mecha-keys/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Local-first](https://img.shields.io/badge/local--first-127.0.0.1-orange)](#threat-model)
[![No telemetry](https://img.shields.io/badge/telemetry-none-brightgreen)](#principles)

[![Anthropic](https://img.shields.io/badge/Anthropic-191919?logo=anthropic&logoColor=white)](#what-each-provider-tells-mecha)
[![OpenAI](https://img.shields.io/badge/OpenAI-412991)](#what-each-provider-tells-mecha)
[![Gemini](https://img.shields.io/badge/Gemini-8E75B2?logo=googlegemini&logoColor=white)](#what-each-provider-tells-mecha)
[![xAI](https://img.shields.io/badge/xAI-000000?logo=x&logoColor=white)](#what-each-provider-tells-mecha)
[![OpenRouter](https://img.shields.io/badge/OpenRouter-6566F1?logo=openrouter&logoColor=white)](#what-each-provider-tells-mecha)

[![Try it in your browser](https://img.shields.io/badge/%E2%96%B6%20Try%20it%20in%20your%20browser-no%20install-f59e0b?style=for-the-badge)](https://joaquinruiz.github.io/mecha/)

[Read the launch post (in Spanish)](https://jokiruiz.com/inteligencia-artificial/mecha-api-keys-saldo-caducidad/)

</div>

Mecha is a local-first dashboard (web + CLI) that tells you at a glance how much life each of your AI credentials has left: whether it works, whether it has funds, when it expires and what kind of key it is. It covers Anthropic, OpenAI, Google Gemini, xAI and OpenRouter, plus the session files of Codex, Claude Code and Gemini CLI.

![Mecha's dashboard in demo mode: one card per key with a traffic light, funds and the fuse to its expiry](https://raw.githubusercontent.com/JoaquinRuiz/mecha/main/docs/demo.gif)

> [!NOTE]
> **Alpha.** See [SPEC.md](SPEC.md) (in Spanish) for the full design.

## Install

**Just looking?** [Try the web demo](https://joaquinruiz.github.io/mecha/): made-up data, runs entirely in your browser and sends nothing anywhere (its Content Security Policy forbids any connection). It never asks you to paste a key.

Mecha needs Python 3.12+. The easiest way is [uv](https://docs.astral.sh/uv/):

```bash
uvx mecha-keys serve --demo     # try it with fake data: no secrets, no network
uv tool install mecha-keys      # install the `mecha` command
pipx install mecha-keys         # or with pipx
```

The PyPI package is `mecha-keys`; the command is `mecha` (`mecha-keys` also works). Every release is published from GitHub Actions with Trusted Publishing and carries [attestations](https://docs.pypi.org/attestations/) you can verify:

```bash
gh attestation verify mecha_keys-*.whl --repo JoaquinRuiz/mecha
```

## Principles

- **Local-first.** Runs on `127.0.0.1`. A key only ever leaves your machine towards its own provider's official endpoint. No telemetry, no cloud.
- **Zero cost by default.** Automatic checks only use free endpoints; token-consuming probes are opt-in, with their cost shown first.
- **Honest about the unknown.** "Unknown" is a valid state, and every value shows where it came from.
- **A stored secret is never shown again.** The UI only sees a redacted form and a fingerprint.

## Usage

```bash
mecha serve                                     # dashboard on 127.0.0.1:7878 (opens the browser)
mecha add --label "Prod Anthropic" --tag prod   # hidden prompt; or pipe: echo "$KEY" | mecha add
mecha ls                                        # table; --json for scripts
mecha detect < key.txt                          # classify offline, store nothing
mecha check                                     # free passive check of every key; --json, --strict, --force
mecha check --active ID                         # paid probe (fraction of a cent; one per hour, --force to repeat)
mecha link codex                                # link ~/.codex/auth.json (read-only, tokens never copied)
mecha import .env                               # preview detected keys (redacted), then import
mecha export backup.mecha                       # encrypted backup (its own passphrase)
mecha restore backup.mecha                      # merge it into this store; never overwrites
mecha rm 01J9ABCD --yes
mecha passphrase set                            # recovery passphrase for the store
```

Secrets are never accepted as command-line arguments. `mecha ls` and `mecha check` follow the Nagios convention: `0` all green, grey or local only, `1` some amber, `2` some red, `3` unknown. Any error in those commands, including a misspelt option, exits `3`, never `2`. With `--strict`, a grey result (could not check) exits `3`.

Checks only use each provider's free endpoint (no tokens are spent) and only reach that provider's official hosts, with a closed list of method, host and path per kind of key. A result younger than 5 minutes is reused (shown as cached); `--force` checks again. `mecha serve` also re-checks every 6 hours. Settings live in `config.toml` in the data directory.

The store key lives in the system keyring. Without a keyring (headless Linux, cron), set `MECHA_PASSPHRASE_FILE` to a `0600` file holding the passphrase (or `MECHA_PASSPHRASE`). `MECHA_HOME` overrides the data directory.

### Finding keys in plaintext

```bash
mecha scan                       # your home folder, AI tool configs and shell histories
mecha scan ~/Development --json  # only these folders
mecha scan --import 3f9a1c2b7d   # import a finding (the file is read again)
mecha scan --check               # validate found keys with their own provider (asks first)
mecha where 01JD8                # where a stored key was found; --rescan reads those files again
```

`mecha scan` looks for AI keys lying around on this machine and lists each one with its file and line, redacted: never the line itself. It runs offline (only `--check` sends keys, each to its own provider's free endpoint) and only when you run it. Everything is listed as information; it goes amber only where a key is a risk: shell history, notebooks, files tracked or not ignored in git, synced folders and files other people on this machine can read. Exit code: `0` nothing risky, `1` something amber, `3` an error. Keys that only look like `AIza…` or a bare `sk-…` are listed apart, as low confidence: they may belong to another service.

It reads the configs of Claude Desktop, Cursor, VS Code, Windsurf and Continue and the zsh, bash, fish and PowerShell histories, and skips dependencies, caches, virtual environments, local model stores, large and binary files, and files that only exist in the cloud (opening those would download them). On macOS, Desktop, Documents, Downloads, iCloud Drive and `~/Library/CloudStorage` are only scanned with `--include-protected`, because the system asks for permission. Where a key Mecha keeps was also found is stored encrypted, and its card turns amber; other locations are never stored.

The dashboard does the same from the «Scan» tab of the add dialog: it scans your home folder in the background (with a Stop button), lists the findings redacted and imports the ones you pick. The detail sheet of a stored key says where it was found and can scan just those files again once you have cleaned them up. From the browser only the home folder can be scanned, never a path you type; the results stay in the server's memory for 30 minutes at most. In `mecha serve --demo` the scan never touches your disk: it finds the same made-up files every time.

**On company laptops**: a program that reads shell histories and config files looking for keys behaves like an infostealer, so security tools (EDR) may flag `mecha scan`. It never runs on its own.

### Backups

`mecha export FILE` writes every credential (secrets, labels, tags, notes, budgets and probe settings; not the check history) encrypted with AES-256-GCM under a key derived from a passphrase you choose (at least 12 characters; Argon2id). The file is created with `0600` permissions and its header names the format, the key derivation function and its parameters, which are checked against upper bounds before any key is derived, so a tampered file cannot demand huge amounts of memory. The store's own key is never written, so a backup opens on any machine with its passphrase. There is no plaintext export.

`mecha restore FILE` merges a backup into the current store: duplicates are detected with the destination store's key and skipped, nothing is overwritten, and it says what it did with each entry. Without a terminal, both read the passphrase from `MECHA_BACKUP_PASSPHRASE_FILE` (a `0600` file).

## What each provider tells Mecha

<!-- capabilities:start -->

| Provider | Validates | Funds | Expiry | Free check | Active probe (opt-in) |
| --- | --- | --- | --- | --- | --- |
| Anthropic | yes | only when it fails | with an admin key | API key: `GET /v1/models`<br>admin key: `GET /v1/organizations/api_keys` | `POST /v1/messages`, `claude-haiku-5-5`: 0.0015 USD per 1,000 probes |
| OpenAI | yes | estimated, with an admin key | with an admin key | API key: `GET /v1/models`<br>admin key: `GET /v1/organization/admin_api_keys` | `POST /v1/embeddings`, `text-embedding-3-small`: 0.00002 USD per 1,000 probes |
| Google Gemini | yes | only when it fails | no | API key: `GET /v1beta/models` | `POST /v1beta/models/{model}:generateContent`, `gemini-3.5-flash-lite`: 0.004 USD per 1,000 probes |
| xAI | yes | with a management key | with a management key | API key: `GET /v1/api-key`<br>management key: `GET /auth/management-keys/validation` | `POST /v1/chat/completions`, `grok-4.20-0309-non-reasoning`: 0.015 USD per 1,000 probes |
| OpenRouter | yes | yes | yes | API key: `GET /api/v1/key` | not needed |

Probe prices from each provider's pricing page, checked 2026-11-06. Generated from `src/mecha/data/capabilities.toml` by `scripts/gen_capabilities.py`; do not edit by hand.

<!-- capabilities:end -->

Details, sources and what could not be verified: [docs/providers.md](docs/providers.md).

## Threat model

Mecha protects your secrets **at rest**: on disk, in backups (Time Machine, rsync, cloud sync of your home folder) and on a laptop that is lost or stolen while off. Secrets are encrypted with AES-256-GCM under a random key kept in the system keyring (or wrapped with your passphrase), the database is created `0600` in a `0700` directory, and SQLite's `secure_delete` overwrites deleted rows.

The local server also defends against **other websites open in your browser** and **other users on the same machine**: it listens only on `127.0.0.1`, every API request needs the session token printed when the server starts, any other `Host` header is rejected (against DNS rebinding), and the page runs under a strict Content Security Policy with a nonce per response.

Mecha does **not** protect against **code already running as your user**: malware, a compromised dependency or editor extension, or any process of yours can ask the keyring for the store key (often without a prompt), read the memory of a running Mecha, read the session token from your terminal or call the local API with it. If something hostile already runs as you, it can read your keys from Mecha just as it could from your `.env` files or shell history. Mecha also cannot tell whether a provider's endpoint is honest about a key; it reports what the provider answers.

Secrets are never logged, never sent to the browser after they are added, never taken as command-line arguments and never sent anywhere except the official endpoint of their own provider. To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Development

Requirements: [uv](https://docs.astral.sh/uv/), Node.js 22+ with [pnpm](https://pnpm.io/) (version pinned in `web/package.json`), [just](https://just.systems/) and, for the pre-commit hook, [gitleaks](https://github.com/gitleaks/gitleaks).

```bash
just setup    # uv sync, pnpm install, gitleaks pre-commit hook
just dev      # FastAPI on 127.0.0.1:7878 + Vite on localhost:5173 (opens the Vite URL)
just test     # pytest + vitest
just lint     # ruff, mypy, biome, tsc, README capability table
just e2e      # Playwright against `mecha serve --demo` (needs `pnpm -C web exec playwright install chromium`)
just build    # vite build -> src/mecha/static, then uv build; checks the UI is in the wheel and sdist
just gif      # re-record docs/demo.gif from demo mode (needs ffmpeg)
just pages    # build and test the static web demo (web/dist-pages)
uv run mecha serve   # serve the built UI on http://127.0.0.1:7878
```

Each server start generates a random session token and opens `http://127.0.0.1:7878/#t=<token>`. The page keeps the token in `sessionStorage` (so reloads work) and sends it as `Authorization: Bearer`. Every `/api/*` request without it gets `401`, and any `Host` other than `127.0.0.1:<port>` or `localhost:<port>` gets `400`.

The web demo on GitHub Pages is the same frontend built with `vite.pages.config.ts`: the modules that talk to the local server are swapped for in-memory versions with the same interface (`web/src/demo`), replaying answers that `scripts/dump_demo.py` records from `mecha serve --demo`. CI checks that the data is current, that the real app contains no demo code and that the demo contains no `/api` client. It is deployed by the release workflow, after PyPI and the GitHub release.

The README capability table is generated from `src/mecha/data/capabilities.toml` (`uv run python scripts/gen_capabilities.py`); CI fails if it is out of date.

Releases: bump `version` in `pyproject.toml`, add a `CHANGELOG.md` entry, merge, then push a tag `vX.Y.Z`. The `Release` workflow builds once, fails if the tag does not match the version, installs the built wheel on Linux, macOS and Windows, publishes the same files to TestPyPI and, after approval, to PyPI.

Repository layout:

```text
src/mecha/      Python package (CLI, FastAPI server, core, providers, store)
web/            Vite + React + TypeScript + Tailwind CSS v4 + shadcn/ui (Radix)
tests/          pytest
scripts/        release checks, README table generator, demo GIF recorder
docs/           provider notes and architecture decision records (docs/adr/)
```

Never use real API keys in tests, fixtures or commits. See [CONTRIBUTING.md](CONTRIBUTING.md) to get involved.

## License

[MIT](LICENSE)
