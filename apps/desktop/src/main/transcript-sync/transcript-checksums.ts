/**
 * @file transcript-checksums.ts
 * @description Streaming byte-window and newline-boundary helpers for the
 * transcript archive lane (FEA-2715).
 */
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";

/** Checksums over a `[start, end)` window plus the exact byte count streamed. */
export type WindowChecksums = {
  /** 64 lowercase hex chars. */
  sha256Hex: string;
  /** Base64, matching S3's `ChecksumCRC64NVME`. */
  crc64NvmeBase64: string;
  /** Bytes actually streamed (should equal `end - start`). */
  byteLength: number;
};

const NEWLINE = 0x0a;
const BACKSCAN_BLOCK_BYTES = 64 * 1024;

/**
 * Open a streaming reader over the `[start, end)` byte window (bytes are
 * streamed, never buffered, so multi-GB transcripts are never loaded into
 * memory — PRD FR4 / AC5). An empty or inverted range yields an already-ended
 * empty stream. Shared by redacted upload staging and its returned range reader
 * so the inclusive/exclusive boundary adjustment and empty-range guard are
 * defined once.
 */
export function openBoundedReadStream(
  path: string,
  start: number,
  end: number
): Readable {
  if (end <= start) {
    return Readable.from([]);
  }
  // Node's `end` option is INCLUSIVE, so [start, end) => end: end - 1.
  return createReadStream(path, { start, end: end - 1 });
}

/**
 * Return the offset just past the last `\n` within `[0, maxOffset)`, i.e. the
 * largest complete-line boundary at or below `maxOffset`; `0` when the window
 * contains no newline. Scans backward in blocks so it never reads the whole
 * file. Used to cut the sync window at a complete JSONL line (a partially
 * written final line is left for the next cycle).
 */
export async function findNewlineBoundary(
  filePath: string,
  maxOffset: number
): Promise<number> {
  if (maxOffset <= 0) {
    return 0;
  }
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(BACKSCAN_BLOCK_BYTES);
    let pos = maxOffset;
    while (pos > 0) {
      const readSize = Math.min(BACKSCAN_BLOCK_BYTES, pos);
      const start = pos - readSize;
      const { bytesRead } = await handle.read(buffer, 0, readSize, start);
      for (let i = bytesRead - 1; i >= 0; i--) {
        if (buffer[i] === NEWLINE) {
          return start + i + 1;
        }
      }
      pos = start;
    }
    return 0;
  } finally {
    await handle.close();
  }
}
