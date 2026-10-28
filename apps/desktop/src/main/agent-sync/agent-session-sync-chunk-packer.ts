/**
 * @file agent-session-sync-chunk-packer.ts
 * @description The byte-bounded greedy packer behind `chunkOversizedSession`,
 * plus the chunk-marker reserve every built chunk carries. Extracted from
 * `agent-session-sync-payload.ts` (ISS-9859) so that file stays under the
 * 1,000-line ceiling; the behavior is unchanged, and the dependency runs one
 * way — the packer knows nothing about which streams exist.
 */
import { MAX_SESSION_SYNC_CHUNKS } from "@repo/api/src/types/agent-session";
import { SYNC_DECOMPRESSED_CHUNK_TARGET_BYTES } from "@repo/api/src/types/agent-session-sync-limits";
import {
  identitySyncPayloadSizer,
  type SyncPayloadSizer,
} from "./agent-session-sync-compression.js";
import type {
  SyncedAgentSession,
  SyncedAgentSessionChunkMeta,
} from "./agent-session-sync-contract.js";

/**
 * FEA-3788: worst-case-width placeholder for the `chunk: { index, total }`
 * marker, used only to RESERVE the marker's serialized bytes while chunking
 * (see `withChunkMarkerReserve`). A real marker's `total` is at most
 * `MAX_SESSION_SYNC_CHUNKS` and its `index` is `0..total-1`, so both numbers'
 * serialized digit widths are bounded by these values — the final
 * `stampChunkMetadata` stamp is therefore never wider than what sizing reserved,
 * and a full chunk can never spill past `maxBytes` after stamping.
 */
export const CHUNK_MARKER_SIZE_RESERVE: SyncedAgentSessionChunkMeta = {
  index: MAX_SESSION_SYNC_CHUNKS - 1,
  total: MAX_SESSION_SYNC_CHUNKS,
};

/**
 * Greedily pack `items` into byte-bounded chunks (each built via `buildChunk`),
 * appending finished chunks to `chunks`. Returns false — signaling the caller
 * to dead-letter — when a single item plus the replicated metadata exceeds
 * `maxBytes`, or when the chunk budget (MAX_SESSION_SYNC_CHUNKS) is exhausted.
 *
 * FEA-3719: measure the replicated per-chunk base (metadata + agents + the
 * empty paginated stream) ONCE and track each in-progress chunk's serialized
 * size with a running byte total, instead of re-`JSON.stringify`-ing the whole
 * session for every candidate item. Because `JSON.stringify` emits no
 * whitespace, a chunk's exact serialized byte length is the empty-stream base
 * plus each item's own JSON byte length plus one separator (`,`) byte between
 * items — i.e. `[a,b]` is `[` + a + `,` + b + `]`, and the empty `[]` base
 * already accounts for the two bracket bytes. This keeps chunking O(N·itemSize)
 * rather than O(N·(metadata + slice)), which matters now that FEA-3672 pushed
 * `metadata.messages[]` previews to ~60–76 KiB replicated into every chunk.
 *
 * FEA-4138: the O(1) running-byte-total is only valid when the sizer measures
 * RAW JSON, whose length is exactly additive across items + one separator byte.
 * Compressed (gzip) byte length is NOT additive — adding an item can grow the
 * compressed size by more or less than its raw contribution — so when the cap
 * bounds compressed bytes the greedy pack must re-measure each candidate chunk's
 * true compressed size. That path is O(N·chunkCompress) but only runs on the
 * rare session that STILL exceeds the cap after whole-session compression, and
 * it is bounded by `MAX_SESSION_SYNC_CHUNKS`.
 */
