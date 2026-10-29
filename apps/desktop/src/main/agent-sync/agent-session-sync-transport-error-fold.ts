/**
 * @file agent-session-sync-transport-error-fold.ts
 * @description FEA-3364: the fold for a THROWN `sendBatch` or payload prep
 * (dropped connection / local serialization failure / any other local throw) —
 * the one failure class that never produces an ack, so it cannot ride the
 * ack-reason fold in {@link file://./agent-session-sync-ack-fold.ts}.
 *
 * Hoisted out of `agent-session-sync-service.ts` (a shrink-only grandfathered
 * hotspot — root AGENTS.md) alongside its ack-fold sibling, and built the same
 * way: pure over an injected collaborator, owning no state, so the service keeps
 * ownership of its counters/queues/chunks and this module stays trivially
 * testable.
 *
 * The classification it encodes, first match wins:
 *
 * - ISS-10602: an `AgentSessionSyncTransportError` means no HTTP answer
 *   arrived (the client typed it). It is LANE-WIDE, per ISS-9793's ruling on the
 *   transcript lane's status-less throws: it defers every id on the lane gate
 *   with budgets intact and ends only on that gate's 24h ceiling
 *   (`main/sync/AGENTS.md` invariants 4 and 5), like `transport_unavailable`.
 * - A LOCAL serialization/prep failure is a deterministic local bug — the
 *   identical payload re-throws on every retry — so it is dead-lettered
 *   IMMEDIATELY and marked non-recoverable (terminal within the process, retried
 *   only by a cold-restart re-backfill, like `validation_failed`).
 * - Any other throw (a prep worker timeout, an encoder error without the
 *   serialization signature) is the row's and gets a bounded per-session budget
 *   (`MAX_CONSECUTIVE_TRANSPORT_ERRORS`); on the threshold it is dead-lettered
 *   and marked recoverable, so the FEA-3363 retry-after path re-enqueues it.
 *
 * Either dead-letter emits a critical (`error`-level) log so a stranded batch is
 * always visible. The batch is left queued (for a retry) until it is actually
 * dead-lettered, at which point its ids are dequeued and the cursor persisted.
 */

import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import type { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { errorMessage } from "../diagnostics/component-sync-diagnostics.js";
import type { LaneEnvironmentalDeferState } from "../sync/lane-environmental-defer.js";
import { describeLaneDefer } from "./agent-session-sync-rejection-dispatch.js";
import {
  AgentSessionSyncTransportError,
  formatBytes,
  isLocalSerializationError,
} from "./agent-session-sync-service-helpers.js";

export type TransportErrorFoldConfig = {
  syncMode: AgentSessionSyncMode;
  ids: string[];
  payloadBytes: number;
  error: unknown;
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
  /** ISS-5088: refund/suppress the client-abort budget on connectivity loss. */
  noteTransportLoss: (cause: string) => void;
  /** ISS-10602: the lane gate a transport throw defers every id on. */
  deferLaneEnvironmental: (
    ids: readonly string[],
    reason: SyncReason
  ) => LaneEnvironmentalDeferState;
  logInfo: (message: string) => void;
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
  const { syncMode, ids, payloadBytes, error, maxConsecutive } = config;
  if (error instanceof AgentSessionSyncTransportError) {
    deferLaneOnTransportThrow(config, deps);
    return false;
  }
  const isSerialization = isLocalSerializationError(error);
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

function deferLaneOnTransportThrow(
  config: TransportErrorFoldConfig,
  deps: TransportErrorFoldDeps
): void {
  // ISS-5088: a dropped connection is the signal that arrives FIRST and most
  // often in a network blackout. Record it as the same unambiguous connectivity
  // loss the `transport_unavailable` ack and a readiness drop record, so a
  // blackout can never quietly spend a healthy session's abort budget. Only the
  // typed throw carries that signal; an untyped one is the row's (ISS-10602).
  deps.noteTransportLoss("thrown transport error");
  const deferred = deps.deferLaneEnvironmental(
    config.ids,
    SyncReason.TransportError
  );
  deps.logInfo(
    `agent-session batch (${config.syncMode}, ~${formatBytes(config.payloadBytes)}) threw a transport error ` +
      `(${errorMessage(config.error)}); ${describeLaneDefer(config.ids.length, deferred)}`
  );
}
