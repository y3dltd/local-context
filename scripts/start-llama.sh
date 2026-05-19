#!/usr/bin/env bash
# Start llama-server with the small model used by local-context.
# Override anything via env: LLAMA_BIN, LLAMA_MODEL, LLAMA_PORT, LLAMA_CTX, LLAMA_NGL.
set -euo pipefail

# Source the repo-root .env if present so LOCAL_CONTEXT_MODEL (and any
# LLAMA_* overrides) line up with what the MCP server will use. This
# only sets variables that aren't already exported in the parent shell.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ENV="$SCRIPT_DIR/../.env"
if [[ -f "$REPO_ENV" ]]; then
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" =~ ^[[:space:]]*# ]] && continue
    key="${key// /}"
    [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] && continue
    if [[ -z "${!key+x}" ]]; then
      value="${value%\"}"; value="${value#\"}"
      value="${value%\'}"; value="${value#\'}"
      export "$key=$value"
    fi
  done < "$REPO_ENV"
fi

LLAMA_BIN="${LLAMA_BIN:-llama-server}"
LLAMA_MODEL="${LLAMA_MODEL:?LLAMA_MODEL must point to a .gguf file. e.g. LLAMA_MODEL=/path/to/model.gguf bash scripts/start-llama.sh}"
LLAMA_PORT="${LLAMA_PORT:-8088}"
LLAMA_CTX="${LLAMA_CTX:-8192}"
LLAMA_NGL="${LLAMA_NGL:-99}"
# Default the alias to LOCAL_CONTEXT_MODEL so the convenience path lines up
# with whatever you set in .env. Falls back to "local-model" if nothing
# else is set.
LLAMA_ALIAS="${LLAMA_ALIAS:-${LOCAL_CONTEXT_MODEL:-local-model}}"

if ! command -v "$LLAMA_BIN" >/dev/null 2>&1 && [[ ! -x "$LLAMA_BIN" ]]; then
  echo "llama-server not found at '$LLAMA_BIN'. Set LLAMA_BIN to the full path." >&2
  exit 1
fi
if [[ ! -f "$LLAMA_MODEL" ]]; then
  echo "model not found at $LLAMA_MODEL" >&2
  exit 1
fi

# MTP support (multi-token prediction) shipped in llama.cpp; the flag is
# detected at runtime by the server. If the build does not recognise it,
# llama-server simply ignores the unknown arg in recent versions; if it
# rejects unknown args, drop the line.
EXTRA_ARGS=()
if "$LLAMA_BIN" --help 2>&1 | grep -q -- "--mtp"; then
  EXTRA_ARGS+=(--mtp)
fi
if "$LLAMA_BIN" --help 2>&1 | grep -q -- "--jinja"; then
  EXTRA_ARGS+=(--jinja)
fi

exec "$LLAMA_BIN" \
  -m "$LLAMA_MODEL" \
  --host 127.0.0.1 \
  --port "$LLAMA_PORT" \
  --ctx-size "$LLAMA_CTX" \
  --n-gpu-layers "$LLAMA_NGL" \
  --alias "$LLAMA_ALIAS" \
  "${EXTRA_ARGS[@]}"