export function appendPaginatedChunks<T>(
  chunks: SyncedAgentSession[],
  items: readonly T[],
  maxBytes: number,
  buildChunk: (slice: T[]) => SyncedAgentSession,
  sizer: SyncPayloadSizer = identitySyncPayloadSizer,
  maxDecompressedBytes: number = SYNC_DECOMPRESSED_CHUNK_TARGET_BYTES,
  // ISS-4541 (P1 #2): optional hard per-chunk ROW ceiling, independent of bytes.
  // The activity-segment stream sets this to MAX_SYNCED_ACTIVITY_SEGMENTS so a
  // byte-fitting slice can never exceed the receiver's per-payload row cap and
  // get the chunk rejected + re-prepared forever. Omitted (Infinity) for the
  // event/tokenEvent streams, which the wire schema does not row-cap.
  maxRowsPerChunk: number = Number.POSITIVE_INFINITY,
  // ISS-6884: how many WIRE ROWS one item contributes, for streams whose
  // pagination unit is not one row. Component usage paginates by whole
  // (kind,key) group, so an item is a group and its weight is its branch-row
  // count — the row ceiling still bounds the emitted array, not the item count.
  // Defaults to one row per item (events, token events, activity segments).
  itemRowCount: (item: T) => number = singleRowPerItem
): boolean {
  if (sizer.encoding !== identitySyncPayloadSizer.encoding) {
    return appendPaginatedChunksByMeasuredSize(
      chunks,
      items,
      maxBytes,
      buildChunk,
      sizer,
      maxDecompressedBytes,
      maxRowsPerChunk,
      itemRowCount
    );
  }
  // Identity fast path: wire bytes ARE the decompressed bytes, and `maxBytes`
  // (256 KiB) is far below `maxDecompressedBytes` (4 MiB), so a chunk that fits
  // the wire cap trivially clears the ceiling — no separate decompressed check
  // is needed and the O(1) running-byte-total stays valid.
  const baseBytes = sizer.byteLength(buildChunk([]));

  let current: T[] = [];
  let currentBytes = baseBytes;
  let currentRows = 0;
  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item));
    const itemRows = itemRowCount(item);
    // A leading separator byte is only added once the chunk already holds an item.
    const marginalBytes = current.length > 0 ? itemBytes + 1 : itemBytes;
    // A chunk seals when the NEXT item would exceed EITHER the byte cap OR the
    // per-chunk row ceiling (P1 #2), whichever binds first.
    if (
      currentBytes + marginalBytes <= maxBytes &&
      currentRows + itemRows <= maxRowsPerChunk
    ) {
      current.push(item);
      currentBytes += marginalBytes;
      currentRows += itemRows;
      continue;
    }
    if (current.length === 0) {
      return false;
    }
    if (chunks.length + 1 >= MAX_SESSION_SYNC_CHUNKS) {
      return false;
    }
    chunks.push(buildChunk(current));
    current = [item];
    currentBytes = baseBytes + itemBytes;
    currentRows = itemRows;
    if (currentBytes > maxBytes || currentRows > maxRowsPerChunk) {
      return false;
    }
  }
  if (current.length > 0) {
    if (chunks.length + 1 > MAX_SESSION_SYNC_CHUNKS) {
      return false;
    }
    chunks.push(buildChunk(current));
  }
  return true;
}

/**
 * Pack the three REQUIRED streams into `chunks`, in priority order, and report
 * whether all of them fit. False means the caller must dead-letter: a required
 * stream that cannot be carried in full is never shipped in part.
 *
 * ISS-4541 (P1 #3 — reserve the tiling budget FIRST): the activity tiling is
 * packed BEFORE the degradable streams the caller adds afterwards. The tiling
 * must reach the cloud IN FULL or the whole session dead-letters for a larger
 * retry (a partial tiling is silent data loss), whereas token events are
 * best-effort. If token events packed first they could consume the shared
 * `MAX_SESSION_SYNC_CHUNKS` budget and STARVE the tiling, dead-lettering an
 * otherwise-fine session.
 *
 * P1 #2 — each activity chunk is bounded at `maxActivityRowsPerChunk` rows, not
 * bytes alone. The cloud wire schema caps `activitySegmentRows` per payload, so
 * a byte-fitting slice with MORE rows would be rejected by the receiver and
 * re-prepared identically FOREVER.
 *
 * ISS-9859: the two PR lists, `prRefs` then `prs`, join the same tier for the
 * same reason — a session that cannot carry them all dead-letters rather than
 * shipping a partial set, and packing them here keeps the degradable streams
 * from starving them. Each list packs as its own run of parts rather than
 * sharing one: a part then varies a single array, so its measured empty chunk
 * already holds that array's key and the additive byte count stays exact. A
 * stream the caller is not paginating arrives empty, which packs nothing and
 * succeeds.
 */
