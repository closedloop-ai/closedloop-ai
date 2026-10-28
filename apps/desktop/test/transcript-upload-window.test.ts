/**
 * @file transcript-upload-window.test.ts
 * @description Redacted archive object window tests for transcript S3 sync.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { test } from "vitest";
import { prepareRedactedTranscriptUploadWindow } from "../src/main/transcript-sync/transcript-upload-window.js";
import { createTempDirManager } from "./helpers/temp-dir.js";

const A32 = "a".repeat(32);
const STAGED_UPLOAD_PREFIX = "closedloop-transcript-upload-";
const { makeTempDir } = createTempDirManager("transcript-upload-window-test-");

function stagedUploadDirectories(root: string): string[] {
  return readdirSync(root)
    .filter((entry) => entry.startsWith(STAGED_UPLOAD_PREFIX))
    .sort();
}

async function readStream(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

function withTempTranscript(
  name: string,
  content: string,
  run: (path: string) => Promise<void>
): Promise<void> {
  const dir = makeTempDir();
  const path = join(dir, name);
  writeFileSync(path, content);
  return run(path);
}

test("prepares redacted object bytes, checksums, and redacted ranges", async () => {
  const harmlessSecretShape = `sk_live_${A32}`;
  const rawContent =
    `${JSON.stringify({ text: `first ${harmlessSecretShape}` })}\n` +
    `${JSON.stringify({ text: "second" })}\n` +
    "partial without newline";
  const completeRawEndOffset =
    Buffer.byteLength(rawContent) -
    Buffer.byteLength("partial without newline");
  const expectedRedacted =
    `${JSON.stringify({ text: "first [REDACTED:sk_live]" })}\n` +
    `${JSON.stringify({ text: "second" })}\n`;

  await withTempTranscript("source.jsonl", rawContent, async (path) => {
    const uploadWindow = await prepareRedactedTranscriptUploadWindow(
      path,
      completeRawEndOffset
    );
    try {
      assert.equal(
        uploadWindow.planEndOffset,
        Buffer.byteLength(expectedRedacted)
      );
      assert.equal(
        uploadWindow.checksums.byteLength,
        uploadWindow.planEndOffset
      );
      assert.equal(
        uploadWindow.checksums.sha256Hex,
        createHash("sha256").update(expectedRedacted).digest("hex")
      );

      const wholeBody = await readStream(
        uploadWindow.openRangeStream(0, uploadWindow.planEndOffset)
      );
      assert.equal(wholeBody.toString("utf8"), expectedRedacted);
      assert.equal(wholeBody.includes(harmlessSecretShape), false);
      assert.equal(wholeBody.includes("partial without newline"), false);

      const rangeStart = expectedRedacted.indexOf("[REDACTED:sk_live]");
      const rangeEnd = rangeStart + "[REDACTED:sk_live]".length;
      const rangedBody = await readStream(
        uploadWindow.openRangeStream(rangeStart, rangeEnd)
      );
      assert.equal(rangedBody.toString("utf8"), "[REDACTED:sk_live]");
    } finally {
      await uploadWindow.dispose();
    }
  });
});

test("dispose removes the staged redacted object file", async () => {
  await withTempTranscript(
    "cleanup.jsonl",
    `${JSON.stringify({ text: "safe" })}\n`,
    async (path) => {
      const uploadWindow = await prepareRedactedTranscriptUploadWindow(
        path,
        Buffer.byteLength(`${JSON.stringify({ text: "safe" })}\n`)
      );

      await uploadWindow.dispose();
      await uploadWindow.dispose();
      await assert.rejects(() =>
        readStream(uploadWindow.openRangeStream(0, 1))
      );
    }
  );
});

test("ISS-8138: a failed preparation removes its staged temp directory", async () => {
  // Staging goes to `os.tmpdir()`, which every forked node-test worker shares, so
  // scanning it directly would read a sibling worker's staging directory as this
  // test's leak. `TMPDIR` is the seam that scopes the production call to one root.
  const stagingRoot = makeTempDir("transcript-upload-window-staging-root-");
  const previousTmpDir = process.env.TMPDIR;
  process.env.TMPDIR = stagingRoot;

  try {
    await assert.rejects(() =>
      prepareRedactedTranscriptUploadWindow("/definitely/not/here.jsonl", 100)
    );

    assert.deepEqual(
      stagedUploadDirectories(stagingRoot),
      [],
      "a persistently failing upload must not leak one temp directory per retry"
    );
  } finally {
    if (previousTmpDir === undefined) {
      Reflect.deleteProperty(process.env, "TMPDIR");
    } else {
      process.env.TMPDIR = previousTmpDir;
    }
  }
});

test("ISS-8138: the archive CRC64NVME is base64-encoded exactly as S3 reports it", async () => {
  // `complete` verification compares this string against S3's `ChecksumCRC64NVME`,
  // so the two things our code owns on top of the SDK -- digest byte order and
  // base64 encoding -- have to be pinned to a literal. `123456789` is the
  // published CRC-64/NVME check vector (`0xae8b14860a799888` / `rosUhgp5mIg=`);
  // the expected value below is that same reference algorithm run over the byte
  // string this line-oriented redactor actually emits, which keeps the check
  // vector's terminating newline.
  const rawContent = "123456789\n";

  await withTempTranscript("crc.jsonl", rawContent, async (path) => {
    const uploadWindow = await prepareRedactedTranscriptUploadWindow(
      path,
      Buffer.byteLength(rawContent)
    );
    try {
      assert.equal(uploadWindow.checksums.crc64NvmeBase64, "scWp6qXGJfc=");
      assert.equal(
        uploadWindow.checksums.byteLength,
        Buffer.byteLength(rawContent)
      );
    } finally {
      await uploadWindow.dispose();
    }
  });
});
