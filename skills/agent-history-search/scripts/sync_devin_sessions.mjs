#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// Export Devin CLI sessions from sessions.db to append-only JSONL at
// ~/.recall/devin/<session-id>.jsonl for plugins/devin.lua.
//
// The DB is opened read-only. Watermark is message_nodes.row_id. System and
// sysprompt rows are skipped. Tool text is truncated. A missing watermark
// wipes derived *.jsonl first. A corrupt watermark exits 1.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HOME = os.homedir();
const DB_PATH =
  process.env.DEVIN_DB || path.join(HOME, ".local/share/devin/cli/sessions.db");
const OUT_DIR = process.env.RECALL_DEVIN_DIR || path.join(HOME, ".recall/devin");
const STATE_PATH = path.join(OUT_DIR, ".sync-state.json");
const CHUNK = 2000;
const TOOL_LIMIT = 400;

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

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const bits = [];
    for (const part of content) {
      if (typeof part === "string" && part !== "") bits.push(part);
      else if (part && typeof part.text === "string" && part.text !== "") bits.push(part.text);
    }
    return bits.join("\n");
  }
  if (content && typeof content === "object" && typeof content.text === "string") return content.text;
  return "";
}

export function sessionRecord(id, title, cwd, createdAt) {
  return { type: "session", id, title: title || "", cwd: cwd || "", createdAt: Number(createdAt) || 0 };
}

export function eventFor(row) {
  if (typeof row.chat_message !== "string" || row.chat_message === "") return null;
  let msg;
  try {
    msg = JSON.parse(row.chat_message);
  } catch {
    return null;
  }
  const role = msg.role;
  const source = msg.metadata && msg.metadata.telemetry && msg.metadata.telemetry.source;
  if (role === "system" || source === "sysprompt") return null;
  if (role !== "user" && role !== "assistant" && role !== "tool") return null;
  let text = textOf(msg.content).trim();
  if (text === "") return null;
  const ts = Number(row.created_at) || 0;
  if (role === "tool") {
    return { type: "tool", name: "tool", ts, text: text.slice(0, TOOL_LIMIT) };
  }
  return { type: "text", role, ts, text };
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.log(`devin db not found: ${DB_PATH} (set DEVIN_DB to override); skipped`);
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
    "SELECT id, title, working_directory, created_at FROM sessions WHERE id = ?",
  );
  const nodeStmt = db.prepare(
    `SELECT row_id AS rid, session_id AS sid, created_at, chat_message
       FROM message_nodes
      WHERE row_id > ?
      ORDER BY row_id
      LIMIT ?`,
  );

  const perSession = new Map();
  let cursor = state.rowid;
  let scanned = 0;
  for (;;) {
    const rows = nodeStmt.all(cursor, CHUNK);
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
          sessionRecord(
            sid,
            title,
            (header && header.working_directory) || "",
            header ? header.created_at : 0,
          ),
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
    `devin sessions: ${sessionsWritten} updated, ${scanned} nodes scanned, ${linesWritten} events written (cursor row_id=${cursor})`,
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) main();
