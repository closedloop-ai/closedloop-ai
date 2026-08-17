/**
 * @file agent-session-outbox-writers.ts
 * @description The durable-outbox write helpers for the agent-session sync lane,
 * extracted out of the grandfathered `agent-session-sync-service.ts` (over the
 * 1,000-line ceiling) as a cohesive, directly unit-testable sibling — the twin of
 * the in-memory `backfill-queue-feed.ts` (ISS-4546). Every helper skips when the
 * identity/source is unknown or the source has no matching outbox delegate
 * (fake/legacy sources behave exactly as before) and swallows write failures
 * into a warning — a failed durable write only loses a resume hint for this
 * process (no data loss; the next cold start re-derives and the server dedupes).
 * All are fire-and-forget EXCEPT `clearOutboxOnAck`, which goal stage 2 made an
 * awaited, success-reporting write — see its doc for why the ack clear is the
 * one durable write the caller must sequence on.
 *
 * The service resolves `sourceKey` (its `hydratedSourceKey ?? resolveSyncSourceKey()`)
 * and `source` (its `options.getSource()`) once per call and threads them in, so
 * these stay pure functions with no reach back into the service.
 *
 * No `void` operator on the fire-and-forget writes: `noVoid` is enforced for this
 * module (it is not in the sync service's `noVoid: off` override), and the trailing
 * `.catch` already discards the settled value.
 */
import { gatewayLog } from "../logging/gateway-logger.js";
// The canonical closed sync-class union lives in the lightweight contract module
// so the writer, the service, and the tests never re-declare the
// `"backfill" | "incremental"` literal (PR #4098 review, shafty023).
import type { AgentSessionSyncClass } from "./agent-session-sync-contract.js";
// Type-only import back into the (grandfathered) service that owns these two
// contract types. Erased at runtime, so this creates no value-level import cycle
// even though the service imports this module's writer functions.
import type {
  AgentSessionOutboxEntry,
  AgentSessionSyncSource,
} from "./agent-session-sync-source.js";

/** Log scope for the outbox write helpers (mirrors the sync service's `TAG`). */
const TAG = "agent-session-sync";

type OutboxWriteTarget = {
  /** The identity the outbox rows are scoped under, or `null` when unknown (offline/legacy). */
  sourceKey: string | null;
  /** The sync source (its outbox delegates), or `null` for a source without one. */
  source: AgentSessionSyncSource | null;
};

function warnOutboxWriteFailure(message: string, error: unknown): void {
  gatewayLog.warn(
    TAG,
    `${message}: ${error instanceof Error ? error.message : String(error)}`
  );
}

/**
 * FEA-3473: append `pending` outbox rows for newly-enqueued ids. Fire-and-forget
 * — a failed write only means the next cold start re-enumerates (no data loss,
 * server dedupes). Skipped when the identity/source is unknown or the source has
 * no outbox delegate (fake/legacy sources behave exactly as before).
 */
export function recordOutboxEnqueue(
  target: OutboxWriteTarget,
  ids: string[],
  syncClass: AgentSessionSyncClass
): void {
  if (ids.length === 0) {
    return;
  }
  const { sourceKey, source } = target;
  if (!(sourceKey && source?.enqueueOutboxEntries)) {
    return;
  }
  const entries: AgentSessionOutboxEntry[] = ids.map((externalSessionId) => ({
    externalSessionId,
    syncClass,
  }));
  Promise.resolve(source.enqueueOutboxEntries(sourceKey, entries)).catch(
    (error) => {
      warnOutboxWriteFailure(
        `failed to record ${entries.length} outbox enqueue(s)`,
        error
      );
    }
  );
}

/**
 * FEA-3473: clear the durable outbox rows for ids that just received a VERIFIED
 * server ack. This is the per-item durable progress — advanced ONLY on ack, never
 * on send (mirrors `TranscriptSyncState`).
 *
 * Goal stage 2 (atomic row-level ack): NOT fire-and-forget, unlike every other
 * writer in this module. The caller AWAITS this and treats the durable clear as
 * the ack processing itself — in-memory dequeue and cursor persistence happen
 * only after the delete committed, so a kill between ack-receipt and clear can
 * no longer exist as separate steps. The underlying `sqliteClearOutboxEntries`
 * is a single `deleteMany` statement, so the N-row clear is one transaction.
 *
 * Returns `true` when the durable delete committed OR there was nothing durable
 * to clear (no ids, unknown identity, a fake/legacy source without an outbox
 * delegate — those sources have no rows to strand, so ack processing proceeds
 * in-memory exactly as before). Returns `false` on a failed write (warn-logged):
 * the caller must then leave the acked rows queued so the next pass re-sends
 * them (bounded — the server dedupes an already-applied payload) and re-attempts
 * the clear on the re-ack, instead of dequeuing in memory while the durable
 * ledger still says `pending` (the "acked work re-sends on every launch" bug).
 */
