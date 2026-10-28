/**
 * @file db-host-reply-rejection-reason.ts
 * @description ISS-8115 — the bounded `dbHostReplyRejected.op` vocabulary and
 * the diagnostics validator built from it.
 *
 * Its own module rather than another block in `schema.ts`, for the same reason
 * `db-host-telemetry-refusal-reason.ts` is: `schema.ts` owns the whole desktop
 * wire contract and sits near the file-size ceiling, so the family is declared
 * here and spent in four lines there.
 */

import { z } from "zod";

/**
 * Which db-host reply main refused at the IPC boundary.
 *
 * The op path is the actionable dimension: it names WHICH cross-process contract
 * the peer answered in a shape this build cannot read, which is what tells an
 * operator whether they are looking at a version-skewed child, a partially
 * written reply, or a field that changed type. Bounded by construction — only
 * the ops that carry a boundary schema can reach this reporter — and
 * content-free: an op path is a compile-time constant, never a session id, a
 * row, or any part of the rejected value.
 *
 * The desktop mirror is `DbHostRejectedReplyOp` in
 * `apps/desktop/src/main/telemetry/telemetry-protocol.ts`, declared there with no
 * shared import from this package (desktop deliberately does not depend on
 * `@repo/observability`). A value only the producer knows about is rejected by
 * `desktopTelemetryEventSchema`, which drops the WHOLE event as
 * `telemetry.validation_failed` — so a newly covered op MUST be added to both
 * halves in the same change.
 */
export const DbHostRejectedReplyOp = {
  /**
   * `syncSource.findExistingSessionIds` — the ONLY sanctioned proof that a
   * queued session is gone. A reply this build cannot read must never be read as
   * "no rows exist"; see the desktop mirror for what that cost.
   */
  FindExistingSessionIds: "sync_source.find_existing_session_ids",
  /** `syncSource.loadSyncState` — the durable upload cursor for one source key. */
  LoadSyncState: "sync_source.load_sync_state",
  /** `syncSource.loadPendingSessionOutboxEngineState` — the persisted retry budget. */
  LoadPendingSessionOutboxEngineState:
    "sync_source.load_pending_outbox_retry_state",
  LoadPendingOutboxRetryState: "sync_source.load_pending_outbox_retry_state",
  /**
   * ISS-8135 — `syncSource.loadPendingOutboxIds`, the once-per-identity resume
   * read that re-selects the enqueued-but-not-acked prefix. An unreadable reply
   * must never be read as "nothing is owed"; see the desktop mirror.
   */
  LoadPendingOutboxIds: "sync_source.load_pending_outbox_ids",
  /**
   * ISS-8135 — `syncSource.reEnqueueRecoveredDeadLetter`, the confirmation the
   * dead-letter cap gates on before dropping its last in-memory reference to a
   * session.
   */
  ReEnqueueRecoveredDeadLetter: "sync_source.re_enqueue_recovered_dead_letter",
  /**
   * ISS-8135 — `syncSource.findLocallyOversizedSessions`, the only input to the
   * pre-send oversize drop.
   */
  FindLocallyOversizedSessions: "sync_source.find_locally_oversized_sessions",
} as const;

export type DbHostRejectedReplyOp =
  (typeof DbHostRejectedReplyOp)[keyof typeof DbHostRejectedReplyOp];

/**
 * The `diagnostics.dbHostReplyRejected` validator.
 *
 * `.strip()` keeps this family content-free in practice rather than by
 * convention: a producer that attached the rejected reply "to help debugging"
 * has those fields dropped here instead of shipped off the machine. The whole
 * premise of the rejection is that the value could not be trusted.
 */
export const dbHostReplyRejectedDiagnosticsSchema = z
  .object({ op: z.enum(Object.values(DbHostRejectedReplyOp)) })
  .strip()
  .optional();
