/**
 * @file transcript-upload-window.ts
 * @description Prepared upload-byte windows for transcript archive sync.
 *
 * The local transcript source remains raw JSONL on disk, but S3 archive uploads
 * must be planned, checksummed, and ranged over redacted object bytes. This
 * module streams a complete-line raw window through the shared redaction helper
 * once, stages the redacted bytes on disk, and exposes bounded redacted ranges
 * for full and multipart uploads without buffering large transcripts in memory.
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Crc64Nvme } from "@aws-sdk/crc64-nvme";
import { redactJsonlTranscriptByteChunks } from "@repo/lib/security/redacted-jsonl-transcript";
import {
  openBoundedReadStream,
  type WindowChecksums,
} from "./transcript-checksums.js";

export type TranscriptUploadWindow = {
  /** Redacted archive object byte length. */
  planEndOffset: number;
  /** Checksums over `[0, planEndOffset)` in the redacted archive object. */
  checksums: WindowChecksums;
  /** Open a stream over redacted archive bytes `[start, end)`. */
  openRangeStream: (start: number, end: number) => Readable;
  /** Remove staged redacted bytes. Safe to call repeatedly. */
  dispose: () => Promise<void>;
};

/**
 * Prepare a redacted archive object window from raw source bytes
 * `[0, rawEndOffset)`, where `rawEndOffset` is already cut to a complete JSONL
 * boundary by the caller.
 */
export async function prepareRedactedTranscriptUploadWindow(
  sourcePath: string,
  rawEndOffset: number
): Promise<TranscriptUploadWindow> {
  const dir = await mkdtemp(join(tmpdir(), "closedloop-transcript-upload-"));
  const stagedPath = join(dir, "redacted.jsonl");
  const sha = createHash("sha256");
  const crc = new Crc64Nvme();
  let byteLength = 0;

  try {
    const rawWindow = openBoundedReadStream(sourcePath, 0, rawEndOffset);
    const redactedChunks = checksumRedactedChunks(
      redactJsonlTranscriptByteChunks(rawWindow),
      (chunk) => {
        sha.update(chunk);
        crc.update(chunk);
        byteLength += chunk.length;
      }
    );
    await pipeline(
      redactedChunks,
      createWriteStream(stagedPath, { flags: "wx" })
    );
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }

  const crcDigest = await crc.digest();
  const checksums = {
    sha256Hex: sha.digest("hex"),
    crc64NvmeBase64: Buffer.from(crcDigest).toString("base64"),
    byteLength,
  };

  return {
    planEndOffset: byteLength,
    checksums,
    openRangeStream: (start, end) =>
      openBoundedReadStream(stagedPath, start, end),
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}

async function* checksumRedactedChunks(
  chunks: AsyncIterable<Uint8Array>,
  onChunk: (chunk: Buffer) => void
): AsyncGenerator<Buffer> {
  for await (const chunk of chunks) {
    const buffer = Buffer.from(chunk);
    onChunk(buffer);
    yield buffer;
  }
}
