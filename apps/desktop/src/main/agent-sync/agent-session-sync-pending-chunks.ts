import { randomUUID } from "node:crypto";
import type { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import type { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import {
  type SyncPayloadSizer,
  syncPayloadSizerFor,
} from "./agent-session-sync-compression.js";
import {
  type AgentSessionSyncBatch,
  buildAgentSessionSyncBatch,
  type SyncedAgentSession,
} from "./agent-session-sync-contract.js";
import { SESSION_PAYLOAD_BYTE_CAP } from "./agent-session-sync-limits.js";
import {
  estimateAgentSessionSyncBatchBytes,
  type PreparedAgentSessionPayload,
  type UnsendableComponentUnits,
} from "./agent-session-sync-payload.js";
import { formatBytes } from "./agent-session-sync-service-helpers.js";

/**
 * FEA-4138/FEA-4152: the in-flight tail of an oversized session that was split
 * into byte-bounded chunks. The chunks are drained one-per-tick; the session is
 * dequeued only after the FINAL chunk acks, so a discarded tail leaves the
 * session queued for a fresh re-prepare.
 *
 * `compress` records the encoding the chunks were SIZED for. A chunk packed to
 * the compressed cap must be sent compressed on every drain tick as long as the
 * negotiated capability still supports gzip — sending it uncompressed could
 * exceed the raw request cap. When the capability DOWNGRADES mid-drain (reconnect
 * to an older server that never negotiated gzip), the pinned gzip chunks cannot
 * be sent at all: `resolvePendingChunkTransition` discards them so the still-queued
 * session re-hydrates + re-chunks under the identity sizer on the next tick, rather
 * than posting a `Content-Encoding: gzip` body the server rejects.
 *
 * ISS-4541: `activityChunked` records whether the pinned chunks split the
 * activity-segment tiling ACROSS parts (only done when the server advertised
 * `agentSessionSyncActivityChunking`). If that capability DOWNGRADES mid-drain
 * (reconnect to an older server that REPLACE-ALLs the tiling on every chunk),
 * shipping the pinned tail would make the old server store a PARTIAL tiling —
 * the exact silent loss this ticket fixes. So the tail is discarded on that
 * downgrade too, and the still-queued session re-hydrates + re-chunks with the
 * tiling whole in the base (which then fits or dead-letters, never partial).
 * The monitored-activity carrier follows the same rule: a tail prepared for a
 * capable cloud is discarded if reconnect negotiation no longer accepts it.
 */
export type PendingChunks = {
  sessionId: string;
  syncMode: AgentSessionSyncMode;
  chunks: SyncedAgentSession[];
  compress: boolean;
  activityChunked: boolean;
  /**
   * ISS-9859: whether the pinned chunks split `prRefs` or `prs` ACROSS parts.
   * Same hazard as `activityChunked`: a marked continuation part sent to a
   * server that no longer merges it would have that server REPLACE the
   * session's PR links or `pullRequests` blob with one slice. Optional so every existing caller and fixture compiles unchanged.
   */
  prRefChunked?: boolean;
  monitoredActivityIncluded?: boolean;
  /**
   * ISS-12552: the chunks carry token-event owners. A server that no longer
   * accepts them rejects the part whole, so the tail is discarded on that
   * downgrade and the session re-prepares without them.
   */
  tokenEventOwnerIncluded?: boolean;
  /**
   * ISS-7516 (review cid 3840055932) — the data-sync level captured when this
   * tail was sequestered, pinned for the same reason `compress` is: a tail is
   * drained across LATER ticks, and every fact the wire batch needs must travel
   * with it rather than be re-derived at drain time.
   *
   * Without it the tail batches carry no level while chunk 0 carried one. That
   * is not merely a cosmetic gap during a deploy skew — the server's write is
   * omit-if-absent, so whether `session_detail.data_sync_level` ends up set
   * depends on which chunk happened to land last. Re-reading the live setting
   * per tick would be worse still: a user changing the level mid-drain would
   * stamp one session's chunks with two different answers.
   */
  dataSyncLevel?: DataSyncLevel;
  /**
   * ISS-6999 (whitlockk, cid 3846110703): the component-usage rows this session's
   * partition leaves behind, pinned for the same reason `dataSyncLevel` is —
   * a tail drains across LATER ticks, and the report is owed on the FINAL chunk,
   * by which point the prepare that measured it is long gone.
   *
   * Pinning it here is also what makes the report exactly-once. A tail discarded
   * mid-sequence never reaches its last chunk, so the tally dies with it and the
   * re-prepare that follows measures and reports its own.
   *
   */
  unsendableComponentUnits?: UnsendableComponentUnits;
};

export type PendingChunkTransition =
  | { kind: "none" }
  | { kind: "discard-downgrade"; sessionId: string; chunkCount: number }
  | {
      /**
       * ISS-8710: the next tail chunk's BUILT batch does not fit the request
       * cap, so posting it can only draw a 413. The caller drops the tail and
       * folds the part through the SAME `validation_failed` path that 413
       * produced — see {@link applyPendingChunkDiscard} for why it is not a
       * terminal oversize dead-letter.
       */
      kind: "reject-oversized";
      sessionId: string;
      syncMode: AgentSessionSyncMode;
      chunkBytes: number;
    }
  | {
      kind: "send";
      sessionId: string;
      syncMode: AgentSessionSyncMode;
      batch: AgentSessionSyncBatch;
      accumulatedBytes: number;
      compress: boolean;
      remainingChunks: number;
      isLast: boolean;
      /**
       * ISS-6999: present ONLY on the final chunk of a sequence that skipped
       * something — the drain has nothing to report until the session's last
       * bytes are the ones being acked.
       */
      unsendableComponentUnits?: UnsendableComponentUnits;
    };

/**
 * Decide what a sync tick should do with the current pending-chunk tail, WITHOUT
 * mutating the caller's state. Returns:
 * - `none` — no pending chunks to drain this tick (fall through to a fresh batch).
 * - `discard-downgrade` — the pinned gzip chunks can no longer ship because the
 *   server no longer advertises decompression; the caller must clear the tail and
 *   skip sending so the session re-prepares under identity on the next tick.
 * - `reject-oversized` — ISS-8710: the next chunk's BUILT batch exceeds
 *   `maxBatchBytes`, so the caller must clear the tail and fold the part as the
 *   `validation_failed` the route would have answered with, rather than post a
 *   request it can only reject.
 * - `send` — the next chunk (shifted off the front of the tail) is ready as a
 *   single-session batch. `isLast` marks the final chunk; the caller clears the
 *   tail when it acks. Draining shifts the tail array in place, so the caller's
 *   reference sees the shortened remainder. Only a `send` shifts; the refusal
 *   above leaves the tail intact for the caller to drop whole.
 */
export function resolvePendingChunkTransition(
  pending: PendingChunks | null,
  compressionSupported: boolean,
  // ISS-4541: does the (possibly reconnected) server still merge multi-part
  // tilings additively? A tail that split the tiling across parts must be
  // discarded on downgrade to avoid a partial cloud tiling. Defaulted true so
  // existing callers/tests that don't pin an activity-chunked tail are unaffected.
  activityChunkingSupported = true,
  monitoredActivitySupported = true,
  // ISS-7775 (review: codex P1): the machine's data-sync level RIGHT NOW.
  // `undefined` means the caller wires no level and the pinned value is not
  // re-checked, which keeps every existing caller and test unaffected.
  currentDataSyncLevel?: DataSyncLevel,
  // ISS-8710: the request cap the ROUTE judges this batch against. Defaulted to
  // the real cap so no drain lane can opt out of the check by omitting it; the
  // parameter exists so a test can drive the refusal on a small fixture instead
  // of one pinned within a handful of bytes of 256 KiB, which zlib's block
  // boundaries make fragile.
  maxBatchBytes: number = SESSION_PAYLOAD_BYTE_CAP,
  // ISS-9859: does the (possibly reconnected) server still merge a marked
  // `prRefs` part? Appended AFTER `maxBatchBytes` so existing positional callers
  // are untouched, and defaulted TRUE for the same reason `activityChunkingSupported`
  // is: a lane that does not wire the flag must not discard a tail it has no
  // reason to distrust.
  prRefChunkingSupported = true,
  tokenEventOwnerSupported = true
): PendingChunkTransition {
  if (!pending || pending.chunks.length === 0) {
    return { kind: "none" };
  }
  if (
    (pending.compress && !compressionSupported) ||
    (pending.activityChunked && !activityChunkingSupported) ||
    // ISS-9859: the tail's marked parts merge only on a server that advertised
    // the capability. Shipping them to one that did not would REPLACE the
    // session's PR links with a single slice — the exact loss this ticket
    // removes — so the tail is discarded and the session re-chunks whole.
    (pending.prRefChunked === true && !prRefChunkingSupported) ||
    (pending.monitoredActivityIncluded && !monitoredActivitySupported) ||
    (pending.tokenEventOwnerIncluded === true && !tokenEventOwnerSupported) ||
    // ISS-7775: the pinned tail's CONTENT was sanitized under the level captured
    // when it was sequestered. A tail chunked at `full` and drained after the
    // user picked Metadata would keep posting turn text under a consent card
    // that says it stays local — the tail outlives the setting change because
    // `applyDataSyncLevel` refreshes rather than cancelling an active sequence.
    //
    // Discarding is the remedy the other three already use, and it is the one
    // that keeps ISS-7516's pin intact: the still-queued session re-hydrates and
    // re-chunks WHOLE under the new level, so its chunks still carry one answer
    // between them rather than the two a per-tick re-read would stamp.
    (currentDataSyncLevel !== undefined &&
      pending.dataSyncLevel !== undefined &&
      pending.dataSyncLevel !== currentDataSyncLevel)
  ) {
    return {
      kind: "discard-downgrade",
      sessionId: pending.sessionId,
      chunkCount: pending.chunks.length,
    };
  }

  const {
    sessionId,
    syncMode,
    chunks,
    compress,
    dataSyncLevel,
    unsendableComponentUnits,
  } = pending;
  const batch = buildAgentSessionSyncBatch({
    batchId: randomUUID(),
    syncMode,
    sessions: [chunks[0]!],
    compress,
    dataSyncLevel,
  });
  // ISS-8710: measure the BUILT batch with the encoding this tail was packed
  // for, which is the quantity the route judges — `gzip(batch)` under gzip,
  // raw JSON bytes under identity. The chunker packs SESSIONS against
  // `SESSION_PAYLOAD_CONTENT_BYTE_CAP`, a RAW-byte budget (the cap minus the
  // raw envelope width), and under gzip the wrapped batch is not the session
  // plus that width — `gzip(batch) - gzip(session)` is content-dependent. So
  // the budget bounds the wrong quantity on the compressed path and only the
  // built batch settles it.
  const accumulatedBytes = estimateAgentSessionSyncBatchBytes(
    batch,
    syncPayloadSizerFor(compress)
  );
  if (accumulatedBytes > maxBatchBytes) {
    // The pinned `unsendableComponentUnits` tally dies with the tail, exactly as
    // it does on every other discard: the session stays queued and the
    // re-prepare that follows measures and reports its own.
    return {
      kind: "reject-oversized",
      sessionId,
      syncMode,
      chunkBytes: accumulatedBytes,
    };
  }
  chunks.shift();
  const isLast = chunks.length === 0;
  return {
    kind: "send",
    sessionId,
    syncMode,
    batch,
    accumulatedBytes,
    compress,
    remainingChunks: chunks.length,
    isLast,
    // ISS-6999: hand the pinned tally over only when this chunk is the last one
    // the session owes. A non-final chunk has dequeued nothing, so a report on
    // it would describe a delivery that is still in flight.
    ...(isLast && unsendableComponentUnits ? { unsendableComponentUnits } : {}),
  };
}

/** A transition that clears the pinned tail without sending it. */
export type PendingChunkDiscard = Exclude<
  PendingChunkTransition,
  { kind: "none" | "send" }
>;

/**
 * Whether this tick's transition drops the tail. Written as a guard rather than
 * inlined at the call site so a THIRD non-sending kind is covered by widening
 * `PendingChunkDiscard` alone, instead of by remembering to extend a condition
 * in the grandfathered service.
 */
export function isPendingChunkDiscard(
  transition: PendingChunkTransition
): transition is PendingChunkDiscard {
  return transition.kind !== "none" && transition.kind !== "send";
}

/**
 * The wire-batch state a `send` transition hands this tick, unpacked in one
 * place. Pure destructuring of the transition, hoisted here (with
 * {@link formatChunkDrainLine}) so the grandfathered sync-service file keeps
 * shrinking — the same FEA-4152 split reason the accumulator below states.
 */
export type PendingChunkSendState = {
  sendCompress: boolean;
  batch: AgentSessionSyncBatch;
  accumulatedBytes: number;
  syncMode: AgentSessionSyncMode;
  syncIds: string[];
  /** The operator-facing line for this drained chunk. */
  logLine: string;
};

export function pendingChunkSendState(
  transition: Extract<PendingChunkTransition, { kind: "send" }>
): PendingChunkSendState {
  return {
    sendCompress: transition.compress,
    batch: transition.batch,
    accumulatedBytes: transition.accumulatedBytes,
    syncMode: transition.syncMode,
    syncIds: [transition.sessionId],
    logLine:
      `sending chunked session ${transition.sessionId} ` +
      `(~${formatBytes(transition.accumulatedBytes)}); ` +
      `${transition.remainingChunks} chunk(s) remaining`,
  };
}

/**
 * Mutable accumulator + callback bundle for folding one drain tick's prepared
 * payloads into a single wire batch. Splitting this out of the service keeps the
 * grandfathered sync-service file shrinking (whitlockk, FEA-4152); the fold is a
 * cohesive responsibility — "assemble one <=cap batch, sequestering an oversized
 * session's chunk tail as pendingChunks" — with no dependency on service state
 * beyond what these callbacks expose.
 */
export type PreparedPayloadAccumulator = {
  sessions: SyncedAgentSession[];
  syncIds: string[];
  accumulatedBytes: number;
  pendingChunks: PendingChunks | null;
  /**
   * ISS-6999: the skip owed by a chunked payload this fold took WHOLE — one that
   * needed splitting but had no remainder, so the batch carries its last bytes.
   * A payload with a remainder pins its tally on `pendingChunks` instead, and an
   * unchunked or dead-lettered one has none. At most one per batch: a chunked
   * candidate claims the whole batch.
   *
   * Reported by the caller only once the ack accepts it — see
   * `accumulateChunkedPayload`.
   */
  unsendableComponentUnits?: UnsendableComponentUnits;
};

export type AccumulatePreparedPayloadsDeps = {
  syncMode: AgentSessionSyncMode;
  sendCompress: boolean;
  // ISS-4541: whether this drain paginated the activity-segment tiling across
  // chunks (server advertised `agentSessionSyncActivityChunking`). Pinned on any
  // sequestered chunk tail so a mid-drain capability downgrade discards it rather
  // than shipping a partial tiling to an old REPLACE-ALL server.
  activityChunked: boolean;
  // ISS-9859: whether this drain paginated `prRefs` across parts (server
  // advertised `agentSessionSyncPrRefChunking`). Pinned on any sequestered tail
  // for the same reason as the tiling flag — a mid-drain downgrade must discard
  // it rather than ship a marked continuation part to a server that would
  // REPLACE the session's PR links with that one slice.
  prRefChunked?: boolean;
  monitoredActivityIncluded?: boolean;
  tokenEventOwnerIncluded?: boolean;
  /** ISS-7516: pinned onto a sequestered tail so later ticks stamp it too. */
  dataSyncLevel?: DataSyncLevel;
  sizer: SyncPayloadSizer;
  byteCap: number;
  buildBatch: (batchSessions: SyncedAgentSession[]) => AgentSessionSyncBatch;
  deadLetter: (sessionId: string, payloadBytes: number) => void;
  logChunking: (
    sessionId: string,
    payloadBytes: number,
    chunkCount: number
  ) => void;
};

/**
 * FEA-4138/FEA-4152: fold `prepared` (the isolated per-session prep results) into
 * `acc`, mirroring the previous inline drain loop exactly. A `chunked` session's
 * first chunk ships this tick and its remainder is pinned in `acc.pendingChunks`;
 * a `dead-letter` (or an over-cap chunk/session) is dead-lettered via the
 * callback. Accumulation stops once the batch already holds a session and the
 * next candidate would exceed the byte cap (the caller sends what accumulated and
 * revisits the rest next tick).
 */
export function accumulatePreparedPayloads(
  acc: PreparedPayloadAccumulator,
  prepared: PreparedAgentSessionPayload[],
  deps: AccumulatePreparedPayloadsDeps
): void {
  for (const item of prepared) {
    // Chunked/dead-letter payloads are prepared alone, so once the batch already
    // holds a session an oversized/chunked candidate is left for the next tick.
    if (item.kind !== "session" && acc.sessions.length > 0) {
      break;
    }
    if (item.kind === "dead-letter") {
      deps.deadLetter(item.sessionId, item.payloadBytes);
      continue;
    }
    const control =
      item.kind === "chunked"
        ? accumulateChunkedPayload(acc, item, deps)
        : accumulateSessionPayload(acc, item, deps);
    if (control === "break") {
      break;
    }
  }
}

type AccumulateControl = "continue" | "break";

/**
 * Ship a chunked session's first chunk and pin its remainder in
 * `acc.pendingChunks`, or dead-letter it when even the first chunk exceeds the
 * cap. Only reached when `acc.sessions` is empty (a chunked session claims the
 * whole batch), so it never breaks the fold.
 */
function accumulateChunkedPayload(
  acc: PreparedPayloadAccumulator,
  item: Extract<PreparedAgentSessionPayload, { kind: "chunked" }>,
  deps: AccumulatePreparedPayloadsDeps
): AccumulateControl {
  if (item.remainingChunks.length > 0) {
    acc.pendingChunks = {
      sessionId: item.sessionId,
      syncMode: deps.syncMode,
      chunks: item.remainingChunks,
      compress: deps.sendCompress,
      activityChunked: deps.activityChunked,
      prRefChunked: deps.prRefChunked ?? false,
      monitoredActivityIncluded: deps.monitoredActivityIncluded ?? false,
      tokenEventOwnerIncluded: deps.tokenEventOwnerIncluded ?? false,
      ...(deps.dataSyncLevel === undefined
        ? {}
        : { dataSyncLevel: deps.dataSyncLevel }),
      ...(item.unsendableComponentUnits
        ? { unsendableComponentUnits: item.unsendableComponentUnits }
        : {}),
    };
  }
  const chunkBytes = estimateAgentSessionSyncBatchBytes(
    deps.buildBatch([item.firstChunk]),
    deps.sizer
  );
  if (chunkBytes > deps.byteCap) {
    acc.pendingChunks = null;
    deps.deadLetter(item.sessionId, chunkBytes);
    return "continue";
  }
  acc.sessions.push(item.firstChunk);
  acc.syncIds.push(item.sessionId);
  acc.accumulatedBytes = chunkBytes;
  deps.logChunking(item.sessionId, item.payloadBytes, item.chunkCount);
  // ISS-6999 (whitlockk, cid 3846110703): DO NOT report here. Folding a payload into
  // the batch is in-memory only — a capability downgrade, a stale source, an
  // empty batch, or a throwing send all still sit between this line and the
  // wire, and each leaves the outbox queued for a re-prepare that would report
  // these same rows again. The tally instead rides the delivery: pinned onto the
  // tail above when this session owes more chunks, and handed to the ack below
  // when this chunk is the whole payload.
  if (item.remainingChunks.length === 0 && item.unsendableComponentUnits) {
    acc.unsendableComponentUnits = item.unsendableComponentUnits;
  }
  return "continue";
}

/**
 * Add a whole session to the batch, breaking when it no longer fits alongside
 * the already-accumulated sessions, or dead-lettering a lone session that
 * exceeds the cap by itself.
 */
function accumulateSessionPayload(
  acc: PreparedPayloadAccumulator,
  item: Extract<PreparedAgentSessionPayload, { kind: "session" }>,
  deps: AccumulatePreparedPayloadsDeps
): AccumulateControl {
  const candidateBytes = estimateAgentSessionSyncBatchBytes(
    deps.buildBatch([...acc.sessions, item.session]),
    deps.sizer
  );
  if (acc.sessions.length > 0 && candidateBytes > deps.byteCap) {
    return "break";
  }
  if (candidateBytes > deps.byteCap) {
    deps.deadLetter(item.session.externalSessionId, candidateBytes);
    return "continue";
  }
  acc.sessions.push(item.session);
  acc.syncIds.push(item.session.externalSessionId);
  acc.accumulatedBytes = candidateBytes;
  return "continue";
}
