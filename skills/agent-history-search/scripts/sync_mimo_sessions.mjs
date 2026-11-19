#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// Export mimocode (mimo) sessions from its SQLite DB to append-only plaintext
// JSONL under ~/.recall/mimo/<session-id>.jsonl for recall's mimo.lua plugin.
//
// The recall Lua sandbox has no I/O and no SQLite, so sessions must be decoded
// to files first (same pattern as sync_dsh_sessions.sh for DSH). The export is
// append-only via a global part-rowid watermark, so recall's per-file offset
// resume stays correct. A missing watermark triggers a clean full rebuild
// (derived *.jsonl are wiped first); a corrupt watermark fails safe with exit 1
// instead of re-appending duplicates. ~/.recall/mimo/ is a disposable derived
// cache: delete it and rerun this script to rebuild; the mimocode DB is opened
// read-only and never mutated.
//
// DB path: $MIMO_DB if set, else ~/.local/share/mimocode/mimocode.db
// (matches `mimo db path`).

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const DB_PATH =
  process.env.MIMO_DB || path.join(HOME, ".local/share/mimocode/mimocode.db");
const OUT_DIR = path.join(HOME, ".recall/mimo");
const STATE_PATH = path.join(OUT_DIR, ".sync-state.json");
const CHUNK = 5000;
const TOOL_SUMMARY_LIMIT = 400;

const ARG_KEYS = ["command", "path", "query", "pattern", "file_path", "url", "skill"];

function loadState() {
  let raw;
  try {
    raw = fs.readFileSync(STATE_PATH, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      // Watermark missing: fresh start. Derived *.jsonl must be wiped before a
      // full re-export, otherwise every event would be re-appended as a duplicate.
      return { rowid: 0, titles: {}, fresh: true };
    }
    throw err;
  }
  try {
    const st = JSON.parse(raw);
    return { rowid: Number(st.rowid) || 0, titles: st.titles || {}, fresh: false };
  } catch {
    // Corrupt watermark while derived files may already exist: fail safe instead
    // of falling back to rowid 0 (which would duplicate every exported event).
    console.error(
      `corrupt sync state: ${STATE_PATH}\n` +
        `delete ${OUT_DIR} and rerun to rebuild the disposable cache`,
    );
    process.exit(1);
  }
}

function toolSummary(input) {
  if (!input || typeof input !== "object") return "";
  for (const key of ARG_KEYS) {
    const v = input[key];
    if (typeof v === "string" && v !== "") {
      return v.replace(/\s+/g, " ").trim().slice(0, TOOL_SUMMARY_LIMIT);
    }
  }
  try {
    return JSON.stringify(input).slice(0, TOOL_SUMMARY_LIMIT);
  } catch {
    return "";
  }
}

// Normalize one part row to the mimo.lua event shape, or null to skip.
// Skipped on purpose: reasoning (model thinking), step-start/step-finish,
// file (base64 images), compaction — none carry stable searchable prose.
function eventFor(row) {
  let data;
  try {
    data = JSON.parse(row.data);
  } catch {
    return null;
  }
  const ts = Number(row.ts) || 0;
  if (data.type === "text") {
    const text = typeof data.text === "string" ? data.text : "";
    const role = row.role === "user" || row.role === "assistant" ? row.role : null;
    if (!role || text === "") return null;
    return { type: "text", role, ts, text };
  }
  if (data.type === "tool") {
    const name = typeof data.tool === "string" && data.tool !== "" ? data.tool : "tool";
    const text = toolSummary(data.state && data.state.input);
    if (text === "") return null;
    return { type: "tool", ts, name, text };
  }
  return null;
}

if (!fs.existsSync(DB_PATH)) {
  console.error(`mimocode db not found: ${DB_PATH} (set MIMO_DB to override)`);
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const state = loadState();
if (state.fresh) {
  for (const name of fs.readdirSync(OUT_DIR)) {
    if (name.endsWith(".jsonl")) {
      fs.unlinkSync(path.join(OUT_DIR, name));
    }
  }
}
const db = new DatabaseSync(DB_PATH, { readOnly: true });

const sessionStmt = db.prepare(
  "SELECT id, title, directory, time_created FROM session WHERE id = ?",
);
const partStmt = db.prepare(
  `SELECT p.rowid AS rid, p.session_id AS sid, p.time_created AS ts,
          p.data AS data, json_extract(m.data, '$.role') AS role
     FROM part p JOIN message m ON m.id = p.message_id
    WHERE p.rowid > ?
    ORDER BY p.rowid
    LIMIT ?`,
);

const perSession = new Map(); // sid -> { lines: [], lastRid }
let cursor = state.rowid;
let scanned = 0;

for (;;) {
  const rows = partStmt.all(cursor, CHUNK);
  if (rows.length === 0) break;
  for (const row of rows) {
    cursor = Number(row.rid);
    scanned += 1;
    const ev = eventFor(row);
    if (!ev) continue;
    let bucket = perSession.get(row.sid);
    if (!bucket) {
      bucket = { lines: [], lastRid: cursor };
      perSession.set(row.sid, bucket);
    }
    bucket.lastRid = cursor;
    bucket.lines.push(JSON.stringify(ev));
  }
  if (rows.length < CHUNK) break;
}

let sessionsWritten = 0;
let linesWritten = 0;
for (const [sid, bucket] of perSession) {
  const filePath = path.join(OUT_DIR, `${sid}.jsonl`);
  const isNew = !fs.existsSync(filePath);
  let header = null;
  try {
    header = sessionStmt.get(sid);
  } catch {
    header = null;
  }
  const title = header && typeof header.title === "string" ? header.title : "";
  const out = [];
  // Header lines produce no index entries (mimo.lua maps them to st.* only),
  // so re-emitting on title change is safe and keeps metadata fresh.
  if (isNew || state.titles[sid] !== title) {
    out.push(
      JSON.stringify({
        type: "session",
        id: sid,
        title,
        cwd: (header && header.directory) || "",
        createdAt: (header && Number(header.time_created)) || 0,
      }),
    );
    state.titles[sid] = title;
  }
  out.push(...bucket.lines);
  fs.appendFileSync(filePath, out.join("\n") + "\n");
  sessionsWritten += 1;
  linesWritten += bucket.lines.length;
}

db.close();
if (scanned > 0) {
  state.rowid = cursor;
  const tmp = STATE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_PATH);
}
console.log(
  `mimo sessions: ${sessionsWritten} updated, ${scanned} parts scanned, ${linesWritten} events written (cursor rowid=${state.rowid})`,
);
