import {
  AgentSessionSyncMode,
  MAX_SYNCED_ACTIVITY_SEGMENTS,
} from "@repo/api/src/types/agent-session";
import { SYNC_DECOMPRESSED_CHUNK_TARGET_BYTES } from "@repo/api/src/types/agent-session-sync-limits";
import { compactMetadataForPreview } from "@repo/lib/agent-sessions/metadata-preview";
import {
  identitySyncPayloadSizer,
  type SyncPayloadSizer,
} from "./agent-session-sync-compression.js";
import type {
  AgentSessionSyncBatch,
  SyncedAgentSession,
  SyncedAgentSessionChunkMeta,
} from "./agent-session-sync-contract.js";
import { AGENT_SESSION_SYNC_SCHEMA_VERSION } from "./agent-session-sync-contract.js";

export type PreparedAgentSessionPayload =
  | {
      kind: "session";
      session: SyncedAgentSession;
      payloadBytes: number;
    }
  | {
      kind: "chunked";
      sessionId: string;
      firstChunk: SyncedAgentSession;
      remainingChunks: SyncedAgentSession[];
      payloadBytes: number;
      firstChunkBytes: number;
      chunkCount: number;
    }
  | {
      kind: "dead-letter";
      sessionId: string;
      payloadBytes: number;
    };

export type AgentSessionPayloadPreparer = {
  (
    sessions: SyncedAgentSession[],
    maxBytes: number,
    // FEA-4138: when true, size the cap/chunk decision against gzip-compressed
    // wire bytes (the server negotiated decompression). Optional + additive:
    // omitted/false keeps the legacy raw-JSON sizing + chunker path.
    compress?: boolean,
    // ISS-4541: when true, paginate an oversized session's activity-segment
    // tiling ACROSS chunks (each chunk a disjoint slice) instead of replicating
    // the whole tiling into every chunk's base. Set only after the server
    // advertised `agentSessionSyncActivityChunking` (it then merges the parts
    // additively). Optional + additive: omitted/false keeps the tiling in the
    // base — which either fits or dead-letters the whole session for a
    // larger-payload retry, and is never silently truncated.
    activityChunkingSupported?: boolean
  ): Promise<PreparedAgentSessionPayload[]>;
  dispose?: () => void | Promise<void>;
};

export function estimateSessionPayloadBytes(
  session: SyncedAgentSession,
  sizer: SyncPayloadSizer = identitySyncPayloadSizer
): number {
  return sizer.byteLength(session);
}

export function estimateAgentSessionSyncBatchBytes(
  batch: AgentSessionSyncBatch,
  sizer: SyncPayloadSizer = identitySyncPayloadSizer
): number {
  return sizer.byteLength(batch);
}

export function maxSessionPayloadBytesForBatch(maxBatchBytes: number): number {
  return Math.max(0, maxBatchBytes - AGENT_SESSION_SYNC_BATCH_ENVELOPE_BYTES);
}

/**
 * Prepare one sync candidate using the same payload semantics as the transport
 * path: strip transcript-sized event content, enforce the byte cap, and split
 * oversized event arrays into chunks when metadata can still fit.
 */
