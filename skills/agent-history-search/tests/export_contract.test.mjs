import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractProse, sessionRecord as agySession, textEvent } from "../scripts/sync_agy_sessions.mjs";
import { eventFromMessage, sessionRecord as cursorSession } from "../scripts/sync_cursor_acp_sessions.mjs";
import { eventFor as devinEvent, sessionRecord as devinSession } from "../scripts/sync_devin_sessions.mjs";
import { eventFor as openEvent, sessionRecord as openSession } from "../scripts/sync_opencode_sessions.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Plugins ship in the repo root, one level above the skill folder.
const pluginsDir = process.env.RECALL_PLUGINS_DIR ?? path.resolve(root, "../../plugins");

function pluginTest(plugin, lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-contract-"));
  const file = path.join(dir, "sample.jsonl");
  const body = lines
    .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
    .join("\n");
  fs.writeFileSync(file, `${body}\n`);
  const result = spawnSync("recall", ["plugin", "test", path.join(pluginsDir, plugin), file], {
    encoding: "utf8",
  });
  const out = `${result.stdout || ""}\n${result.stderr || ""}`;
  assert.equal(result.status, 0, out);
  return out;
}

test("opencode writer events survive the lua plugin", () => {
  const text = openEvent({
    role: "user",
    ts: 2,
    data: JSON.stringify({ type: "text", text: "opencode-contract-alpha" }),
  });
  const tool = openEvent({
    role: "assistant",
    ts: 3,
    data: JSON.stringify({ type: "tool", tool: "read", state: { input: { path: "/tmp/contract.txt" } } }),
  });
  assert.equal(
    openEvent({ role: "assistant", ts: 4, data: JSON.stringify({ type: "reasoning", text: "hidden-reasoning" }) }),
    null,
  );
  const out = pluginTest("opencode.lua", [openSession("oc-1", "T", "/tmp/proj", 1), text, tool]);
  assert.match(out, /session oc-1/);
  assert.match(out, /opencode-contract-alpha/);
  assert.match(out, /read \/tmp\/contract\.txt/);
  assert.doesNotMatch(out, /hidden-reasoning/);
});

test("devin writer drops system and sysprompt before the lua plugin", () => {
  const user = devinEvent({
    created_at: 2,
    chat_message: JSON.stringify({ role: "user", content: "devin-contract-beta" }),
  });
  assert.equal(
    devinEvent({ created_at: 3, chat_message: JSON.stringify({ role: "system", content: "hidden-sys" }) }),
    null,
  );
  assert.equal(
    devinEvent({
      created_at: 4,
      chat_message: JSON.stringify({
        role: "user",
        content: "hidden-prompt",
        metadata: { telemetry: { source: "sysprompt" } },
      }),
    }),
    null,
  );
  const out = pluginTest("devin.lua", [devinSession("dv-1", "T", "/tmp/proj", 1), user]);
  assert.match(out, /devin-contract-beta/);
  assert.doesNotMatch(out, /hidden-sys/);
  assert.doesNotMatch(out, /hidden-prompt/);
});

test("cursor writer events survive the lua plugin", () => {
  const ev = eventFromMessage({
    role: "assistant",
    content: [{ type: "tool-call", toolName: "read", args: { path: "/tmp/contract-cursor.txt" } }],
  });
  assert.equal(eventFromMessage({ role: "system", content: "hidden-cursor-system" }), null);
  const out = pluginTest("cursor-acp.lua", [cursorSession("cu-1", "T", "/tmp/proj", 1), ev]);
  assert.match(out, /read \/tmp\/contract-cursor\.txt/);
  assert.doesNotMatch(out, /hidden-cursor-system/);
});

test("agy prose events survive the lua plugin and drop paths", () => {
  const prose = "hello this is searchable prose from agy";
  const buf = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(prose),
    Buffer.from([0]),
    Buffer.from("/work/project/secret-path"),
    Buffer.from([0]),
  ]);
  const events = extractProse(buf).map(textEvent);
  const out = pluginTest("agy.lua", [agySession("agy-1", "T", "/tmp/proj", 1), ...events]);
  assert.match(out, /searchable prose from agy/);
  assert.doesNotMatch(out, /secret-path/);
});

test("droid and omp native lines keep text and drop thinking", () => {
  const droid = pluginTest("droid.lua", [
    JSON.stringify({ type: "session_start", id: "droid-fix-1", cwd: "/tmp/proj", title: "Fixture" }),
    JSON.stringify({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "droid-fixture-alpha" }] },
    }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "ack" },
          { type: "tool_use", name: "Read", input: { path: "/tmp/proj/a.txt" } },
          { type: "thinking", text: "hidden-thought" },
        ],
      },
    }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Bash", input: { flag: true, nested: { no: "crash" } } }],
      },
    }),
  ]);
  assert.match(droid, /droid-fixture-alpha/);
  assert.match(droid, /Read \/tmp\/proj\/a\.txt/);
  assert.match(droid, /Bash true/);
  assert.doesNotMatch(droid, /hidden-thought/);

  const omp = pluginTest("omp.lua", [
    JSON.stringify({ type: "session", id: "omp-fix-1", cwd: "/tmp/proj", title: "Fixture" }),
    JSON.stringify({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "omp-fixture-beta" }] },
    }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "skip-me" },
          { type: "text", text: "done" },
          { type: "toolCall", name: "read", arguments: { path: "/tmp/proj/b.txt" } },
        ],
      },
    }),
  ]);
  assert.match(omp, /omp-fixture-beta/);
  assert.match(omp, /done read \/tmp\/proj\/b\.txt/);
  assert.doesNotMatch(omp, /skip-me/);
});
