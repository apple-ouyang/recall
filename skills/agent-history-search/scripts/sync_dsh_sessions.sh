#!/usr/bin/env bash
# Decode DSH session logs into the plaintext JSONL that plugins/dsh.lua indexes.
#
# DSH stores each session as a multi-frame zstd JSONL file
# (~/.dsh/sessions/<cwd>/<session-id>/session.jsonl.zstd or session.vN.jsonl.zstd).
# A directory can keep an older container beside a newer one. This script
# decodes only the highest N in that directory. The recall Lua sandbox
# has no I/O and no decompressor, so the container is decoded here and the plugin
# only maps decoded events. Output is a disposable cache that sits next to the
# index it feeds: delete it and this script rebuilds it from ~/.dsh.
#
# Incremental: a session whose size and mtime are unchanged is skipped. A session
# that only grew re-decodes to a byte-identical prefix, which is what keeps
# recall's per-file offset resume correct.
#
# Tolerant: one unreadable session (DSH logs do get torn) never aborts the run and
# never overwrites the previous decoded copy.
set -euo pipefail

dsh_home="${DSH_HOME:-$HOME/.dsh}"
out_dir="${RECALL_DSH_CACHE:-$HOME/.recall/dsh}"
manifest="${out_dir}/.sync.manifest"

# The decoder sits beside this script and covers what the search path needs:
# multi-frame zstd plus a torn tail. Set DSH_LOG_TOOL to a stronger DSH log tool
# (one that can also verify, rebuild or splice a damaged log) to use it instead.
resolve_tool() {
  local candidate
  if [[ -n "${DSH_LOG_TOOL:-}" ]]; then
    if [[ -f "${DSH_LOG_TOOL}" ]]; then
      printf '%s\n' "${DSH_LOG_TOOL}"
      return 0
    fi
    echo "error: DSH_LOG_TOOL does not exist: ${DSH_LOG_TOOL}" >&2
    return 1
  fi
  candidate="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dsh_decode.mjs"
  if [[ -f "${candidate}" ]]; then
    printf '%s\n' "${candidate}"
    return 0
  fi
  echo "error: dsh_decode.mjs is missing beside this script; set DSH_LOG_TOOL=/path/to/decoder.mjs" >&2
  return 1
}

# One source path per session directory. Unversioned logs rank 0.
# session.v10 ranks above session.v4. Anything else is ignored.
list_dsh_sources() {
  local root="$1"
  find "${root}" -type f \( \
      -name 'session.jsonl.zstd' -o \
      -name 'session.v[0-9]*.jsonl.zstd' \
    \) -print 2>/dev/null \
    | awk '
      function rank(name, n) {
        if (name == "session.jsonl.zstd") return 0
        if (match(name, /^session\.v[0-9]+\.jsonl\.zstd$/)) {
          n = name
          sub(/^session\.v/, "", n)
          sub(/\.jsonl\.zstd$/, "", n)
          return n + 0
        }
        return -1
      }
      {
        n = split($0, parts, "/")
        name = parts[n]
        dir = parts[1]
        for (i = 2; i < n; i++) dir = dir "/" parts[i]
        r = rank(name)
        if (r < 0) next
        if (!(dir in best) || r > best[dir]) {
          best[dir] = r
          chosen[dir] = $0
        }
      }
      END {
        for (dir in chosen) print chosen[dir]
      }
    '
}

if ! tool="$(resolve_tool)"; then
  cat >&2 <<'EOF'
error: no DSH log decoder available.
       scripts/dsh_decode.mjs should sit beside this script.
       Point DSH_LOG_TOOL=/path/to/decoder.mjs at another one and retry.
EOF
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required to decompress DSH zstd frames" >&2
  exit 1
fi

if [[ ! -d "${dsh_home}/sessions" ]]; then
  echo "no DSH sessions at ${dsh_home}/sessions; nothing to sync"
  exit 0
fi

mkdir -p "${out_dir}"
chmod 700 "${out_dir}"

# size + mtime, portable across BSD (macOS) and GNU stat.
file_size_mtime() {
  if stat -f %z "$1" >/dev/null 2>&1; then
    printf '%s %s\n' "$(stat -f %z "$1")" "$(stat -f %m "$1")"
  else
    printf '%s %s\n' "$(stat -c %s "$1")" "$(stat -c %Y "$1")"
  fi
}

next_manifest="$(mktemp)"
trap 'rm -f "${next_manifest}"' EXIT

decoded=0
reused=0
skipped=0
failed=0

while IFS= read -r src; do
  [[ -n "${src}" ]] || continue
  id="$(basename "$(dirname "${src}")")"
  read -r size mtime < <(file_size_mtime "${src}")
  target="${out_dir}/${id}.jsonl"

  if [[ -f "${target}" ]] && grep -qxF "${id} ${size} ${mtime}" "${manifest}" 2>/dev/null; then
    printf '%s %s %s\n' "${id}" "${size}" "${mtime}" >>"${next_manifest}"
    skipped=$((skipped + 1))
    continue
  fi

  tmp_out="$(mktemp "${out_dir}/.${id}.XXXXXX")"
  if node "${tool}" export "${src}" "${tmp_out}" >/dev/null 2>&1 && [[ -s "${tmp_out}" ]]; then
    chmod 600 "${tmp_out}"
    mv -f "${tmp_out}" "${target}"
    printf '%s %s %s\n' "${id}" "${size}" "${mtime}" >>"${next_manifest}"
    decoded=$((decoded + 1))
  else
    rm -f "${tmp_out}"
    failed=$((failed + 1))
    echo "warn: export failed, keeping the previous decode: ${id} (${src})" >&2
    # Not recorded in the manifest on purpose, so the next run retries.
    if [[ -f "${target}" ]]; then
      reused=$((reused + 1))
    fi
  fi
done < <(list_dsh_sources "${dsh_home}/sessions" | sort)

mv -f "${next_manifest}" "${manifest}"
echo "dsh sessions: ${decoded} decoded, ${skipped} unchanged, ${failed} failed (${reused} kept previous), tool=${tool}"

# Total failure means the decoder or the logs are unusable, not that one torn
# session was skipped; surface it so the search flow does not look healthy.
if (( failed > 0 && decoded == 0 && reused == 0 )); then
  echo "error: all ${failed} sessions failed to export; the DSH search surface did not update this run" >&2
  exit 1
fi