export function prepareAgentSessionPayload(
  session: SyncedAgentSession,
  maxBytes: number,
  sizer: SyncPayloadSizer = identitySyncPayloadSizer,
  // FEA-4152: the decompressed-size target this producer chunks to. A gzip
  // payload can fit the compressed wire cap yet decompress past the server's
  // ceiling, which the route rejects (`Invalid compressed body` →
  // `validation_failed`) → dead-letter. Bounding it here forces such a payload
  // to chunk further instead of shipping whole. For the identity path the target
  // (4 MiB) is far above `maxBytes` (256 KiB), so it never binds and the legacy
  // path is unchanged.
  //
  // ISS-5992: this is the PRODUCER target and is deliberately lower than the
  // server's `SYNC_DECOMPRESSED_BYTE_CEILING` (16 MiB) rather than equal to it.
  // The two halves deploy independently, and only this direction is safe — a
  // producer that targeted the raised ceiling before the server was deployed
  // would ship payloads the old server rejects and dead-letters.
  maxDecompressedBytes: number = SYNC_DECOMPRESSED_CHUNK_TARGET_BYTES,
  // ISS-4541: paginate the activity-segment tiling across chunks (server merges
  // the parts additively). Optional + additive; omitted keeps the tiling in the
  // base payload (old behavior).
  activityChunkingSupported = false
): PreparedAgentSessionPayload {
  const sanitized = sanitizeSessionForSync(session);
  const payloadBytes = estimateSessionPayloadBytes(sanitized, sizer);
  if (
    payloadBytes <= maxBytes &&
    withinDecompressedCeiling(sanitized, sizer, maxDecompressedBytes)
  ) {
    return { kind: "session", session: sanitized, payloadBytes };
  }

  const chunks = chunkOversizedSession(
    sanitized,
    maxBytes,
    sizer,
    maxDecompressedBytes,
    activityChunkingSupported
  );
  if (chunks.length > 0) {
    return chunkedResult(sanitized, chunks, payloadBytes, sizer);
  }

  // ISS-4578 (P1 #1) — BOUNDED FALLBACK against an OLD server. When the server
  // cannot merge a multi-part tiling (`activityChunkingSupported === false`) the
  // tiling rides the base whole; a large tiling can push that base past the cap,
  // which above returns [] and would DEAD-LETTER the WHOLE session — discarding
  // events, agents, metadata and tokenEvents that sync fine, just because the
  // tiling is oversized. Instead DEGRADE to the best safe partial: re-chunk with
  // the tiling STRIPPED so the rest of the session reaches the cloud now. Omitting
  // `activitySegmentRows` is a cloud no-op (never clears a previously stored
  // tiling — see persistSessionActivitySegments), and the tiling is not silently
  // lost: it resyncs unchunked once it fits, or in full once the server advertises
  // `agentSessionSyncActivityChunking` (the classifier-backfill / data-revision
  // re-derivation re-marks the session dirty). Only when even the tiling-stripped
  // session can't fit is the whole session genuinely unchunkable → dead-letter.
  const hasTiling = (sanitized.activitySegmentRows?.length ?? 0) > 0;
  if (!activityChunkingSupported && hasTiling) {
    // OMIT the key entirely (not `[]`): an absent `activitySegmentRows` is the
    // cloud's "leave the stored tiling untouched" no-op signal, and it keeps the
    // wire payload minimal (no empty array shipped).
    const withoutTiling = sessionWithoutTiling(sanitized);
    const withoutTilingBytes = estimateSessionPayloadBytes(
      withoutTiling,
      sizer
    );
    if (
      withoutTilingBytes <= maxBytes &&
      withinDecompressedCeiling(withoutTiling, sizer, maxDecompressedBytes)
    ) {
      return {
        kind: "session",
        session: withoutTiling,
        payloadBytes: withoutTilingBytes,
      };
    }
    const fallbackChunks = chunkOversizedSession(
      withoutTiling,
      maxBytes,
      sizer,
      maxDecompressedBytes,
      // Still false — the tiling is already stripped, so there is nothing to
      // paginate; this just chunks events/tokenEvents as usual.
      false
    );
    if (fallbackChunks.length > 0) {
      return chunkedResult(withoutTiling, fallbackChunks, payloadBytes, sizer);
    }
  }

  return {
    kind: "dead-letter",
    sessionId: sanitized.externalSessionId,
    payloadBytes,
  };
}

/** Shape a non-empty chunk list into the `chunked` prepared result. */
function chunkedResult(
  session: SyncedAgentSession,
  chunks: SyncedAgentSession[],
  payloadBytes: number,
  sizer: SyncPayloadSizer
): PreparedAgentSessionPayload {
  const [firstChunk, ...remainingChunks] = chunks;
  return {
    kind: "chunked",
    sessionId: session.externalSessionId,
    firstChunk,
    remainingChunks,
    payloadBytes,
    firstChunkBytes: estimateSessionPayloadBytes(firstChunk, sizer),
    chunkCount: chunks.length,
  };
}

/**
 * Reduce a session to the fields the cloud persists before sync. FEA-2718
 * dropped conversation turn text (`summary`/`data`) from the cloud lane: each
 * synced event is rebuilt from the retained columnar metadata only, so the
 * desktop never ships turn/tool text over the wire (the cloud transcript archive
 * — FEA-2717 — is the sole source of turn/tool detail). The desktop-local trace
 * still reads `summary`/`data` from its own SQLite, so only the sync copy is
 * slimmed.
 */
