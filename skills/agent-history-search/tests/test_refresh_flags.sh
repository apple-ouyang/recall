#!/usr/bin/env bash
# refresh.sh flag contract: --quick must be side-effect free, bad flags must fail.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

# A stub `recall` that only records its arguments, so --quick can be proven to
# do nothing rather than merely print nothing.
mkdir -p "${tmp}/bin"
cat >"${tmp}/bin/recall" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${RECALL_STUB_LOG}"
EOF
chmod +x "${tmp}/bin/recall"
export RECALL_STUB_LOG="${tmp}/calls.log"

PATH="${tmp}/bin:${PATH}" bash "${root}/scripts/refresh.sh" --quick >/dev/null
if [[ -s "${RECALL_STUB_LOG}" ]]; then
  echo "fail: --quick called recall: $(cat "${RECALL_STUB_LOG}")" >&2
  exit 1
fi
echo "ok: --quick leaves recall untouched"

if PATH="${tmp}/bin:${PATH}" bash "${root}/scripts/refresh.sh" --bogus 2>/dev/null; then
  echo "fail: unknown flag accepted" >&2
  exit 1
fi
echo "ok: unknown flag rejected"

PATH="${tmp}/bin:${PATH}" bash "${root}/scripts/refresh.sh" --help >/dev/null
echo "ok: --help exits 0"
