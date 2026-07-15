/**
 * @file file-size-admission.test.ts
 * @description FEA-3132 (B1/B5) — cold full-file reads in the collectors must
 * size-admit before buffering, so a pathologically large file can't OOM the
 * db-host worker on the cold parse. Uses SPARSE files (truncate to a large
 * logical size with no real bytes) so the "oversized → skip" path is exercised
 * instantly without allocating hundreds of MB. Also pins the normal small-file
 * path so the guard doesn't regress real transcripts.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { parseChatSessionFile } from "../src/main/collectors/copilot/copilot-parser.js";
import { extractTranscriptTokens } from "../src/main/database/transcript.js";

const tempDirs: string[] = [];

test.after(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "size-admission-"));
  tempDirs.push(dir);
  return dir;
}

test("extractTranscriptTokens skips a file over LARGE_FILE_SIZE_BYTES (200MB)", async () => {
  const dir = await tempDir();
  const big = path.join(dir, "huge.jsonl");
  await writeFile(big, "");
  await truncate(big, 300 * 1024 * 1024); // 300 MiB sparse — over the 200 MiB cap
  // Without the guard this would readFileSync the whole file; the guard returns
  // null BEFORE buffering. (A sparse file would otherwise read as 300MB of NULs
  // and yield a non-null empty extract, so null here is the guard firing.)
  assert.equal(extractTranscriptTokens(big), null);
});

test("extractTranscriptTokens still processes a normal small transcript", async () => {
  const dir = await tempDir();
  const small = path.join(dir, "small.jsonl");
  await writeFile(
    small,
    `${JSON.stringify({
      message: {
        model: "claude-test",
        usage: { input_tokens: 3, output_tokens: 5 },
      },
    })}\n`
  );
  const extract = extractTranscriptTokens(small);
  assert.notEqual(extract, null);
});

test("parseChatSessionFile skips a chat file over MAX_CHAT_FILE_BYTES (64MB)", async () => {
  const dir = await tempDir();
  const big = path.join(dir, "huge-chat.json");
  // Write a SMALL, VALID chat session: without the size guard this parses to a
  // NON-null session (proven by parseGuardBaseline below). A sparse NUL file
  // would instead make JSON.parse throw and return null anyway, so it could not
  // distinguish "guard fired" from "parse failed". Mock statSync to report an
  // oversized file so the guard short-circuits BEFORE readFileSync/JSON.parse.
  const validChat = JSON.stringify({
    sessionId: "huge-session",
    creationDate: 1_710_000_000_000,
    lastMessageDate: 1_710_000_060_000,
    requests: [
      {
        id: "req-1",
        timestamp: 1_710_000_000_000,
        message: { text: "hi" },
        response: { markdown: "hello" },
      },
    ],
  });
  await writeFile(big, validChat);

  const realStatSync = fs.statSync;
  mock.method(fs, "statSync", (statPath: fs.PathLike): fs.Stats => {
    const st = realStatSync(statPath);
    if (statPath === big) {
      Object.defineProperty(st, "size", { value: 80 * 1024 * 1024 }); // over the 64 MiB cap
    }
    return st;
  });

  assert.equal(parseChatSessionFile(big, null), null);
  mock.restoreAll();

  // Baseline: the SAME on-disk content parses to a non-null session once the
  // mocked oversize is gone — confirming the null above is the guard firing,
  // not a parse failure.
  assert.notEqual(parseChatSessionFile(big, null), null);
});
