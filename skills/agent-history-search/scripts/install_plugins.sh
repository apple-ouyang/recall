#!/usr/bin/env bash
# Install the plugins this skill needs into ~/.recall/plugins.
#
# Plugins ship inside the recall binary, so `recall plugin install` is the
# normal path. When the binary is a stock upstream build (no extended plugins),
# fall back to linking the .lua files from this repo checkout.
#
# Idempotent: --force rewrites bundled plugins, and links replace themselves.
set -euo pipefail

skill_root="$(cd "$(dirname "$0")/.." && pwd)"
repo_plugins="${RECALL_PLUGINS_DIR:-${skill_root}/../../plugins}"

# Sources recall has no Go adapter for. claude / codex / cursor / cursor-agent /
# pi / memory / skill are upstream plugins; the built-in adapters already cover
# the first five.
names="grok kimi droid omp codex-archived agy cursor-acp devin dsh mimo opencode"

if ! command -v recall >/dev/null 2>&1; then
  echo "error: recall is not on PATH (install: https://github.com/apple-ouyang/recall)" >&2
  exit 1
fi

installed=0
linked=0
failed=0

for name in ${names}; do
  if recall plugin install "${name}" --force >/dev/null 2>&1; then
    installed=$((installed + 1))
    continue
  fi
  src="${repo_plugins}/${name}.lua"
  if [[ -f "${src}" ]]; then
    mkdir -p "${HOME}/.recall/plugins"
    ln -sfn "${src}" "${HOME}/.recall/plugins/${name}.lua"
    linked=$((linked + 1))
  else
    echo "missing ${name}: not bundled in this recall build and no copy at ${src}" >&2
    failed=$((failed + 1))
  fi
done

echo "plugins: ${installed} installed from the binary, ${linked} linked from ${repo_plugins}, ${failed} missing"
recall plugin list
(( failed == 0 )) || exit 1
