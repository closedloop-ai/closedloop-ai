import { gzipSync } from "node:zlib";
import { SyncPayloadEncoding } from "@repo/api/src/types/agent-session";

/**
 * @file agent-session-sync-compression.ts
 * @description FEA-4138: gzip helpers for the desktop → cloud agent-session sync
 * lane. Compression is applied to the serialized batch BEFORE the byte-cap /
 * chunk decision, so the cap now bounds the COMPRESSED wire bytes: the vast
 * majority of sessions (JSON transcripts compress ~5-10x) then fit one request
 * with no chunking, and the 3-7 MiB sessions that used to dead-letter on the
 * uncompressed cap almost always fit under 256 KiB compressed and are rescued.
 *
 * Chunk identity (FEA-3474) is unchanged: the chunker still paginates the
 * PRE-compression structure on valid boundaries; only the SIZING function it
 * consults is swapped for `gzippedByteLength` so it packs to the compressed cap.
 */

/**
 * JSON-serialize then gzip a sync value, returning the compressed bytes.
 *
 * The return type is pinned to `Buffer<ArrayBuffer>` — the non-shared buffer
 * `zlib.gzipSync` actually returns — rather than the bare `Buffer` alias, which
 * defaults to `Buffer<ArrayBufferLike>` and so claims the bytes MIGHT be backed
 * by a `SharedArrayBuffer`. Every byte sink that refuses shared memory (`fetch`'s
 * `BodyInit` first among them, via `BufferSource = ArrayBufferView<ArrayBuffer> |
 * ArrayBuffer`) rejects the widened type, so the alias erased a guarantee the
 * HTTP sync transport depends on.
 */
export function gzipJson(value: unknown): Buffer<ArrayBuffer> {
  return gzipSync(Buffer.from(JSON.stringify(value)));
}

/**
 * Serialized-then-gzipped byte length of a value. This is the compression-aware
 * analogue of `Buffer.byteLength(JSON.stringify(value))` that the cap/chunk
 * seam consults when the server advertises decompression support.
 */
export function gzippedByteLength(value: unknown): number {
  return gzipJson(value).length;
}

/** Raw (decompressed) JSON byte length of a value. */
export function rawJsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/**
 * Byte-sizing strategy the payload preparer / chunker consult. `identity`
 * measures raw JSON bytes (the legacy path when the server can't decompress);
 * `gzip` measures compressed bytes so the cap decision reflects wire size.
 *
 * FEA-4152: `decompressedByteLength` is the size the SERVER sees after it
 * decodes the body — raw JSON bytes for both encodings (for `identity` the wire
 * bytes ARE the decompressed bytes, so it equals `byteLength`). The chunker
 * consults it to enforce the producer's decompressed-size target
 * (`SYNC_DECOMPRESSED_CHUNK_TARGET_BYTES`, 4 MiB) IN ADDITION to the compressed
 * wire cap: a highly-repetitive payload can gzip under the 256 KiB wire cap yet
 * decompress over that target. Bounding both dimensions keeps such a payload
 * chunked further instead of shipping whole and dead-lettering.
 *
 * ISS-5992: the producer target is deliberately BELOW the server's enforced
 * `SYNC_DECOMPRESSED_BYTE_CEILING` (16 MiB). The gap is the safety margin for
 * independent deploys — see both constants in `@repo/api`.
 */
export type SyncPayloadSizer = {
  encoding: SyncPayloadEncoding;
  byteLength: (value: unknown) => number;
  decompressedByteLength: (value: unknown) => number;
};

/** Raw-JSON sizer — the legacy uncompressed path. */
export const identitySyncPayloadSizer: SyncPayloadSizer = {
  encoding: SyncPayloadEncoding.Identity,
  byteLength: rawJsonByteLength,
  decompressedByteLength: rawJsonByteLength,
};

/** Compressed sizer — measures gzipped wire bytes. */
export const gzipSyncPayloadSizer: SyncPayloadSizer = {
  encoding: SyncPayloadEncoding.Gzip,
  byteLength: gzippedByteLength,
  decompressedByteLength: rawJsonByteLength,
};

/** Select the sizer for whether the server negotiated compression support. */
export function syncPayloadSizerFor(compress: boolean): SyncPayloadSizer {
  return compress ? gzipSyncPayloadSizer : identitySyncPayloadSizer;
}
