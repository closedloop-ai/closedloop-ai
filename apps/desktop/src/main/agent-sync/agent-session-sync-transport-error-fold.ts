/**
 * @file agent-session-sync-transport-error-fold.ts
 * @description FEA-3364: the bounded-retry-then-dead-letter fold for a THROWN
 * `sendBatch` (dropped socket / local serialization failure) — the one failure
 * class that never produces an ack, so it cannot ride the ack-reason fold in
 * {@link file://./agent-session-sync-ack-fold.ts}.
 *
 * Hoisted out of `agent-session-sync-service.ts` (a shrink-only grandfathered
 * hotspot — root AGENTS.md) alongside its ack-fold sibling, and built the same
 * way: pure over an injected collaborator, owning no state, so the service keeps
 * ownership of its counters/queues/chunks and this module stays trivially
 * testable. Behaviour is unchanged from the inline version.
 *
 * The classification it encodes:
 *
 * - A LOCAL serialization/prep failure is a deterministic local bug — the
 *   identical payload re-throws on every retry — so it is dead-lettered
 *   IMMEDIATELY and marked non-recoverable (terminal within the process, retried
 *   only by a cold-restart re-backfill, like `validation_failed`).
 * - A TRANSIENT socket throw gets a bounded per-session budget
 *   (`MAX_CONSECUTIVE_TRANSPORT_ERRORS`); on the threshold it is dead-lettered
 *   and marked recoverable, so the FEA-3363 retry-after path re-enqueues it once
 *   the underlying connectivity has had time to recover.
 *
 * Either outcome emits a critical (`error`-level) log so a stranded batch is
 * always visible. The batch is left queued (for a retry) until it is actually
 * dead-lettered, at which point its ids are dequeued and the cursor persisted.
 */

import type { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { errorMessage } from "../diagnostics/component-sync-diagnostics.js";
import { formatBytes } from "./agent-session-sync-service-helpers.js";

export type TransportErrorFoldConfig = {
  syncMode: AgentSessionSyncMode;
  ids: string[];
  payloadBytes: number;
  error: unknown;
  /** Whether the throw is a deterministic LOCAL serialization/prep failure. */
  isSerialization: boolean;
  maxConsecutive: number;
};

/**
 * The service state/methods the fold drives. Kept narrow so the fold cannot
 * touch anything beyond counting, dead-lettering, dequeuing, and the chunk tail.
 */
export type TransportErrorFoldDeps = {
  /** Consecutive THROWN-transport-error count per session id. */
  transportErrorCountById: Map<string, number>;
  /**
   * Drop the per-class retry counters a dead-letter must not carry forward.
   * ISS-5090: the caller now passes the service's full `clearFailureStateForId`
   * rather than a hand-rolled subset. The narrow set this originally preserved
   * (faithfully, for a behaviour-preserving extraction) had already drifted —
   * it left the validation counters and the bisection flag behind, so a session
   * dead-lettered on the thrown-transport path carried FEA-4375 bisection state
   * into its next life and could be mis-bisected on a wholly unrelated attempt.
   * The clear is now class-agnostic, matching the sibling
   * `applyBoundedFailureFold` wiring.
   */
  clearRetryStateForId: (id: string) => void;
  markDeadLettered: (id: string, recoverable: boolean, reason: string) => void;
  /**
   * Discard any partial chunk sequence belonging to a dead-lettered session —
   * partial chunks are useless without server-side reassembly (mirrors the
   * ack-failure chunk-discard in `handleBatchAck`).
   */
  discardPendingChunksFor: (deadLetteredIds: string[]) => void;
  dequeue: (syncMode: AgentSessionSyncMode, ids: string[]) => void;
  /** Snapshot the queue/dead-letter sizes for the log line. */
  queueSizes: () => {
    incremental: number;
    backfill: number;
    deadLettered: number;
  };
  /** A dead-letter may have drained both queues with no accepted batch. */
  persistCursorIfCaughtUp: () => void;
  /** FEA-4375: dead-lettering a poison row is forward progress. */
  scheduleImmediateDrainIfReadyWorkRemains: () => void;
  logWarn: (message: string) => void;
  logError: (message: string) => void;
};

/**
 * Apply the fold. Returns whether any id was dead-lettered, so the caller can
 * pick the batch telemetry outcome (`dead_letter` vs `failure`).
 */
export function applyTransportErrorFold(
  config: TransportErrorFoldConfig,
  deps: TransportErrorFoldDeps
): boolean {
  const {
    syncMode,
    ids,
    payloadBytes,
    error,
    isSerialization,
    maxConsecutive,
  } = config;
  const deadLettered: string[] = [];
  for (const id of ids) {
    const count = (deps.transportErrorCountById.get(id) ?? 0) + 1;
    if (isSerialization || count >= maxConsecutive) {
      deadLettered.push(id);
      deps.clearRetryStateForId(id);
      deps.markDeadLettered(
        id,
        !isSerialization,
        isSerialization ? "transport_serialization" : "transport_error"
      );
    } else {
      deps.transportErrorCountById.set(id, count);
    }
  }

  const bytes = formatBytes(payloadBytes);
  if (deadLettered.length === 0) {
    const attempt = deps.transportErrorCountById.get(ids[0]) ?? 0;
    deps.logWarn(
      `agent-session batch (${syncMode}, ~${bytes}) threw a transport error ` +
        `(${errorMessage(error)}); attempt ${attempt}/${maxConsecutive}; batch left queued for retry`
    );
    return false;
  }

  deps.discardPendingChunksFor(deadLettered);
  deps.dequeue(syncMode, deadLettered);
  const sizes = deps.queueSizes();
  const cause = isSerialization
    ? "a local serialization/prep failure (deterministic local bug)"
    : `${maxConsecutive} consecutive transport errors`;
  deps.logError(
    `dead-lettered ${deadLettered.length} agent session(s) after ${cause} ` +
      `on sendBatch (${errorMessage(error)}; payload ~${bytes}); ` +
      `ids: ${deadLettered.join(", ")}; ` +
      `remaining incremental=${sizes.incremental} backfill=${sizes.backfill} deadLettered=${sizes.deadLettered}`
  );
  deps.persistCursorIfCaughtUp();
  deps.scheduleImmediateDrainIfReadyWorkRemains();
  return true;
}
