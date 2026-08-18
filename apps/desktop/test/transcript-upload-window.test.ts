/**
 * @file transcript-upload-window.test.ts
 * @description Redacted archive object window tests for transcript S3 sync.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { test } from "node:test";
import { prepareRedactedTranscriptUploadWindow } from "../src/main/transcript-sync/transcript-upload-window.js";
import { createTempDirManager } from "./helpers/temp-dir.js";

const A32 = "a".repeat(32);
const { makeTempDir } = createTempDirManager("transcript-upload-window-test-");

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
