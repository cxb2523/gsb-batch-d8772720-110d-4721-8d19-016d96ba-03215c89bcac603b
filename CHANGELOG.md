# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Auditable per-item fetch records**: `fetch.fetch_record()` always returns a
  structured `FetchRecord` (never raises) with the requested URL, attempt count,
  final status code, CAPTCHA flag, risk level, matched markers, effective URL,
  error message, and a terminal outcome category — `success`,
  `captcha_exhausted`, or `request_error`.
- **`batch.run_fetch_batch()`** produces one `BatchRecord` per input (input item,
  final URL via `asin_to_url` when `--as-asin` is set, attempts, status, CAPTCHA
  details, and outcome). One item failing no longer interrupts the run, and
  output order matches the input order. `batch.summarize()` counts records by
  outcome.
- **`batch` CLI subcommand** now prints one JSON record per input on stdout and
  writes `{summary, records}` to the output JSON file. It exits non-zero when any
  item ends in `captcha_exhausted` or `request_error`, and `0` only when every
  item succeeds. The `--as-asin`, `--domain`, `--workers`, `--max-attempts`, and
  `--timeout` flags keep their existing semantics.
- Offline pytest coverage for all three terminal paths (normal page, CAPTCHA
  exhaustion, connection error) using injected fake sessions — no real network.

### Changed
- `fetch_with_retry()` is now a thin compatibility wrapper over `fetch_record()`
  with the same contract as before (returns `FetchOutcome` on any HTTP response,
  raises `FetchError` after request-only failures). `FetchError` now also carries
  the number of attempts made.
- The `batch` subcommand's output file changed shape from `{"ok": [...],
  "errors": [...]}` to `{"summary": {...}, "records": [...]}`; the `export`
  subcommand accepts both the new `records` key and the legacy `ok`/`products`
  keys.

## [1.0.0] — 2026-07-10

### Added
- **`amazon_captcha` package** with detection (`detect.py`), browser header pool
  (`headers.py`), retrying fetcher (`fetch.py`), JSON/CSV export (`export.py`),
  bounded-concurrency batch runner (`batch.py`), and a Thordata SDK wrapper
  (`thordata_client.py`).
- **Unified CLI**: `python -m amazon_captcha {detect|fetch|batch|export}`.
- **9 example scripts** in `examples/`, including advanced demos for retry/backoff,
  `curl_cffi` TLS impersonation, Playwright stealth, and Thordata batch ASIN.
- **Offline pytest suite** (36 tests, no real network).
- **GitHub Pages documentation site** (`docs/index.html`) with dark/light themes,
  scroll-spy TOC, Prism-highlighted code blocks with copy buttons, comparison
  cards, an animated architecture flow diagram, and a FAQ accordion.
- **Interactive CAPTCHA Detector Playground** (`docs/playground.html`) — 100%
  client-side, mirrors the Python marker list, with risk meter, marker editor,
  and JSON export.
- **CI workflow** (Python 3.10/3.11/3.12, ruff + pytest) and **Pages deploy** workflow.
- **Bilingual README** (English + `README.zh-CN.md`), `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, `SECURITY.md`, MIT `LICENSE`, issue templates.
- `pyproject.toml` with optional dependency groups.

### Changed
- Restructured the original five loose scripts into a package under `examples/`
  backed by a reusable `amazon_captcha` module.
- Expanded the CAPTCHA marker list beyond the original three markers.

### Notes
- Examples were tested around 2026-02-25; Amazon's HTML and anti-bot behavior
  change frequently.
