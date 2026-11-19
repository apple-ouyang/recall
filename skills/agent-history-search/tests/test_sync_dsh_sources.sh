#!/usr/bin/env bash
# Fixture: each session directory contributes one log, and the highest version wins.
set -euo pipefail

script="$(cd "$(dirname "$0")/../scripts" && pwd)/sync_dsh_sessions.sh"
root="$(mktemp -d)"
cache="$(mktemp -d)"
seen="${root}/seen"
trap 'rm -rf "${root}" "${cache}"' EXIT

mkdir -p \
  "${root}/dsh/sessions/cwd/only-old" \
  "${root}/dsh/sessions/cwd/old-and-v3" \
  "${root}/dsh/sessions/cwd/v3-and-v4" \
  "${root}/dsh/sessions/cwd/only-v4" \
  "${root}/dsh/sessions/cwd/v4-and-v10"
: >"${root}/dsh/sessions/cwd/only-old/session.jsonl.zstd"
: >"${root}/dsh/sessions/cwd/old-and-v3/session.jsonl.zstd"
: >"${root}/dsh/sessions/cwd/old-and-v3/session.v3.jsonl.zstd"
: >"${root}/dsh/sessions/cwd/v3-and-v4/session.v3.jsonl.zstd"
: >"${root}/dsh/sessions/cwd/v3-and-v4/session.v4.jsonl.zstd"
: >"${root}/dsh/sessions/cwd/only-v4/session.v4.jsonl.zstd"
: >"${root}/dsh/sessions/cwd/v4-and-v10/session.v4.jsonl.zstd"
: >"${root}/dsh/sessions/cwd/v4-and-v10/session.v10.jsonl.zstd"
: >"${root}/dsh/sessions/cwd/only-old/not-a-log.txt"

cat >"${root}/export.mjs" <<'EOF'
import fs from "node:fs";
const [, , cmd, src, dest] = process.argv;
if (cmd !== "export" || !src || !dest) process.exit(2);
fs.appendFileSync(process.env.SEEN, `${src}\n`);
fs.writeFileSync(dest, "{}\n");
EOF

SEEN="${seen}" \
  DSH_HOME="${root}/dsh" \
  DSH_LOG_TOOL="${root}/export.mjs" \
  RECALL_DSH_CACHE="${cache}" \
  bash "${script}" >/dev/null

python3 - "${seen}" <<'PY'
import sys
from pathlib import Path
lines = [line.strip() for line in Path(sys.argv[1]).read_text().splitlines() if line.strip()]
names = sorted(Path(line).name for line in lines)
ids = sorted(Path(line).parent.name for line in lines)
assert ids == ["old-and-v3", "only-old", "only-v4", "v3-and-v4", "v4-and-v10"], ids
assert names == [
    "session.jsonl.zstd",
    "session.v10.jsonl.zstd",
    "session.v3.jsonl.zstd",
    "session.v4.jsonl.zstd",
    "session.v4.jsonl.zstd",
], names
by_id = {Path(line).parent.name: Path(line).name for line in lines}
assert by_id["only-old"] == "session.jsonl.zstd"
assert by_id["old-and-v3"] == "session.v3.jsonl.zstd"
assert by_id["v3-and-v4"] == "session.v4.jsonl.zstd"
assert by_id["only-v4"] == "session.v4.jsonl.zstd"
assert by_id["v4-and-v10"] == "session.v10.jsonl.zstd"
print("ok", len(lines))
PY

# Second run must skip every fixture session.
second="$(
  SEEN="${seen}" \
    DSH_HOME="${root}/dsh" \
    DSH_LOG_TOOL="${root}/export.mjs" \
    RECALL_DSH_CACHE="${cache}" \
    bash "${script}"
)"
printf '%s\n' "${second}" | grep -q "0 decoded, 5 unchanged"
echo "second-run ok"