export function sanitizeSessionForSync(
  session: SyncedAgentSession
): SyncedAgentSession {
  return {
    ...session,
    metadata: compactSessionMetadataForSync(session.metadata),
    agents: session.agents.map((agent) => ({
      ...agent,
      task: null,
    })),
    events: session.events.map((event) => ({
      externalEventId: event.externalEventId,
      agentExternalId: event.agentExternalId,
      eventType: event.eventType,
      toolName: event.toolName,
      createdAt: event.createdAt,
    })),
  };
}

/**
 * Split an oversized session into multiple chunks, each within the byte cap.
 * Every chunk replicates the full session metadata, agents, and token usage;
 * the large per-row streams — `events`, (FEA-2730) `tokenEvents`, and
 * (ISS-4541) `activitySegmentRows` — are paginated across chunks, with each
 * chunk carrying a disjoint slice of exactly one stream and the others emptied.
 * All three streams merge idempotently cloud-side, so distributing their rows
 * across chunks is safe. When the session carries no tokenEvents (and no
 * paginated tiling), event chunks keep their original
 * `{ ...session, events: slice }` shape (no empty tokenEvents key), preserving
 * the pre-FEA-2730 chunking contract.
 *
 * ISS-4541: `activitySegmentRows` is paginated as a third stream ONLY when
 * `activityChunkingSupported` (the server advertised
 * `agentSessionSyncActivityChunking` and will merge the parts additively). When
 * NOT supported the tiling rides the base whole (`...session`) exactly as
 * before — so an oversized base still dead-letters the WHOLE session for a
 * larger-payload retry (never a silent truncation). Splitting on segment
 * BOUNDARIES (each row a `[startMs, endMs)` span with a unique startMs) keeps
 * every part a valid non-overlapping sub-tiling; the receiver's replace-on-open
 * + append-idempotent merge keys on `(agentSessionId, startMs)`, so a stale
 * partial set can never collide with a newer sequence (the chunk `{index,total}`
 * marker + the tiling's own `dataRevision`/`classifierVersion` are the
 * consistency dimensions the cloud gate uses).
 *
 * Returns [] when metadata alone exceeds the cap (or the chunk budget is
 * exhausted), because no valid chunk can be produced without changing the
 * outbound session contract.
 *
 * FEA-4152: each chunk must satisfy BOTH the compressed wire cap (`maxBytes`)
 * AND the server's decompressed-size ceiling (`maxDecompressedBytes`). Under
 * gzip a chunk can pack many rows under the compressed cap yet decompress past
 * the ceiling; bounding both keeps every emitted chunk acceptable to the route.
 */
