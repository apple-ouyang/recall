#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// Extract Antigravity conversation prose into ~/.recall/agy/<id>.jsonl.
//
// CLI conversations are per-id SQLite files whose step_payload is protobuf.
// IDE conversations are standalone .pb files. Neither store labels speaker, so
// exported events use role "text". The DB and .pb files are read-only.
// Watermark is file size + mtime plus the last step idx. A conversation whose
// idx goes backwards is skipped and reported, so an existing JSONL prefix is
// not rewritten.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HOME = os.homedir();
const CLI_DIR =
  process.env.AGY_CONVERSATIONS_DIR ||
  path.join(HOME, ".gemini/antigravity-cli/conversations");
const PB_DIR =
  process.env.AGY_PB_DIR || path.join(HOME, ".gemini/antigravity/conversations");
const SUMMARY_DBS = [
  process.env.AGY_SUMMARY_DB,
  path.join(HOME, ".gemini/antigravity-cli/conversation_summaries.db"),
  path.join(HOME, ".gemini/antigravity/conversation_summaries.db"),
].filter(Boolean);
const OUT_DIR = process.env.RECALL_AGY_DIR || path.join(HOME, ".recall/agy");
const STATE_PATH = path.join(OUT_DIR, ".sync-state.json");
const TEXT_CAP = 12000;

export function extractProse(buf) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const out = [];
  const seen = new Set();
  let start = -1;
  const flush = (end) => {
    if (start < 0) return;
    if (end - start >= 24) {
      const text = data.toString("utf8", start, end);
      if (keepProse(text) && !seen.has(text)) {
        seen.add(text);
        out.push(text.length > TEXT_CAP ? text.slice(0, TEXT_CAP) : text);
      }
    }
    start = -1;
  };
  for (let i = 0; i <= data.length; i += 1) {
    const byte = i < data.length ? data[i] : 0;
    if (byte >= 32 && byte !== 127) {
      if (start < 0) start = i;
    } else {
      flush(i);
    }
  }
  return out;
}

function keepProse(text) {
  if (text.includes("\uFFFD")) return false;
  if (text.length < 24 || text.length > 100000) return false;
  const trimmed = text.trim();
  if (trimmed.startsWith("/") || trimmed.startsWith("file://")) return false;
  if (/^[0-9a-f-]{16,}$/i.test(trimmed)) return false;
  if (!/\s/.test(trimmed) && !/\p{Script=Han}/u.test(trimmed)) return false;
  return true;
}

function loadState() {
  try {
    const st = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    if (!st || typeof st.files !== "object") throw new Error("shape");
    return st;
  } catch (err) {
    if (err && err.code === "ENOENT") return { files: {} };
    if (err && err.code !== "ENOENT") {
      console.error(
        `corrupt sync state: ${STATE_PATH}\ndelete ${OUT_DIR} and rerun to rebuild the disposable cache`,
      );
      process.exit(1);
    }
    return { files: {} };
  }
}

function cwdFrom(uris) {
  if (typeof uris !== "string" || uris === "") return "";
  let parsed;
  try {
    parsed = JSON.parse(uris);
  } catch {
    return "";
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return "";
  const first = String(parsed[0]);
  if (first.startsWith("file://")) return decodeURIComponent(first.slice("file://".length));
  return first;
}

function loadSummaries() {
  const map = new Map();
  for (const dbPath of SUMMARY_DBS) {
    if (!fs.existsSync(dbPath)) continue;
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      // last_user_input_time is protobuf-free SQL text ("2025-12-09 11:31:03.6+00:00"),
      // so it is the one durable timestamp these conversations record.
      const rows = db.prepare(
        "SELECT conversation_id, title, workspace_uris, last_user_input_time FROM conversation_summaries",
      ).all();
      for (const row of rows) {
        if (!row.conversation_id) continue;
        map.set(row.conversation_id, {
          title: typeof row.title === "string" ? row.title : "",
          cwd: cwdFrom(row.workspace_uris),
          createdAt: parseTime(row.last_user_input_time),
        });
      }
    } catch (err) {
      console.error(`agy summaries skipped ${dbPath}: ${err.message}`);
    } finally {
      if (db) db.close();
    }
  }
  return map;
}

