#!/usr/bin/env bash
# Prepare the index a search reads, in one command.
#
#   refresh.sh             plugins + exports + incremental index  (warm: ~5s)
#   refresh.sh --quick     skip all prep; search the index as it is (instant)
#   refresh.sh --full      plugins + exports + full index rebuild (slow, rare)
#   refresh.sh --quiet     no progress output, errors still shown
#
# Warm cost is dominated by `recall index` (~3s); the six exporters together
# are ~2s when nothing changed, because each keeps its own manifest and only
# decodes sessions that grew.
set -euo pipefail

skill_root="$(cd "$(dirname "$0")/.." && pwd)"
mode=warm
quiet=0

for arg in "$@"; do
  case "${arg}" in
    --quick) mode=quick ;;
    --full) mode=full ;;
    --quiet | -q) quiet=1 ;;
    -h | --help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//' ; exit 0 ;;
    *) echo "error: unknown flag: ${arg}" >&2; exit 2 ;;
  esac
done

if [[ "${mode}" == "quick" ]]; then
  echo "quick: skipped plugin install, session export and index; searching the existing index"
  exit 0
fi

# A failing prep step must not look like "no hits"; surface it and stop.
run_step() {
  local label="$1"
  shift
  if (( quiet )); then
    local log
    log="$(mktemp)"
    if ! "$@" >"${log}" 2>&1; then
      echo "error: ${label} failed" >&2
      cat "${log}" >&2
      rm -f "${log}"
      exit 1
    fi
    rm -f "${log}"
  else
    if ! "$@"; then
      echo "error: ${label} failed" >&2
      exit 1
    fi
  fi
}

# Note: an empty array must not be expanded as "${arr[@]:-}" — that passes one
# empty argument, and install_plugins.sh rejects it as an unknown flag.
if (( quiet )); then
  run_step "plugin install" bash "${skill_root}/scripts/install_plugins.sh" --quiet
else
  run_step "plugin install" bash "${skill_root}/scripts/install_plugins.sh"
fi
run_step "session export" bash "${skill_root}/scripts/sync_all_sessions.sh"

if [[ "${mode}" == "full" ]]; then
  run_step "index (full)" recall index --full
else
  run_step "index" recall index
fi

echo "ready: index refreshed"
