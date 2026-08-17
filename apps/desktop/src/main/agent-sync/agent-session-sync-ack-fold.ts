/**
 * @file agent-session-sync-ack-fold.ts
 * @description FEA-4375: the shared bounded-retry-then-dead-letter fold for the
 * per-session ack-reason classes that share the identical shape
 * (`validation_failed`, `ack_timeout`, `ingestion_failed`). Hoisted out of
 * `agent-session-sync-service.ts` (a shrink-only grandfathered hotspot — root
 * AGENTS.md) so the three near-identical inline folds become one call each and
 * the fold shape cannot drift between reasons.
 *
 * Pure over an injected collaborator (`BoundedFailureFoldDeps`): it owns no
 * state, so the service keeps ownership of its counters/queues/outbox and this
 * module stays trivially testable.
 */

import type { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";

export type BoundedFailureFoldConfig = {
  ids: string[];
  syncMode: AgentSessionSyncMode;
  payloadBytes: number;
  /** The per-session consecutive-failure counter for this reason class. */
  counter: Map<string, number>;
  maxConsecutive: number;
  reason: string;
  /** Whether the dead-letter is live-recoverable (transient) vs terminal. */
  recoverable: boolean;
  /** Deferred-retry backoff; `null` re-attempts next tick (ack_timeout). */
  backoffMs: number | null;
  /** Whether a deferred retry is durably recorded in the outbox (ingestion). */
  recordOutboxOnDefer: boolean;
  /**
   * Whether a failure counts against the per-session budget. Default `true`.
   * `false` for `transport_unavailable` (no compute target): defer with backoff
   * but NEVER increment or dead-letter — a missing target is not a payload
   * problem, so a run of offline/hello-pending ticks must not burn a good
   * session's budget. With `false` the counter is never written and no id ever
   * dead-letters; every id defers.
   */
  countsToward?: boolean;
  /** Human label for the deferred-info log when it differs from `reason`. */
  deferLabel?: string;
};

/**
 * The service methods/state the fold drives. Kept narrow so the fold cannot
 * touch anything beyond dead-lettering, dequeuing, backoff, and outbox recording.
 */
export type BoundedFailureFoldDeps = {
  nextRetryAfterMs: Map<string, number>;
  clearFailureStateForId: (id: string) => void;
  markDeadLettered: (
    id: string,
    recoverable: boolean,
    reason: string,
    attemptCount?: number
  ) => void;
  dequeue: (syncMode: AgentSessionSyncMode, ids: string[]) => void;
  recordOutboxRetry: (
    id: string,
    attemptCount: number,
    nextAttemptAt: number,
    reason: string
  ) => void;
  /** Snapshot the queue/dead-letter sizes for the log lines. */
  queueSizes: () => {
    incremental: number;
    backfill: number;
    deadLettered: number;
  };
  logWarn: (message: string) => void;
  logInfo: (message: string) => void;
  formatBytes: (bytes: number) => string;
};

/** Classify one id as dead-lettered vs deferred, applying its effects. */
function foldOneId(
  id: string,
  config: BoundedFailureFoldConfig,
  deps: BoundedFailureFoldDeps,
  retryDeadline: number | null
): "deadLettered" | "deferred" {
  const {
    counter,
    maxConsecutive,
    reason,
    recoverable,
    recordOutboxOnDefer,
    countsToward = true,
  } = config;
  const count = countsToward
    ? (counter.get(id) ?? 0) + 1
    : (counter.get(id) ?? 0);
  if (countsToward && count >= maxConsecutive) {
    deps.clearFailureStateForId(id);
    // Carry the exhausted retry count only for outbox-recording classes
    // (ingestion_failed); the others default to 0.
    deps.markDeadLettered(
      id,
      recoverable,
      reason,
      recordOutboxOnDefer ? count : 0
    );
    return "deadLettered";
  }
  if (countsToward) {
    counter.set(id, count);
  }
  if (retryDeadline !== null) {
    deps.nextRetryAfterMs.set(id, retryDeadline);
    if (recordOutboxOnDefer) {
      deps.recordOutboxRetry(id, count, retryDeadline, reason);
    }
  }
  return "deferred";
}

/**
 * Increment each id's counter; at the class MAX dead-letter it (clearing every
 * counter so no Map entry is orphaned); otherwise defer it for a bounded retry.
 * Returns nothing — all effects run through `deps`.
 */
export function applyBoundedFailureFold(
  config: BoundedFailureFoldConfig,
  deps: BoundedFailureFoldDeps
): void {
  const { ids, syncMode, payloadBytes, backoffMs } = config;
  const deadLettered: string[] = [];
  const deferred: string[] = [];
  const retryDeadline = backoffMs === null ? null : Date.now() + backoffMs;
  for (const id of ids) {
    const outcome = foldOneId(id, config, deps, retryDeadline);
    (outcome === "deadLettered" ? deadLettered : deferred).push(id);
  }
  const bytes = deps.formatBytes(payloadBytes);
  if (deadLettered.length > 0) {
    deps.dequeue(syncMode, deadLettered);
    const sizes = deps.queueSizes();
    deps.logWarn(
      `dead-lettered ${deadLettered.length} agent session(s) after ${config.maxConsecutive} consecutive ${config.reason} rejections ` +
        `(payload ~${bytes}); ids: ${deadLettered.join(", ")}; ` +
        `remaining incremental=${sizes.incremental} backfill=${sizes.backfill} deadLettered=${sizes.deadLettered}`
    );
  }
  if (deferred.length > 0) {
    deps.logInfo(buildDeferLog(config, deferred, bytes));
  }
}

/** Compose the deferred-info log line for a fold's deferred ids. */
function buildDeferLog(
  config: BoundedFailureFoldConfig,
  deferred: string[],
  bytes: string
): string {
  const {
    counter,
    maxConsecutive,
    reason,
    backoffMs,
    syncMode,
    countsToward = true,
    deferLabel = reason,
  } = config;
  const attempt = counter.get(deferred[0]) ?? 0;
  const backoffSuffix =
    backoffMs === null ? "" : ` for ${Math.round(backoffMs / 1000)}s`;
  const attemptSuffix = countsToward
    ? ` (attempt ${attempt}/${maxConsecutive})`
    : "";
  return (
    `agent-session batch (${syncMode}, ~${bytes}) ${deferLabel}; ` +
    `deferring ${deferred.length} session(s)${backoffSuffix}${attemptSuffix}; batch left queued for retry`
  );
}