export function appendRequiredStreamChunks<EventRow, SegmentRow, PrRef, Pr>(
  chunks: SyncedAgentSession[],
  streams: {
    events: readonly EventRow[];
    buildEventChunk: (slice: EventRow[]) => SyncedAgentSession;
    activitySegmentRows: readonly SegmentRow[];
    buildActivitySegmentChunk: (slice: SegmentRow[]) => SyncedAgentSession;
    maxActivityRowsPerChunk: number;
    prRefs: readonly PrRef[];
    buildPrRefChunk: (slice: PrRef[]) => SyncedAgentSession;
    prs: readonly Pr[];
    buildPrChunk: (slice: Pr[]) => SyncedAgentSession;
    maxBytes: number;
    sizer: SyncPayloadSizer;
    maxDecompressedBytes: number;
  }
): boolean {
  return (
    appendPaginatedChunks(
      chunks,
      streams.events,
      streams.maxBytes,
      streams.buildEventChunk,
      streams.sizer,
      streams.maxDecompressedBytes
    ) &&
    appendPaginatedChunks(
      chunks,
      streams.activitySegmentRows,
      streams.maxBytes,
      streams.buildActivitySegmentChunk,
      streams.sizer,
      streams.maxDecompressedBytes,
      streams.maxActivityRowsPerChunk
    ) &&
    appendPaginatedChunks(
      chunks,
      streams.prRefs,
      streams.maxBytes,
      streams.buildPrRefChunk,
      streams.sizer,
      streams.maxDecompressedBytes
    ) &&
    appendPaginatedChunks(
      chunks,
      streams.prs,
      streams.maxBytes,
      streams.buildPrChunk,
      streams.sizer,
      streams.maxDecompressedBytes
    )
  );
}

/**
 * FEA-4152: does `value` clear the server's decompressed-size ceiling under
 * `sizer`? For the identity encoding the wire bytes ARE the decompressed bytes
 * and the caller has already bounded them by `maxBytes` (256 KiB) — far below
 * the ceiling (4 MiB) — so the ceiling can never bind and the extra
 * `JSON.stringify` is skipped. Only the gzip path, where compressed and
 * decompressed sizes diverge, actually measures the decompressed length.
 */
export function withinDecompressedCeiling(
  value: SyncedAgentSession,
  sizer: SyncPayloadSizer,
  maxDecompressedBytes: number
): boolean {
  if (sizer.encoding === identitySyncPayloadSizer.encoding) {
    return true;
  }
  return sizer.decompressedByteLength(value) <= maxDecompressedBytes;
}

/**
 * Serialized bytes a chunk still has free once `emptyChunk` is accounted for —
 * the chunk cap minus that shape, measured against whichever budget the active
 * sizer actually packs by (raw wire bytes on the identity path, the decompressed
 * ceiling on the gzip path).
 *
 * ISS-6884 introduced it for a component-usage group's own chunk; ISS-7997 sizes
 * the metadata degrade with the same question, so it is asked in one place.
 */
export function remainingChunkByteBudget(
  emptyChunk: SyncedAgentSession,
  maxBytes: number,
  sizer: SyncPayloadSizer,
  maxDecompressedBytes: number
): number {
  if (sizer.encoding === identitySyncPayloadSizer.encoding) {
    return maxBytes - sizer.byteLength(emptyChunk);
  }
  return maxDecompressedBytes - sizer.decompressedByteLength(emptyChunk);
}

/**
 * FEA-4138/FEA-4152: greedy pack for the gzip path, where the wire cap bounds a
 * non-additive (compressed) encoding.
 *
 * The naive approach — rebuild + re-gzip the whole growing chunk after EVERY
 * candidate item — is O(N²) in both `JSON.stringify` and gzip work: a
 * highly-compressible 4 MiB session (thousands of near-identical events) would
 * re-serialize and re-compress the entire prefix on every event and time out the
 * 30 s payload worker before producing a single valid chunk (whitlockk, FEA-4152).
 *
 * Instead, pack by the ADDITIVE decompressed (raw JSON) budget — the same O(1)
 * running-byte-total the identity fast path uses, since raw length is exactly
 * base + Σ itemBytes + one separator byte per extra item — bounding each chunk by
 * the server's decompressed ceiling (`maxDecompressedBytes`). Gzip is measured
 * only ONCE per SEALED chunk (`gzipVerifyOrSplit`), and a sealed chunk that still
 * exceeds the compressed wire cap is bisected by a bounded probe, so total gzip
 * calls are O(chunks · log itemsPerChunk) rather than O(N). For the overwhelming
 * majority of sessions (JSON compresses ~5-10×) a raw-bounded chunk clears the
 * wire cap on the first gzip check and no split is needed.
 */