/** SQL datetime text -> epoch ms; 0 when absent or unparseable. */
function parseTime(value) {
  if (!value) return 0;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

export function sessionRecord(id, title, cwd, createdAt) {
  return { type: "session", id, title: title || "", cwd: cwd || "", createdAt: Number(createdAt) || 0 };
}

export function textEvent(text, ts = 0) {
  return { type: "text", role: "text", ts: Number(ts) || 0, text };
}

function appendEvents(id, meta, events) {
  if (events.length === 0) return 0;
  const filePath = path.join(OUT_DIR, `${id}.jsonl`);
  const lines = [];
  if (!fs.existsSync(filePath)) {
    lines.push(JSON.stringify(sessionRecord(id, meta.title, meta.cwd, meta.createdAt)));
  }
  for (const text of events) {
    lines.push(JSON.stringify(textEvent(text, meta.createdAt)));
  }
  fs.appendFileSync(filePath, lines.join("\n") + "\n");
  return events.length;
}

function exportDb(filePath, summaries, state) {
  const id = path.basename(filePath, ".db");
  const stat = fs.statSync(filePath);
  const prev = state.files[id] || { size: -1, mtimeMs: -1, idx: -1 };
  if (prev.size === stat.size && prev.mtimeMs === stat.mtimeMs) return 0;
  let db;
  try {
    db = new DatabaseSync(filePath, { readOnly: true });
    const rows = db.prepare(
      "SELECT idx, step_payload FROM steps WHERE idx > ? AND step_payload IS NOT NULL ORDER BY idx",
    ).all(prev.idx);
    let maxIdx = prev.idx;
    const seen = new Set();
    const texts = [];
    for (const row of rows) {
      maxIdx = Math.max(maxIdx, Number(row.idx) || 0);
      const payload = row.step_payload;
      if (!payload) continue;
      for (const text of extractProse(payload)) {
        if (seen.has(text)) continue;
        seen.add(text);
        texts.push(text);
      }
    }
    const written = appendEvents(id, summaries.get(id) || {}, texts);
    state.files[id] = { size: stat.size, mtimeMs: stat.mtimeMs, idx: maxIdx };
    return written;
  } finally {
    if (db) db.close();
  }
}

function exportPb(filePath, summaries, state) {
  const id = path.basename(filePath, ".pb");
  const stat = fs.statSync(filePath);
  const prev = state.files[id];
  if (prev && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs) return 0;
  if (prev) {
    console.error(`agy pb changed after export, left existing jsonl in place: ${id}`);
    return 0;
  }
  const texts = extractProse(fs.readFileSync(filePath));
  const written = appendEvents(id, summaries.get(id) || {}, texts);
  state.files[id] = { size: stat.size, mtimeMs: stat.mtimeMs, idx: 0 };
  return written;
}

function main() {
  const hasCli = fs.existsSync(CLI_DIR);
  const hasPb = fs.existsSync(PB_DIR);
  if (!hasCli && !hasPb) {
    console.log("agy conversations not found; skipped");
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const state = loadState();
  const summaries = loadSummaries();
  let files = 0;
  let events = 0;
  if (hasCli) {
    for (const name of fs.readdirSync(CLI_DIR)) {
      if (!name.endsWith(".db")) continue;
      try {
        events += exportDb(path.join(CLI_DIR, name), summaries, state);
        files += 1;
        saveState(state);
      } catch (err) {
        console.error(`agy db skipped ${name}: ${err.message}`);
      }
    }
  }
  if (hasPb) {
    for (const name of fs.readdirSync(PB_DIR)) {
      if (!name.endsWith(".pb")) continue;
      try {
        events += exportPb(path.join(PB_DIR, name), summaries, state);
        files += 1;
        saveState(state);
      } catch (err) {
        console.error(`agy pb skipped ${name}: ${err.message}`);
      }
    }
  }
  saveState(state);
  console.log(`agy sessions: ${files} files visited, ${events} prose events written`);
}

function saveState(state) {
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_PATH);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) main();
