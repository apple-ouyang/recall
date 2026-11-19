#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// Export Cursor ACP sessions to ~/.recall/cursor-acp/<id>.jsonl.
//
// store.db holds content-addressed blobs. Message blobs are plaintext JSON
// mixed with protobuf nodes and images. SQLite rowid is insertion order, so
// the export walks rowid and appends new blobs only. System blobs are skipped.
// The DB is opened read-only. If rowids are reused the existing JSONL is left
// in place.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HOME = os.homedir();
const ACP_DIR = process.env.CURSOR_ACP_DIR || path.join(HOME, ".cursor/acp-sessions");
const OUT_DIR = process.env.RECALL_CURSOR_ACP_DIR || path.join(HOME, ".recall/cursor-acp");
const STATE_PATH = path.join(OUT_DIR, ".sync-state.json");
const TOOL_LIMIT = 400;

export function decodeMeta(value) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);
  return JSON.parse(Buffer.from(trimmed, "hex").toString("utf8"));
}

function readVarint(buf, offset) {
  let value = 0;
  let shift = 0;
  let i = offset;
  while (i < buf.length && shift <= 35) {
    const byte = buf[i];
    i += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, offset: i };
    shift += 7;
  }
  return null;
}

export function protoHashes(buf) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const hashes = [];
  let i = 0;
  while (i < data.length) {
    const tag = readVarint(data, i);
    if (!tag) break;
    i = tag.offset;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value % 8;
    if (field === 0) break;
    if (wire === 0) {
      const skipped = readVarint(data, i);
      if (!skipped) break;
      i = skipped.offset;
    } else if (wire === 2) {
      const len = readVarint(data, i);
      if (!len) break;
      i = len.offset;
      if (i + len.value > data.length) break;
      const payload = data.subarray(i, i + len.value);
      i += len.value;
      if (payload.length === 32) hashes.push(payload.toString("hex"));
    } else if (wire === 5) {
      i += 4;
    } else if (wire === 1) {
      i += 8;
    } else {
      break;
    }
  }
  return hashes;
}

const ARG_KEYS = ["command", "path", "file_path", "filePath", "pattern", "query", "url", "skill", "prompt"];

function summarize(input) {
  if (typeof input === "string") return input.replace(/\s+/g, " ").trim().slice(0, TOOL_LIMIT);
  if (!input || typeof input !== "object") return "";
  for (const key of ARG_KEYS) {
    if (typeof input[key] === "string" && input[key] !== "") {
      return input[key].replace(/\s+/g, " ").trim().slice(0, TOOL_LIMIT);
    }
  }
  try {
    return JSON.stringify(input).slice(0, TOOL_LIMIT);
  } catch {
    return "";
  }
}

export function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const bits = [];
  for (const part of content) {
    if (typeof part === "string" && part !== "") bits.push(part);
    else if (part && typeof part.text === "string" && part.text !== "") bits.push(part.text);
  }
  return bits.join("\n");
}

function toolBits(content) {
  if (!Array.isArray(content)) return [];
  const bits = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "tool-call" || part.type === "tool_use") {
      const name = part.toolName || part.name || "tool";
      bits.push(`${name} ${summarize(part.args || part.input || part.arguments)}`.trim());
    } else if (part.type === "tool-result" || part.type === "tool_result") {
      const name = part.toolName || part.name || "tool";
      const body = typeof part.result === "string" ? part.result : textOf(part.experimental_content);
      const flat = body.replace(/\s+/g, " ").trim().slice(0, TOOL_LIMIT);
      if (flat) bits.push(`${name} ${flat}`.trim());
    }
  }
  return bits;
}

export function sessionRecord(id, title, cwd, createdAt) {
  return { type: "session", id, title: title || "", cwd: cwd || "", createdAt: Number(createdAt) || 0 };
}

export function eventFromMessage(obj) {
  if (!obj || typeof obj !== "object") return null;
  const role = obj.role;
  if (role === "system" || role == null) return null;
  const prose = textOf(obj.content).trim();
  const tools = toolBits(obj.content);
  if (role === "tool" || (prose === "" && tools.length > 0)) {
    const text = tools.join("\n").slice(0, TOOL_LIMIT);
    if (text === "") return null;
    return { type: "tool", name: "tool", ts: 0, text };
  }
  if (role !== "user" && role !== "assistant") return null;
  const text = [prose, ...tools].filter(Boolean).join("\n").trim();
  if (text === "") return null;
  return { type: "text", role, ts: 0, text };
}

function loadState() {
  try {
    const st = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    if (!st || typeof st.sessions !== "object") throw new Error("shape");
    return st;
  } catch (err) {
    if (err && err.code === "ENOENT") return { sessions: {} };
    console.error(
      `corrupt sync state: ${STATE_PATH}\ndelete ${OUT_DIR} and rerun to rebuild the disposable cache`,
    );
    process.exit(1);
  }
}

function readCwd(dir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
    return typeof meta.cwd === "string" ? meta.cwd : "";
  } catch {
    return "";
  }
}

function exportSession(dir, state) {
  const dbPath = path.join(dir, "store.db");
  if (!fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0) return 0;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const metaRow = db.prepare("SELECT value FROM meta LIMIT 1").get();
    if (!metaRow) return 0;
    const meta = decodeMeta(metaRow.value);
    const id = meta.agentId || path.basename(dir);
    const saved = state.sessions[id];
    const prev = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : { rowid: 0, tip: "" };
    if (prev.rowid > 0) {
      const tip = db.prepare("SELECT id FROM blobs WHERE rowid = ?").get(prev.rowid);
      if (!tip || tip.id !== prev.tip) {
        console.error(`cursor-acp blob rowids changed, left existing export: ${id}`);
        return 0;
      }
    }
    const rows = db.prepare("SELECT rowid, id, data FROM blobs WHERE rowid > ? ORDER BY rowid").all(prev.rowid);
    const lines = [];
    let written = 0;
    let watermark = prev;
    for (const row of rows) {
      watermark = { rowid: Number(row.rowid), tip: row.id };
      if (!row.data) continue;
      const data = Buffer.from(row.data);
      if (data[0] !== 0x7b && data[0] !== 0x5b) continue;
      let obj;
      try {
        obj = JSON.parse(data.toString("utf8"));
      } catch {
        continue;
      }
      const ev = eventFromMessage(obj);
      if (!ev) continue;
      lines.push(JSON.stringify(ev));
      written += 1;
    }
    if (written > 0) {
      const filePath = path.join(OUT_DIR, `${id}.jsonl`);
      if (!fs.existsSync(filePath)) {
        lines.unshift(
          JSON.stringify(
            sessionRecord(id, typeof meta.name === "string" ? meta.name : "", readCwd(dir), meta.createdAt),
          ),
        );
      }
      fs.appendFileSync(filePath, lines.join("\n") + "\n");
    }
    state.sessions[id] = watermark;
    return written;
  } finally {
    db.close();
  }
}

function main() {
  if (!fs.existsSync(ACP_DIR)) {
    console.log(`cursor acp dir not found: ${ACP_DIR}; skipped`);
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const state = loadState();
  let sessions = 0;
  let events = 0;
  for (const name of fs.readdirSync(ACP_DIR)) {
    const dir = path.join(ACP_DIR, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    try {
      events += exportSession(dir, state);
      sessions += 1;
    } catch (err) {
      console.error(`cursor-acp skipped ${name}: ${err.message}`);
    }
  }
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_PATH);
  console.log(`cursor-acp sessions: ${sessions} dirs visited, ${events} events written`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) main();
