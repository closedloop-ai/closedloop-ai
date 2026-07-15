/**
 * @file transcript-checksums.test.ts
 * @description FEA-2715 streamed checksum + newline-boundary helpers. Verifies
 * the CRC64NVME matches the canonical vector (so it equals what S3 reports),
 * that streamed hashing equals a one-shot hash, and that the window is cut at
 * the last complete newline.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  computeWindowChecksums,
  findNewlineBoundary,
} from "../src/main/transcript-sync/transcript-checksums.js";

function withTempFile(
  name: string,
  bytes: Buffer,
  run: (path: string) => Promise<void>
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "transcript-checksums-"));
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return run(path).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("computeWindowChecksums matches the canonical CRC64NVME vector", async () => {
  await withTempFile("check.jsonl", Buffer.from("123456789"), async (path) => {
    const result = await computeWindowChecksums(path, 9);
    // The unique thing this guards: our base64 encoding of the CRC64NVME digest
    // equals the canonical value 0xae8b14860a799888 exactly as S3 reports it, so
    // `complete` verification (head.checksumCrc64Nvme === request.crc64nvme) holds.
    assert.equal(result.crc64NvmeBase64, "rosUhgp5mIg=");
    assert.equal(result.byteLength, 9);
  });
});

test("streamed checksums over a partial window equal a one-shot hash of that window", async () => {
  const content = Buffer.from(`${"x".repeat(5000)}\n${"y".repeat(5000)}\n`);
  await withTempFile("big.jsonl", content, async (path) => {
    const windowEnd = 5001; // through the first newline
    const result = await computeWindowChecksums(path, windowEnd);
    const expectedSha = createHash("sha256")
      .update(content.subarray(0, windowEnd))
      .digest("hex");
    assert.equal(result.sha256Hex, expectedSha);
    assert.equal(result.byteLength, windowEnd);
  });
});

test("findNewlineBoundary returns the offset past the last complete line", async () => {
  await withTempFile(
    "lines.jsonl",
    Buffer.from("aaa\nbbb\nccc"),
    async (path) => {
      // "aaa\nbbb\nccc" — last '\n' at index 7, so the boundary is 8; the partial
      // "ccc" tail is excluded.
      assert.equal(await findNewlineBoundary(path, 11), 8);
    }
  );
});

test("findNewlineBoundary is 0 when the window has no newline", async () => {
  await withTempFile(
    "noline.jsonl",
    Buffer.from("partial line"),
    async (path) => {
      assert.equal(await findNewlineBoundary(path, 12), 0);
    }
  );
});

test("findNewlineBoundary includes a trailing newline", async () => {
  await withTempFile("trail.jsonl", Buffer.from("aaa\n"), async (path) => {
    assert.equal(await findNewlineBoundary(path, 4), 4);
  });
});
