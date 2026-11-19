#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// Export OpenCode sessions from opencode.db to append-only JSONL at
// ~/.recall/opencode/<session-id>.jsonl for plugins/opencode.lua.
//
// The DB is opened read-only. Export watermark is part.rowid. A missing
// watermark wipes derived *.jsonl before a full rebuild. A corrupt watermark
// exits 1. ~/.recall/opencode is disposable.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HOME = os.homedir();
const DB_PATH =
  process.env.OPENCODE_DB ||
  path.join(HOME, ".local/share/opencode/opencode.db");
const OUT_DIR = process.env.RECALL_OPENCODE_DIR || path.join(HOME, ".recall/opencode");
const STATE_PATH = path.join(OUT_DIR, ".sync-state.json");
const CHUNK = 4000;
const TOOL_LIMIT = 400;
const ARG_KEYS = ["command", "path", "file_path", "filePath", "pattern", "query", "url", "skill", "prompt"];

function fileId(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, "_");
}

function loadState() {
  let raw;
  try {
    raw = fs.readFileSync(STATE_PATH, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { rowid: 0, titles: {}, fresh: true };
    throw err;
  }
  try {
    const st = JSON.parse(raw);
    return { rowid: Number(st.rowid) || 0, titles: st.titles || {}, fresh: false };
  } catch {
    console.error(
      `corrupt sync state: ${STATE_PATH}\ndelete ${OUT_DIR} and rerun to rebuild the disposable cache`,
    );
    process.exit(1);
  }
}

function toolSummary(input) {
  if (typeof input === "string") return input.replace(/\s+/g, " ").trim().slice(0, TOOL_LIMIT);
  if (!input || typeof input !== "object") return "";
  for (const key of ARG_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value !== "") {
      return value.replace(/\s+/g, " ").trim().slice(0, TOOL_LIMIT);
    }
  }
  try {
    return JSON.stringify(input).slice(0, TOOL_LIMIT);
  } catch {
    return "";
  }
}

export function sessionRecord(id, title, cwd, createdAt) {
  return { type: "session", id, title: title || "", cwd: cwd || "", createdAt: Number(createdAt) || 0 };
}

export function eventFor(row) {
  let data;
  try {
    data = JSON.parse(row.data);
  } catch {
    return null;
  }
  const role = row.role;
  if (role !== "user" && role !== "assistant") return null;
  const ts = Number(row.ts) || 0;
  if (data.type === "text") {
    if (typeof data.text !== "string" || data.text === "") return null;
    return { type: "text", role, ts, text: data.text };
  }
  if (data.type === "tool") {
    const name = typeof data.tool === "string" && data.tool !== "" ? data.tool : "tool";
    const summary = toolSummary(data.state && data.state.input);
    return { type: "tool", name, ts, text: `${name} ${summary}`.trim().slice(0, TOOL_LIMIT) };
  }
  return null;
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.log(`opencode db not found: ${DB_PATH} (set OPENCODE_DB to override); skipped`);
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const state = loadState();
  if (state.fresh) {
    for (const name of fs.readdirSync(OUT_DIR)) {
      if (name.endsWith(".jsonl")) fs.unlinkSync(path.join(OUT_DIR, name));
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

  const perSession = new Map();
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
      if (!bucket) bucket = perSession.set(row.sid, { lines: [] }).get(row.sid);
      bucket.lines.push(JSON.stringify(ev));
    }
    if (rows.length < CHUNK) break;
  }

  let sessionsWritten = 0;
  let linesWritten = 0;
  for (const [sid, bucket] of perSession) {
    const filePath = path.join(OUT_DIR, `${fileId(sid)}.jsonl`);
    const isNew = !fs.existsSync(filePath);
    const header = sessionStmt.get(sid);
    const title = header && typeof header.title === "string" ? header.title : "";
    const out = [];
    if (isNew || state.titles[sid] !== title) {
      out.push(
        JSON.stringify(
          sessionRecord(sid, title, (header && header.directory) || "", header ? header.time_created : 0),
        ),
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
    const tmp = `${STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ rowid: state.rowid, titles: state.titles }));
    fs.renameSync(tmp, STATE_PATH);
  }
  console.log(
    `opencode sessions: ${sessionsWritten} updated, ${scanned} parts scanned, ${linesWritten} events written (cursor rowid=${cursor})`,
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) main();
