#!/bin/bash
# Quick launcher for Hermes agent with Searcharvester skills baked in.
# Usage:
#   ./run-hermes.sh                       # interactive TUI
#   ./run-hermes.sh -q "research X"       # one-shot query
#   ./run-hermes.sh skills list           # list skills (ours should appear)
#   ./run-hermes.sh --list-tools          # show all tools

set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$PROJECT_DIR/hermes-data"
SKILLS_SRC="$PROJECT_DIR/hermes_skills"

mkdir -p "$DATA_DIR/skills"

# Mirror our skills into the data volume so Hermes's `skills_sync.py` picks them up.
# We use rsync-like copy (overwrite, preserve deletions only within our namespace).
for skill in "$SKILLS_SRC"/*/; do
    name=$(basename "$skill")
    rm -rf "$DATA_DIR/skills/$name"
    cp -R "$skill" "$DATA_DIR/skills/$name"
done

# Load optional .env for API keys (OPENROUTER_API_KEY, OPENAI_API_KEY, etc.)
if [ -f "$PROJECT_DIR/.env.hermes" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$PROJECT_DIR/.env.hermes"
    set +a
fi

# Build env-passing flags from a known list of supported provider vars.
ENV_FLAGS=()
for var in OPENROUTER_API_KEY OPENAI_API_KEY OPENAI_BASE_URL \
           ANTHROPIC_API_KEY GEMINI_API_KEY GOOGLE_API_KEY \
           OLLAMA_API_KEY OLLAMA_BASE_URL \
           NOUS_API_KEY NOUS_PORTAL_API_KEY \
           GLM_API_KEY KIMI_API_KEY MINIMAX_API_KEY \
           SEARCHARVESTER_URL HERMES_MODEL; do
    if [ -n "${!var}" ]; then
        ENV_FLAGS+=(-e "$var=${!var}")
    fi
done

# Default Searcharvester URL inside Hermes's network context (host-side tavily-adapter).
ENV_FLAGS+=(-e "SEARCHARVESTER_URL=${SEARCHARVESTER_URL:-http://host.docker.internal:8000}")

exec docker run --rm -it \
    -v "$DATA_DIR:/opt/data" \
    -e "HERMES_UID=$(id -u)" \
    -e "HERMES_GID=$(id -g)" \
    "${ENV_FLAGS[@]}" \
    --add-host=host.docker.internal:host-gateway \
    nousresearch/hermes-agent:latest \
    "$@"
