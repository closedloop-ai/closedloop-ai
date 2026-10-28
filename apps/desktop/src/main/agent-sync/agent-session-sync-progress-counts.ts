import type { AgentSessionSyncProgress } from "./agent-session-sync-service-options.js";

/**
 * FEA-1461: up to `limit` session ids from `queue`, skipping any whose
 * deferred-retry deadline is still in the future. Order is preserved for the
 * selected ids so the queue stays stable — backed-off entries are skipped, not
 * reordered.
 */
export function pickReadyCandidates(
  input: ReadyQueueInput & { limit: number }
): string[] {
  const result: string[] = [];
  for (const id of input.queue) {
    if (isDeferred(input, id)) {
      continue;
    }
    result.push(id);
    if (result.length >= input.limit) {
      break;
    }
  }
  return result;
}

/**
 * ISS-7099: how many queued sessions the lane could send RIGHT NOW.
 *
 * The same predicate as {@link pickReadyCandidates} without a limit, so the
 * number a progress surface divides by and the set the drain actually picks
 * cannot disagree. It is the in-memory twin of the burn-down's `readyPending`
 * (`next_attempt_at IS NULL OR next_attempt_at <= now`).
 *
 * ONE predicate covers every deferral class because they all park their ids
 * behind `nextRetryAfterMs`: the bounded ack folds, `deferLaneEnvironmental`
 * (ISS-8610 — `unauthenticated` / `target_not_owned` / `transport_unavailable`),
 * the lane-stall fold (`rate_limited` / `ack_timeout`), rejection dispatch,
 * unproven-absence, and the deadlines restored from the durable
 * `next_attempt_at` at startup.
 *
 * What it does NOT cover, deliberately: a session that has never been ATTEMPTED
 * carries no deadline, so a foreign-environment or oversize row reads as ready
 * until its first drain judges it. ISS-7096 (foreign rows park durably) and
 * ISS-7246 (idle rows are withheld durably) bound that to one pass per
 * newly-seen session rather than one per idle tick.
 */
export function countReadyCandidates(input: ReadyQueueInput): number {
  let ready = 0;
  for (const id of input.queue) {
    if (!isDeferred(input, id)) {
      ready += 1;
    }
  }
  return ready;
}

/**
 * FEA-2733: content-blind snapshot of local→cloud sync progress for the
 * renderer's sync indicators. Counts only — never session ids or content — and
 * derived from in-memory state, so it is cheap to poll on the runtime-status
 * cadence.
 *
 * Pure and service-free (ISS-7099) so the projection can be tested without
 * standing up a sync service, and so the shrink-only
 * `agent-session-sync-service.ts` does not carry it.
 */
export function buildAgentSessionSyncProgress(
  input: SessionProgressInput
): AgentSessionSyncProgress {
  const pendingBackfillSessions = input.backfillQueue.length;
  const pendingIncrementalSessions = input.incrementalQueue.length;
  const identified = input.sourceKey !== null;
  // FEA-2733: the in-memory queue/flag state belongs to `hydratedSourceKey`.
  // Between a compute-target (account) switch and the next sync tick that
  // re-hydrates, the current source key differs from the hydrated one, so the
  // drained queues actually describe the PRIOR identity. Gate `caughtUp` on the
  // keys matching so a freshly-switched target never inherits the old account's
  // "up to date" before its own walk has run.
  const sourceMatchesHydrated =
    identified && input.sourceKey === input.hydratedSourceKey;
  const queuesDrained =
    pendingBackfillSessions === 0 &&
    pendingIncrementalSessions === 0 &&
    !input.hasPendingParts;
  const caughtUp =
    sourceMatchesHydrated && input.initialBackfillPassRun && queuesDrained;
  return {
    identified,
    pendingBackfillSessions,
    pendingIncrementalSessions,
    ...attributableCounts(input, sourceMatchesHydrated, caughtUp),
    sendingSessions:
      sourceMatchesHydrated && input.initialBackfillPassRun
        ? countSendingSessions(input)
        : null,
    backfilling: pendingBackfillSessions > 0,
    caughtUp,
    deadLetteredSessions: input.deadLetteredSessions,
    deadLetteredComponents: input.deadLetteredComponents,
  };
}

