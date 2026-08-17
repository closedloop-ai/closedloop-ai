import { randomUUID } from "node:crypto";
import {
  type AgentSessionSyncMode,
  SyncPayloadEncoding,
} from "@repo/api/src/types/agent-session";
import {
  type SyncPayloadSizer,
  syncPayloadSizerFor,
} from "./agent-session-sync-compression.js";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  type AgentSessionSyncBatch,
  type SyncedAgentSession,
} from "./agent-session-sync-contract.js";
import {
  estimateAgentSessionSyncBatchBytes,
  type PreparedAgentSessionPayload,
} from "./agent-session-sync-payload.js";

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
  monitoredActivityIncluded?: boolean;
};

export type PendingChunkTransition =
  | { kind: "none" }
  | { kind: "discard-downgrade"; sessionId: string; chunkCount: number }
  | {
      kind: "send";
      sessionId: string;
      syncMode: AgentSessionSyncMode;
      batch: AgentSessionSyncBatch;
      accumulatedBytes: number;
      compress: boolean;
      remainingChunks: number;
      isLast: boolean;
    };

/**
 * Decide what a sync tick should do with the current pending-chunk tail, WITHOUT
 * mutating the caller's state. Returns:
 * - `none` — no pending chunks to drain this tick (fall through to a fresh batch).
 * - `discard-downgrade` — the pinned gzip chunks can no longer ship because the
 *   server no longer advertises decompression; the caller must clear the tail and
 *   skip sending so the session re-prepares under identity on the next tick.
 * - `send` — the next chunk (shifted off the front of the tail) is ready as a
 *   single-session batch. `isLast` marks the final chunk; the caller clears the
 *   tail when it acks. Draining shifts the tail array in place, so the caller's
 *   reference sees the shortened remainder.
 */
export function resolvePendingChunkTransition(
  pending: PendingChunks | null,
  compressionSupported: boolean,
  // ISS-4541: does the (possibly reconnected) server still merge multi-part
  // tilings additively? A tail that split the tiling across parts must be
  // discarded on downgrade to avoid a partial cloud tiling. Defaulted true so
  // existing callers/tests that don't pin an activity-chunked tail are unaffected.
  activityChunkingSupported = true,
  monitoredActivitySupported = true
): PendingChunkTransition {
  if (!pending || pending.chunks.length === 0) {
    return { kind: "none" };
  }
  if (
    (pending.compress && !compressionSupported) ||
    (pending.activityChunked && !activityChunkingSupported) ||
    (pending.monitoredActivityIncluded && !monitoredActivitySupported)
  ) {
    return {
      kind: "discard-downgrade",
      sessionId: pending.sessionId,
      chunkCount: pending.chunks.length,
    };
  }

  const { sessionId, syncMode, chunks, compress } = pending;
  const chunk = chunks.shift()!;
  const isLast = chunks.length === 0;
  const batch: AgentSessionSyncBatch = {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: randomUUID(),
    syncMode,
    sessionCount: 1,
    sessions: [chunk],
    ...(compress ? { encoding: SyncPayloadEncoding.Gzip } : {}),
    // Goal stage 2 (codex-connector review, PR #4862): request the per-row ack
    // echo on EVERY chunk, exactly as the fresh-drain `buildBatch` does. The
    // echo is REQUEST-GATED server-side (`desktop-agent-sessions-handler.ts`
    // gates on `wantsAcceptedSessionIds === true`), so omitting it here made the
    // server answer a legacy `{ synced: true }` for the whole tail — and the
    // client reads an absent echo as the legacy whole-batch ack and durably
    // clears the outbox row. That is precisely the accept-without-persist hole
    // stage 2 exists to close, and it was open on the path where the server's
    // skip is MOST reachable: `persisted: false` is returned only for
    // `isForeignChunk`, which (outside a stale revision) is a chunked-payload
    // condition. Additive in both skew directions — an old server strips the
    // flag and answers whole-batch, which is today's behaviour.
    wantsAcceptedSessionIds: true,
  };
  const accumulatedBytes = estimateAgentSessionSyncBatchBytes(
    batch,
    syncPayloadSizerFor(compress)
  );
  return {
    kind: "send",
    sessionId,
    syncMode,
    batch,
    accumulatedBytes,
    compress,
    remainingChunks: chunks.length,
    isLast,
  };
}

/**
 * Mutable accumulator + callback bundle for folding one drain tick's prepared
 * payloads into a single wire batch. Splitting this out of the service keeps the
 * grandfathered sync-service file shrinking (wongk, FEA-4152); the fold is a
 * cohesive responsibility — "assemble one <=cap batch, sequestering an oversized
 * session's chunk tail as pendingChunks" — with no dependency on service state
 * beyond what these callbacks expose.
 */
export type PreparedPayloadAccumulator = {
  sessions: SyncedAgentSession[];
  syncIds: string[];
  accumulatedBytes: number;
  pendingChunks: PendingChunks | null;
};

export type AccumulatePreparedPayloadsDeps = {
  syncMode: AgentSessionSyncMode;
  sendCompress: boolean;
  // ISS-4541: whether this drain paginated the activity-segment tiling across
  // chunks (server advertised `agentSessionSyncActivityChunking`). Pinned on any
  // sequestered chunk tail so a mid-drain capability downgrade discards it rather
  // than shipping a partial tiling to an old REPLACE-ALL server.
  activityChunked: boolean;
  monitoredActivityIncluded?: boolean;
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
      monitoredActivityIncluded: deps.monitoredActivityIncluded ?? false,
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