function appendPaginatedChunksByMeasuredSize<T>(
  chunks: SyncedAgentSession[],
  items: readonly T[],
  maxBytes: number,
  buildChunk: (slice: T[]) => SyncedAgentSession,
  sizer: SyncPayloadSizer,
  maxDecompressedBytes: number = SYNC_DECOMPRESSED_CHUNK_TARGET_BYTES,
  // ISS-4541 (P1 #2): hard per-chunk ROW ceiling, independent of bytes — see the
  // identity fast path. The activity stream sets MAX_SYNCED_ACTIVITY_SEGMENTS so
  // a gzip-fitting slice can never exceed the receiver's per-payload row cap.
  maxRowsPerChunk: number = Number.POSITIVE_INFINITY,
  // ISS-6884: see the identity fast path — wire rows contributed per item, for
  // streams (component usage) whose pagination unit is a whole group of rows.
  itemRowCount: (item: T) => number = singleRowPerItem
): boolean {
  // Empty-chunk decompressed base (metadata + agents + empty stream + the
  // chunk-marker reserve). Every sealed chunk replicates it, so it anchors the
  // additive raw byte total exactly like the identity fast path.
  const baseBytes = sizer.decompressedByteLength(buildChunk([]));

  const sealChunk = (slice: T[]): boolean =>
    gzipVerifyOrSplit(chunks, slice, maxBytes, buildChunk, sizer);

  let current: T[] = [];
  let currentBytes = baseBytes;
  let currentRows = 0;
  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item));
    const itemRows = itemRowCount(item);
    const marginalBytes = current.length > 0 ? itemBytes + 1 : itemBytes;
    // Seal when the next item would exceed the decompressed ceiling OR the
    // per-chunk row cap (P1 #2), whichever binds first.
    if (
      currentBytes + marginalBytes <= maxDecompressedBytes &&
      currentRows + itemRows <= maxRowsPerChunk
    ) {
      current.push(item);
      currentBytes += marginalBytes;
      currentRows += itemRows;
      continue;
    }
    if (current.length === 0) {
      // A single item overflows the decompressed ceiling on its own — no valid
      // chunk can hold it, so dead-letter.
      return false;
    }
    if (!sealChunk(current)) {
      return false;
    }
    current = [item];
    currentBytes = baseBytes + itemBytes;
    currentRows = itemRows;
    if (currentBytes > maxDecompressedBytes || currentRows > maxRowsPerChunk) {
      return false;
    }
  }
  if (current.length > 0) {
    return sealChunk(current);
  }
  return true;
}

/**
 * FEA-4152: seal one raw-budget-bounded slice into `chunks`, verifying its gzip
 * size against the compressed wire cap exactly ONCE. When the sealed slice still
 * exceeds `maxBytes` compressed (incompressible items), bisect it with a bounded
 * probe — split in half and recurse — so a rare over-cap chunk costs
 * O(log itemCount) gzip checks, never O(itemCount). Returns false (dead-letter)
 * if a single item's own chunk exceeds the wire cap, or if the chunk budget
 * (`MAX_SESSION_SYNC_CHUNKS`) is exhausted.
 */
function gzipVerifyOrSplit<T>(
  chunks: SyncedAgentSession[],
  slice: T[],
  maxBytes: number,
  buildChunk: (chunkSlice: T[]) => SyncedAgentSession,
  sizer: SyncPayloadSizer
): boolean {
  if (chunks.length + 1 > MAX_SESSION_SYNC_CHUNKS) {
    return false;
  }
  const built = buildChunk(slice);
  if (sizer.byteLength(built) <= maxBytes) {
    chunks.push(built);
    return true;
  }
  // Over the compressed cap. A single item that can't fit alone is unsplittable
  // → dead-letter.
  if (slice.length <= 1) {
    return false;
  }
  const mid = Math.ceil(slice.length / 2);
  return (
    gzipVerifyOrSplit(
      chunks,
      slice.slice(0, mid),
      maxBytes,
      buildChunk,
      sizer
    ) &&
    gzipVerifyOrSplit(chunks, slice.slice(mid), maxBytes, buildChunk, sizer)
  );
}

/** Default pagination weight: one wire row per paginated item. */
function singleRowPerItem(): number {
  return 1;
}