/** One queue judged against the lane's per-session retry deadlines. */
type ReadyQueueInput = {
  queue: readonly string[];
  nextRetryAfterMs: ReadonlyMap<string, number>;
  nowMs: number;
};

/** Everything {@link buildAgentSessionSyncProgress} needs, and nothing else. */
export type SessionProgressInput = {
  backfillQueue: readonly string[];
  incrementalQueue: readonly string[];
  nextRetryAfterMs: ReadonlyMap<string, number>;
  nowMs: number;
  hasPendingParts: boolean;
  /** ISS-12529: the session ids of the batch on the wire, `[]` when none is. */
  sendingIds: readonly string[];
  sourceKey: string | null;
  hydratedSourceKey: string | null;
  initialBackfillPassRun: boolean;
  delivered: number;
  inFlightHighWater: number;
  deadLetteredSessions: number;
  deadLetteredComponents: number;
};

/**
 * The counts that belong to `hydratedSourceKey`, or ALL `null` while the two
 * keys disagree.
 *
 * FEA-2733 already gates `caughtUp` on the keys matching, for a reason that
 * applies just as hard here: between a compute-target switch and the sync tick
 * that re-hydrates, `identified` is already true for the NEW key while these
 * counters still describe the PRIOR account's work. Publishing them anyway
 * attributes one account's deliveries to the next. `null` is "not yet
 * attributable", which every reader must render as unmeasured — never as zero,
 * and never as a total to divide by.
 */
function attributableCounts(
  input: SessionProgressInput,
  sourceMatchesHydrated: boolean,
  caughtUp: boolean
): Pick<
  AgentSessionSyncProgress,
  | "readyBackfillSessions"
  | "readyIncrementalSessions"
  | "deliveredSessions"
  | "inFlightTotalSessions"
> {
  if (!sourceMatchesHydrated) {
    return {
      readyBackfillSessions: null,
      readyIncrementalSessions: null,
      deliveredSessions: null,
      inFlightTotalSessions: null,
    };
  }
  const readyBackfillSessions = countReadyCandidates({
    queue: input.backfillQueue,
    nextRetryAfterMs: input.nextRetryAfterMs,
    nowMs: input.nowMs,
  });
  const readyIncrementalSessions = countReadyCandidates({
    queue: input.incrementalQueue,
    nextRetryAfterMs: input.nextRetryAfterMs,
    nowMs: input.nowMs,
  });
  const inFlight =
    input.delivered + readyBackfillSessions + readyIncrementalSessions;
  return {
    readyBackfillSessions,
    readyIncrementalSessions,
    deliveredSessions: input.delivered,
    // Caught up means the queues are EMPTY, so anything still carried in the
    // high-water left without being delivered and is owed by nobody. That is
    // the one shrink the total is allowed; every other sample keeps the mark.
    inFlightTotalSessions: caughtUp
      ? inFlight
      : Math.max(input.inFlightHighWater, inFlight),
  };
}

/**
 * ISS-12529: how many sessions of the batch on the wire are still owed.
 *
 * The drain sends at most one batch at a time (`selectDrainCandidates` caps it
 * at the per-lane batch size), and a sent id stays queued until its ack folds,
 * so the count is a subset of the pending totals by construction. Counting only
 * ids still queued keeps that true across the ack fold, which dequeues before
 * the pass clears `sendingIds`.
 */
function countSendingSessions(
  input: Pick<
    SessionProgressInput,
    "sendingIds" | "backfillQueue" | "incrementalQueue"
  >
): number {
  if (input.sendingIds.length === 0) {
    return 0;
  }
  const sending = new Set(input.sendingIds);
  const queued = new Set<string>();
  for (const queue of [input.backfillQueue, input.incrementalQueue]) {
    for (const id of queue) {
      if (sending.has(id)) {
        queued.add(id);
      }
    }
  }
  return queued.size;
}

function isDeferred(
  input: Pick<ReadyQueueInput, "nextRetryAfterMs" | "nowMs">,
  id: string
): boolean {
  const deadline = input.nextRetryAfterMs.get(id);
  return deadline !== undefined && deadline > input.nowMs;
}
