#!/usr/bin/env node
/**
 * Decode one DSH session log into plaintext JSONL.
 *
 * DSH stores a session as a chain of independently compressed zstd frames: a
 * header frame plus one append frame per write. It is not a single zstd
 * stream, and `zstdDecompressSync` only reads the first frame, so this walks
 * the frame headers itself and decompresses each frame on its own.
 *
 * Read-only: the DSH log is never modified, and nothing outside <out> is written.
 *
 *   node dsh_decode.mjs <session.jsonl.zstd> <out.jsonl>
 *
 * Exits non-zero when the log holds no complete frame, so callers can keep the
 * previous decoded copy instead of replacing it with an empty file.
 *
 * This decoder covers the search path only. Repairing a torn DSH log (verify,
 * rebuild, splice, seq shifts) is a separate job; point DSH_LOG_TOOL at such a
 * tool and scripts/sync_dsh_sessions.sh will use it instead.
 */
import fs from "node:fs";
import zlib from "node:zlib";

const ZSTD_MAGIC = 0xfd2fb528;

/** Frame boundaries, per the zstd spec: magic, descriptor, optional fields, blocks. */
function scanFrames(buffer) {
  const frames = [];
  let tornStart;
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid zstd frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (offset > buffer.length) return { frames, tornStart: start };
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`);
      offset += blockType === 1 ? 1 : blockSize;
      if (offset > buffer.length) return { frames, tornStart: start };
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

const argv = process.argv.slice(2);
// Accept the `export <in> <out>` form as well, so DSH_LOG_TOOL can point at a
// richer tool that takes a subcommand without changing the caller.
const [input, out] = argv[0] === "export" ? argv.slice(1) : argv;
if (!input || !out) {
  console.error("usage: dsh_decode.mjs <session.jsonl.zstd> <out.jsonl>");
  process.exit(2);
}

const buffer = fs.readFileSync(input);
const { frames, tornStart } = scanFrames(buffer);
if (frames.length === 0) {
  console.error(`no complete zstd frame in ${input}`);
  process.exit(1);
}
const plaintext = Buffer.concat(frames.map((frame) => zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end))));
// Frame 0 is the session header line; callers treat a headerless file as junk.
if (!plaintext.length) {
  console.error(`decoded 0 bytes from ${input}`);
  process.exit(1);
}
fs.writeFileSync(out, plaintext);
if (tornStart !== undefined) {
  // The tail is incomplete because DSH was still appending. The prefix is valid
  // and grows into a byte-identical prefix next time, which is what keeps the
  // indexer's per-file offset resume correct.
  console.error(`warn: dropped torn tail from byte ${tornStart} (${buffer.length - tornStart} bytes) in ${input}`);
}
