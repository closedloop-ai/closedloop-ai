/**
 * @file transcript-checksums.ts
 * @description Streaming checksums + newline-boundary helpers for the transcript
 * archive lane (FEA-2715). The control plane (PLN-1287) requires, for the window
 * `[0, planEndOffset)`, a sha256 (64 lowercase hex — archive identity /
 * idempotency) and a CRC64NVME (base64, exactly as S3 reports `ChecksumCRC64NVME`
 * — integrity). Both are computed in a SINGLE streamed pass over the byte range
 * so multi-GB transcripts are never loaded into memory (PRD FR4 / AC5).
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { Crc64Nvme } from "@aws-sdk/crc64-nvme";

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
 * empty stream. Shared by the checksum pass (`digestStream`) and the executor's
 * upload path so the inclusive/exclusive boundary adjustment and empty-range
 * guard are defined once.
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

async function digestStream(
  filePath: string,
  start: number,
  end: number
): Promise<WindowChecksums> {
  const sha = createHash("sha256");
  const crc = new Crc64Nvme();
  let byteLength = 0;

  if (end > start) {
    await new Promise<void>((resolve, reject) => {
      const stream = openBoundedReadStream(filePath, start, end);
      stream.on("data", (chunk) => {
        const buf = chunk as Buffer;
        sha.update(buf);
        crc.update(buf);
        byteLength += buf.length;
      });
      stream.on("error", reject);
      stream.on("end", resolve);
    });
  }

  const crcDigest = await crc.digest();
  return {
    sha256Hex: sha.digest("hex"),
    crc64NvmeBase64: Buffer.from(crcDigest).toString("base64"),
    byteLength,
  };
}

/**
 * Compute sha256 + CRC64NVME over `[0, endOffset)` — the full synced window the
 * `sync-plan` / `complete` requests describe. `endOffset === 0` yields the
 * checksums of the empty input.
 */
export function computeWindowChecksums(
  filePath: string,
  endOffset: number
): Promise<WindowChecksums> {
  return digestStream(filePath, 0, endOffset);
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
