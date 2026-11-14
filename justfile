# Mecha task runner. `just --list` shows all recipes.

set windows-shell := ["pwsh", "-NoLogo", "-Command"]

default:
    @just --list

# Install Python and frontend dependencies, plus the gitleaks pre-commit hook
setup:
    uv sync
    pnpm -C web install
    uvx pre-commit install

# Run FastAPI (7878) and Vite (5173) together; the browser opens Vite with the session token
[unix]
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    trap 'kill 0' EXIT
    pnpm -C web dev &
    uv run mecha serve --dev

# Build the frontend into src/mecha/static and the Python sdist + wheel
build: build-web
    uv build
    uv run python scripts/check_dist.py dist --rebuild-from-sdist

# Build only the frontend
build-web:
    pnpm -C web build

# Run all tests
test:
    uv run pytest
    pnpm -C web test

# Browser tests against the demo server (needs `just build-web` and Playwright browsers)
e2e: build-web
    pnpm -C web e2e

# Lint, format check and type check
lint:
    uv run ruff check .
    uv run ruff format --check .
    uv run mypy
    uv run python scripts/gen_capabilities.py --check
    pnpm -C web lint
    pnpm -C web typecheck

# Apply formatters
fmt:
    uv run ruff format .
    uv run ruff check --fix .
    pnpm -C web format

# Scan the working tree and history for secrets
secrets:
    gitleaks git --redact --verbose .
    gitleaks dir --redact .

# Everything CI runs
ci: lint test build
    pnpm -C web size

# Regenerate the README capability table from capabilities.toml
capabilities:
    uv run python scripts/gen_capabilities.py

# Re-record docs/demo.gif from demo mode (needs ffmpeg and Playwright's Chromium)
gif: build-web
    pnpm -C web exec playwright test --config e2e/gif.config.ts
    uv run python scripts/make_gif.py web/test-results/gif docs/demo.gif

# Refresh the web demo data from demo mode (web/src/demo/data.json)
demo-data:
    uv run python scripts/dump_demo.py

# Build and test the static web demo for GitHub Pages (needs Playwright's Chromium)
pages: build-web
    uv run python scripts/dump_demo.py --check
    pnpm -C web build:pages
    uv run python scripts/check_web_builds.py
    pnpm -C web size:pages
    pnpm -C web e2e:pages

# Build and serve the packaged frontend
serve: build-web
    uv run mecha serve
