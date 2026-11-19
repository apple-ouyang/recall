#!/usr/bin/env bash
# Export every recall source that is not a native JSONL tree.
# droid, omp, claude, codex, pi, grok, and kimi are read directly by recall.
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
bash "${root}/sync_dsh_sessions.sh"
node "${root}/sync_mimo_sessions.mjs"
node "${root}/sync_opencode_sessions.mjs"
node "${root}/sync_devin_sessions.mjs"
node "${root}/sync_agy_sessions.mjs"
node "${root}/sync_cursor_acp_sessions.mjs"