export function chunkOversizedSession(
  session: SyncedAgentSession,
  maxBytes: number,
  sizer: SyncPayloadSizer = identitySyncPayloadSizer,
  maxDecompressedBytes: number = SYNC_DECOMPRESSED_CHUNK_TARGET_BYTES,
  activityChunkingSupported = false
): SyncedAgentSession[] {
  const tokenEvents = session.tokenEvents ?? [];
  const hasTokenEvents = tokenEvents.length > 0;
  // ISS-4541: paginate the tiling as its own stream only when the server merges
  // multi-part tilings additively; otherwise it rides the base whole.
  const activitySegmentRows = session.activitySegmentRows ?? [];
  const paginateActivitySegments =
    activityChunkingSupported && activitySegmentRows.length > 0;

  // FEA-3788: reserve the `chunk: { index, total }` marker's serialized bytes
  // DURING sizing, not after. `appendPaginatedChunks` packs each chunk right up
  // to `maxBytes`; if the marker were only stamped afterward (by
  // stampChunkMetadata) it could push a full chunk past the cap and get the
  // whole session dead-lettered by agent-session-sync-service. Every built chunk
  // (and the empty-base measurement inside appendPaginatedChunks) carries a
  // worst-case-width placeholder so the marker is fully accounted for; the final
  // stamp overwrites it with the real index/total, whose serialized form is
  // never wider than the placeholder.
  const withChunkMarkerReserve = (
    chunk: SyncedAgentSession
  ): SyncedAgentSession => ({ ...chunk, chunk: CHUNK_MARKER_SIZE_RESERVE });

  // ISS-4541: the shared per-chunk base. When the tiling is paginated it is
  // stripped from the replicated base (each chunk carries only its own slice, or
  // an empty tiling for the event/tokenEvent chunks); otherwise it stays on the
  // base whole (old behavior).
  const baseFor = (
    overrides: Partial<SyncedAgentSession>
  ): SyncedAgentSession =>
    withChunkMarkerReserve({
      ...session,
      ...(paginateActivitySegments ? { activitySegmentRows: [] } : {}),
      ...overrides,
    });

  const buildEventChunk = (
    slice: SyncedAgentSession["events"]
  ): SyncedAgentSession =>
    hasTokenEvents
      ? baseFor({ events: slice, tokenEvents: [] })
      : baseFor({ events: slice });
  const buildTokenEventChunk = (
    slice: NonNullable<SyncedAgentSession["tokenEvents"]>
  ): SyncedAgentSession => baseFor({ events: [], tokenEvents: slice });
  const buildActivitySegmentChunk = (
    slice: NonNullable<SyncedAgentSession["activitySegmentRows"]>
  ): SyncedAgentSession =>
    baseFor({ events: [], tokenEvents: [], activitySegmentRows: slice });

  const baseSession = buildEventChunk([]);
  if (
    estimateSessionPayloadBytes(baseSession, sizer) > maxBytes ||
    !withinDecompressedCeiling(baseSession, sizer, maxDecompressedBytes)
  ) {
    return [];
  }
  if (
    session.events.length === 0 &&
    !hasTokenEvents &&
    !paginateActivitySegments
  ) {
    // ISS-5090: STAMP even the single-chunk result. `baseSession` still carries
    // the worst-case `CHUNK_MARKER_SIZE_RESERVE` placeholder that sizing
    // reserved, and since the chunk marker is now what classifies a rejection
    // (multi-part envelope vs whole row) and what gates the cloud's
    // delete-replace, shipping the placeholder verbatim would misreport a whole
    // session as part 99 of 100.
    return stampChunkMetadata([baseSession]);
  }

  const chunks: SyncedAgentSession[] = [];
  if (
    !appendPaginatedChunks(
      chunks,
      session.events,
      maxBytes,
      buildEventChunk,
      sizer,
      maxDecompressedBytes
    )
  ) {
    return [];
  }
  // ISS-4541 (P1 #3 — reserve the tiling budget FIRST): paginate the
  // activity-segment tiling BEFORE tokenEvents. The tiling is REQUIRED — it must
  // reach the cloud IN FULL or the whole session dead-letters for a larger
  // retry (a partial tiling is the exact silent data loss this ticket fixes) —
  // whereas tokenEvents are best-effort/degradable. If tokenEvents paginated
  // first they could consume the shared MAX_SESSION_SYNC_CHUNKS budget and
  // STARVE the required tiling, dead-lettering an otherwise-fine session. Taking
  // the required stream first, then letting the degradable stream take whatever
  // budget remains, is the correct priority.
  //
  // P1 #2 — bound each activity chunk at MAX_SYNCED_ACTIVITY_SEGMENTS rows, not
  // bytes alone. The cloud wire schema caps `activitySegmentRows` per payload at
  // that value, so a byte-fitting slice with MORE rows would be rejected by the
  // receiver and re-prepared identically FOREVER (an infinite loop). Capping the
  // per-chunk row count keeps every emitted chunk acceptable to the route.
  if (
    paginateActivitySegments &&
    !appendPaginatedChunks(
      chunks,
      activitySegmentRows,
      maxBytes,
      buildActivitySegmentChunk,
      sizer,
      maxDecompressedBytes,
      MAX_SYNCED_ACTIVITY_SEGMENTS
    )
  ) {
    return [];
  }
  // Token events are keep-all/append-only and idempotent cloud-side, and they
  // share the events'/tiling's MAX_SESSION_SYNC_CHUNKS budget. If they can't all
  // be paginated within what remains, DEGRADE: keep the chunks already built and
  // drop the overflow token events, rather than returning [] — which would
  // dead-letter the whole session and discard events/agents/metadata/tiling that
  // synced fine. appendPaginatedChunks appends greedily, so any token-event
  // chunks that DID fit are retained; the remainder resyncs on a later pass.
  // (Events and the required tiling overflowing the budget above still
  // dead-letter.)
  if (hasTokenEvents) {
    appendPaginatedChunks(
      chunks,
      tokenEvents,
      maxBytes,
      buildTokenEventChunk,
      sizer,
      maxDecompressedBytes
    );
  }

  return stampChunkMetadata(chunks.length > 0 ? chunks : [baseSession]);
}