export async function clearOutboxOnAck(
  target: OutboxWriteTarget,
  ids: string[]
): Promise<boolean> {
  if (ids.length === 0) {
    return true;
  }
  const { sourceKey, source } = target;
  if (!(sourceKey && source?.clearOutboxEntries)) {
    return true;
  }
  try {
    await source.clearOutboxEntries(sourceKey, ids);
    return true;
  } catch (error) {
    warnOutboxWriteFailure(
      `failed to clear ${ids.length} acked outbox row(s)`,
      error
    );
    return false;
  }
}

/**
 * FEA-3473: durably mark an intentionally-abandoned session `dead_lettered` in the
 * outbox with a recorded `reason`. Every in-memory dead-letter funnels through
 * `markDeadLettered`, which calls this, so a stuck item is always recorded (never
 * silently dropped) and can never block cursor persistence.
 *
 * FEA-3659: propagate the exhausted `attemptCount` so the outbox row records the
 * real number of retries a transient failure burned before dead-lettering,
 * instead of a misleading 0. Deterministic classes dead-letter at attempt 0.
 */
export function recordOutboxDeadLetter(
  target: OutboxWriteTarget,
  id: string,
  reason: string,
  attemptCount = 0
): void {
  const { sourceKey, source } = target;
  if (!(sourceKey && source?.markOutboxDeadLettered)) {
    return;
  }
  Promise.resolve(
    source.markOutboxDeadLettered(sourceKey, id, reason, attemptCount)
  ).catch((error) => {
    warnOutboxWriteFailure(
      `failed to mark outbox row ${id} dead-lettered`,
      error
    );
  });
}

/**
 * FEA-3697: durably flip a RECOVERED dead-letter's outbox row back to `pending` so
 * a restart's `loadPendingOutboxIds` re-discovers it. Called from every site that
 * DELETES an id from the in-memory `deadLetteredIds` set and pushes it back onto a
 * live queue, so the durable outbox can never be left `dead_lettered` for a row
 * that is once again queued for send. Fire-and-forget: a failed write only loses
 * the durable re-pending hint for this process; the cursor's `deadLetteredIds`
 * array still records the id, so the next restart sets it aside and the idle-cycle
 * revisit re-drives it (no data loss, server dedupes any re-send).
 */
export function recordOutboxReEnqueue(
  target: OutboxWriteTarget,
  id: string
): void {
  const { sourceKey, source } = target;
  if (!(sourceKey && source?.reEnqueueRecoveredDeadLetter)) {
    return;
  }
  Promise.resolve(source.reEnqueueRecoveredDeadLetter(sourceKey, id)).catch(
    (error) => {
      warnOutboxWriteFailure(
        `failed to re-enqueue recovered outbox row ${id}`,
        error
      );
    }
  );
}

/**
 * FEA-3659: durably record a transient retry-with-backoff on an outbox row so the
 * persisted `attempt_count` / `next_attempt_at` reflect the in-memory per-session
 * retry budget. Fire-and-forget, mirroring `recordOutboxDeadLetter`: a failed
 * write only loses the durable backoff hint, never blocks the sync.
 */
export function recordOutboxRetry(
  target: OutboxWriteTarget,
  id: string,
  attemptCount: number,
  nextAttemptAtMs: number,
  reason: string
): void {
  const { sourceKey, source } = target;
  if (!(sourceKey && source?.recordOutboxRetry)) {
    return;
  }
  Promise.resolve(
    source.recordOutboxRetry(
      sourceKey,
      id,
      attemptCount,
      new Date(nextAttemptAtMs).toISOString(),
      reason
    )
  ).catch((error) => {
    warnOutboxWriteFailure(
      `failed to record outbox retry for row ${id}`,
      error
    );
  });
}
