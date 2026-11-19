import assert from "node:assert/strict";
import test from "node:test";
import { extractProse } from "../scripts/sync_agy_sessions.mjs";
import { decodeMeta, eventFromMessage, protoHashes } from "../scripts/sync_cursor_acp_sessions.mjs";

test("agy extractProse keeps prose and drops paths", () => {
  const prose = "hello this is searchable prose from agy";
  const buf = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(prose),
    Buffer.from([0]),
    Buffer.from("/work/project/secret-path"),
    Buffer.from([0]),
    Buffer.from(prose),
    Buffer.from([0]),
  ]);
  assert.deepEqual(extractProse(buf), [prose]);
});

test("cursor protoHashes reads 32-byte fields in order", () => {
  const first = Buffer.alloc(32, 0xab);
  const second = Buffer.alloc(32, 0xcd);
  const buf = Buffer.concat([
    Buffer.from([0x0a, 0x20]),
    first,
    Buffer.from([0x0a, 0x20]),
    second,
  ]);
  assert.deepEqual(protoHashes(buf), [first.toString("hex"), second.toString("hex")]);
});

test("cursor decodeMeta accepts hex and raw json", () => {
  const raw = JSON.stringify({ agentId: "abc", name: "Title" });
  assert.equal(decodeMeta(raw).agentId, "abc");
  assert.equal(decodeMeta(Buffer.from(raw).toString("hex")).name, "Title");
});

test("cursor eventFromMessage skips system and image-only parts", () => {
  assert.equal(eventFromMessage({ role: "system", content: "hidden instructions" }), null);
  assert.equal(
    eventFromMessage({
      role: "user",
      content: [{ type: "image" }, { type: "text", text: "find the bug" }],
    }).text,
    "find the bug",
  );
  assert.equal(
    eventFromMessage({
      role: "assistant",
      content: [{ type: "tool-call", toolName: "read", args: { path: "/tmp/a" } }],
    }).text,
    "read /tmp/a",
  );
  assert.match(
    eventFromMessage({
      role: "tool",
      content: [{ type: "tool-result", toolName: "read", result: "file body" }],
    }).text,
    /read file body/,
  );
});