/**
 * FEA-3788 (PRD-536 D3): stamp each chunk with its `{ index, total }` position so
 * the cloud can make a chunked apply repairable after a partial (half-commit)
 * sync — the events delete-replace fires only on chunk 0 of a differing
 * `dataRevision`, and the new `dataRevision` commits only on the final chunk, so
 * an interrupted sequence leaves the stored revision at its prior value and a
 * resync re-fires `shouldReplace`. A single (unchunked) result is stamped `0 of 1`
 * so the cloud path is uniform, but the identical semantics of an unstamped whole
 * session mean an older desktop build (no marker) is still handled correctly.
 *
 * Each chunk already carries the worst-case-width `CHUNK_MARKER_SIZE_RESERVE`
 * placeholder that sizing reserved (see `withChunkMarkerReserve`); this overwrites
 * it with the real `{ index, total }`, whose serialized form is never wider than
 * the reservation, so no stamped chunk can spill past `maxBytes`.
 */
function stampChunkMetadata(
  chunks: SyncedAgentSession[]
): SyncedAgentSession[] {
  const total = chunks.length;
  return chunks.map((chunk, index) => ({
    ...chunk,
    chunk: { index, total },
  }));
}

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
function appendPaginatedChunks<T>(
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
  maxRowsPerChunk: number = Number.POSITIVE_INFINITY
): boolean {
  if (sizer.encoding !== identitySyncPayloadSizer.encoding) {
    return appendPaginatedChunksByMeasuredSize(
      chunks,
      items,
      maxBytes,
      buildChunk,
      sizer,
      maxDecompressedBytes,
      maxRowsPerChunk
    );
  }
  // Identity fast path: wire bytes ARE the decompressed bytes, and `maxBytes`
  // (256 KiB) is far below `maxDecompressedBytes` (4 MiB), so a chunk that fits
  // the wire cap trivially clears the ceiling — no separate decompressed check
  // is needed and the O(1) running-byte-total stays valid.
  const baseBytes = estimateSessionPayloadBytes(buildChunk([]), sizer);

  let current: T[] = [];
  let currentBytes = baseBytes;
  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item));
    // A leading separator byte is only added once the chunk already holds an item.
    const marginalBytes = current.length > 0 ? itemBytes + 1 : itemBytes;
    // A chunk seals when the NEXT item would exceed EITHER the byte cap OR the
    // per-chunk row ceiling (P1 #2), whichever binds first.
    if (
      currentBytes + marginalBytes <= maxBytes &&
      current.length < maxRowsPerChunk
    ) {
      current.push(item);
      currentBytes += marginalBytes;
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
    if (currentBytes > maxBytes) {
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
 * FEA-4138/FEA-4152: greedy pack for the gzip path, where the wire cap bounds a
 * non-additive (compressed) encoding.
 *
 * The naive approach — rebuild + re-gzip the whole growing chunk after EVERY
 * candidate item — is O(N²) in both `JSON.stringify` and gzip work: a
 * highly-compressible 4 MiB session (thousands of near-identical events) would
 * re-serialize and re-compress the entire prefix on every event and time out the
 * 30 s payload worker before producing a single valid chunk (wongk, FEA-4152).
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
  maxRowsPerChunk: number = Number.POSITIVE_INFINITY
): boolean {
  // Empty-chunk decompressed base (metadata + agents + empty stream + the
  // chunk-marker reserve). Every sealed chunk replicates it, so it anchors the
  // additive raw byte total exactly like the identity fast path.
  const baseBytes = sizer.decompressedByteLength(buildChunk([]));

  const sealChunk = (slice: T[]): boolean =>
    gzipVerifyOrSplit(chunks, slice, maxBytes, buildChunk, sizer);

  let current: T[] = [];
  let currentBytes = baseBytes;
  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item));
    const marginalBytes = current.length > 0 ? itemBytes + 1 : itemBytes;
    // Seal when the next item would exceed the decompressed ceiling OR the
    // per-chunk row cap (P1 #2), whichever binds first.
    if (
      currentBytes + marginalBytes <= maxDecompressedBytes &&
      current.length < maxRowsPerChunk
    ) {
      current.push(item);
      currentBytes += marginalBytes;
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
    if (currentBytes > maxDecompressedBytes) {
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
  if (estimateSessionPayloadBytes(built, sizer) <= maxBytes) {
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

const MAX_SESSION_SYNC_CHUNKS = 100;

/**
 * FEA-3788: worst-case-width placeholder for the `chunk: { index, total }`
 * marker, used only to RESERVE the marker's serialized bytes while chunking
 * (see `withChunkMarkerReserve`). A real marker's `total` is at most
 * `MAX_SESSION_SYNC_CHUNKS` and its `index` is `0..total-1`, so both numbers'
 * serialized digit widths are bounded by these values — the final
 * `stampChunkMetadata` stamp is therefore never wider than what sizing reserved,
 * and a full chunk can never spill past `maxBytes` after stamping.
 */
const CHUNK_MARKER_SIZE_RESERVE: SyncedAgentSessionChunkMeta = {
  index: MAX_SESSION_SYNC_CHUNKS - 1,
  total: MAX_SESSION_SYNC_CHUNKS,
};
const AGENT_SESSION_SYNC_BATCH_ENVELOPE_BYTES = Math.max(
  agentSessionSyncBatchEnvelopeBytes(AgentSessionSyncMode.Incremental),
  agentSessionSyncBatchEnvelopeBytes(AgentSessionSyncMode.Backfill)
);

function agentSessionSyncBatchEnvelopeBytes(
  syncMode: AgentSessionSyncMode
): number {
  return estimateAgentSessionSyncBatchBytes({
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "00000000-0000-4000-8000-000000000000",
    syncMode,
    sessionCount: 999,
    sessions: [],
  });
}

/**
 * Reduce a session `metadata` blob to the bounded, content-stripped shape shipped
 * over the sync wire. FEA-3693: delegates to the ONE shared preview contract
 * (`compactMetadataForPreview` in `@repo/lib/agent-sessions/metadata-preview`)
 * that the cloud persist boundary (`sanitizeMetadataForPersist`) also calls, so
 * the desktop producer and the cloud lane emit byte-identical `metadata` for the
 * same normalized transcript — including the per-message preview floor and the
 * `textTruncation` markers. This dropped the hand-duplicated compaction that had
 * drifted from the cloud strip (desktop kept a 160-char floor after the aggregate
 * budget while the cloud dropped later `text` entirely).
 */
function compactSessionMetadataForSync(
  metadata: SyncedAgentSession["metadata"]
): SyncedAgentSession["metadata"] {
  return compactMetadataForPreview(metadata) as SyncedAgentSession["metadata"];
}

/**
 * FEA-4152: does `value` clear the server's decompressed-size ceiling under
 * `sizer`? For the identity encoding the wire bytes ARE the decompressed bytes
 * and the caller has already bounded them by `maxBytes` (256 KiB) — far below
 * the ceiling (4 MiB) — so the ceiling can never bind and the extra
 * `JSON.stringify` is skipped. Only the gzip path, where compressed and
 * decompressed sizes diverge, actually measures the decompressed length.
 */
function withinDecompressedCeiling(
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
 * ISS-4578 (P1 #1): a copy of `session` with the activity tiling OMITTED (key
 * absent, not `[]`). Used by the bounded old-server fallback so the rest of the
 * session can sync while an oversized tiling defers — an absent
 * `activitySegmentRows` is the cloud's "leave the stored tiling untouched" no-op
 * signal, so nothing already stored is cleared.
 */
function sessionWithoutTiling(session: SyncedAgentSession): SyncedAgentSession {
  const { activitySegmentRows: _omittedTiling, ...rest } = session;
  return rest;
}
