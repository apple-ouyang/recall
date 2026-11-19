---
name: agent-history-search
description: >
  Search this machine's past AI chat sessions by keyword, or find which session
  produced a commit. Use when the user says "search my chat history", "what did
  I say about…", "did we already…", "find the old conversation", or "which
  window made this commit".
---

# agent-history-search

Search entry point over `recall`: it reads each agent's own session store,
read-only, and keeps a disposable index. Covers Claude Code, Codex, Cursor, pi,
Droid, Grok, Kimi, Oh My Pi, DSH, mimocode, OpenCode, Devin, Antigravity, and
Cursor ACP.

## Before searching

Install the plugins this skill needs (once per machine), refresh the
export-backed sources, then search:

```bash
SKILL_DIR="${SKILL_DIR:-$HOME/.agents/skills/agent-history-search}"
bash "$SKILL_DIR/scripts/install_plugins.sh"
bash "$SKILL_DIR/scripts/sync_all_sessions.sh"
recall index
recall "keyword" --json --limit 20
```

`recall index` is incremental: unchanged source files cost almost nothing.
Never build an index by hand, and never `--rebuild` the sources from scratch.

Filters:

```bash
recall "keyword" --tag source:grok          # one tool only
recall "keyword" --repo ~/code/project      # one project only
recall "keyword" --since 7d                 # recent only
recall show <session-id> --range <start>:<end>   # re-read a narrow slice
```

## Sources

| Source | How it is read | Storage |
|---|---|---|
| `claude` | built in | `~/.claude/projects` |
| `codex` | built in | `~/.codex/sessions` |
| `cursor` | built in | Cursor `state.vscdb` |
| `cursor-agent` | built in | `~/.cursor/projects` |
| `pi` | built in | `~/.pi/agent/sessions/<cwd>/` |
| `grok` | plugin | `~/.grok/sessions/<cwd>/<id>/chat_history.jsonl` |
| `kimi` | plugin | `~/.kimi-code/sessions/<ws>/session_<id>/agents/*/wire.jsonl` |
| `droid` | plugin | `~/.factory/sessions` |
| `omp` | plugin | `~/.omp/agent/sessions` |
| `codex-archived` | plugin | `~/.codex/archived_sessions` |
| `dsh` | plugin + export | `~/.recall/dsh/<id>.jsonl` ← `~/.dsh` |
| `mimo` | plugin + export | `~/.recall/mimo/<id>.jsonl` ← mimocode SQLite |
| `opencode` | plugin + export | `~/.recall/opencode/<id>.jsonl` |
| `devin` | plugin + export | `~/.recall/devin/<id>.jsonl` |
| `agy` | plugin + export | `~/.recall/agy/<id>.jsonl` ← Antigravity sqlite + IDE `.pb` |
| `cursor-acp` | plugin + export | `~/.recall/cursor-acp/<id>.jsonl` |

`sync_all_sessions.sh` produces the export-backed rows. The others are read
directly from the original logs.

Paseo runs the same CLIs, so one source can cover several Paseo provider names:

| source | covers |
|---|---|
| `claude` | claude, claude-cpa |
| `codex` | codex, cpa |
| `droid` | factory-droid and other Droid providers |
| `cursor-agent` | Cursor CLI chats |
| `cursor-acp` | Cursor ACP sessions (ids do not overlap with chats) |

## Search order

Name the harness when the user names it: add `--tag source:...`. Otherwise run
one global exact search first instead of starting from the current harness.
Ignore hits from the current session: the text the user just pasted is not
history evidence.

Widen in this order and stop as soon as the evidence answers the question:

1. Search the user's exact words, full file name, commit hash, or commit
   subject. Only when that returns nothing — or only weak title matches — split
   words, try synonyms, or add variants.
2. When the JSON snippet already answers, use it. Do not re-read the session.
3. For context, use the hit's `msg_idx` with
   `recall show <session-id> --range <start>:<end>` for 3–5 messages around it.
4. Widen the range only when that still is not enough; read a whole session
   only when `msg_idx` cannot be located.

## Reporting

When the user wants the window, session, or resume id, lead with four lines and
no field names:

```text
{{window name or title}}
{{source harness}}
{{auto title}}
{{session ID}}
```

Write `unknown` for anything missing. Add 3–5 evidence lines after it when
useful: `source`, `role`, `session_id`, short snippet. `recall --json` has no
`path:line`; to quote the original, re-read a narrow `--range`.

For Cursor (`source:cursor-agent`) the JSON `title` is the sidebar name from
`~/.cursor/chats/<workspace>/<id>/meta.json`; the first user message is only a
fallback. Use that title in the first line instead of the raw first prompt.

When the user wants the original wording, skip the four-line block and quote
the hit.

## Resume commands

| Source | Command |
|---|---|
| Codex | `codex resume <id>` |
| Claude | `claude --resume <id>` |
| Grok | `grok --resume <id>` |
| Kimi | `kimi -S <id>` |
| pi | resume by session id |
| mimo | `mimo --session <id>` |
| DSH | `dsh --profile tui --resume <id>` |
| Droid | `droid resume <id>` |
| omp | `omp --resume <id>` |
| OpenCode | `opencode --session <id>` |
| Devin | `devin --resume <id>` |
| Antigravity | `agy --conversation <id>` |
| Cursor CLI chats | `cursor-agent --resume <id>` |
| Cursor ACP | `cursor-agent --resume <id>` |

## Commit attribution

"Which window made this commit?" is a session question, not a Git author
question.

```bash
recall "<commit-hash-or-subject>" --json --limit 20
```

Trust hits that look like real `git commit` or commit-helper output. A chat that
merely mentions the hash is not the attribution. Never treat a hash the current
session just printed as evidence.

## Per-source notes

- `dsh`: DSH writes each session as a multi-frame zstd file
  (`~/.dsh/sessions/<cwd>/<id>/session.jsonl.zstd` or `session.vN.jsonl.zstd`).
  `scripts/sync_dsh_sessions.sh` decodes the highest version in each directory
  into `~/.recall/dsh/<id>.jsonl`; the Lua sandbox has no I/O and no
  decompressor, so decoding has to happen in the script. Set `DSH_LOG_TOOL` to
  reuse a richer DSH log tool. Torn tails are dropped, and the surviving prefix
  stays byte-identical as the log grows, which is what keeps the indexer's
  offset resume correct.
- `mimo`: mimocode keeps sessions in SQLite (`mimo db path`, default
  `~/.local/share/mimocode/mimocode.db`). `scripts/sync_mimo_sessions.mjs` (Node
  ≥ 22, `node:sqlite`) exports each session to `~/.recall/mimo/<id>.jsonl`,
  appending by a global `part.rowid` watermark; the watermark lives in
  `~/.recall/mimo/.sync-state.json`. Only text and tool calls are exported:
  reasoning, file blobs, and compaction frames are skipped. Resume with
  `mimo --session <id>`.
- `kimi`: the wire log records no cwd, so those sessions index with an empty
  project and `--repo` will not match them.
- `agy`: Antigravity text is extracted from protobuf; roles come through as
  `text`.
- The export caches under `~/.recall/<source>/` are disposable: delete one and
  the next `sync_all_sessions.sh` rebuilds it. They are also large (the DSH one
  reaches several GB on a busy machine), so do not treat them as permanently
  free space.

## Do not

- Do not edit or write to any source log; this skill is read-only.
- Do not copy transcripts into a second database.
- Do not point the search at the disposable index files directly;
  `~/.recall/index.sqlite` is a rebuildable excerpt index, so a broken one is
  fixed with `recall index`.
- Backups are not this skill's job; it only searches.
