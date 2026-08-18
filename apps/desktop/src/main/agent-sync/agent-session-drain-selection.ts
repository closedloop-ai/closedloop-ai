/**
 * @file agent-session-drain-selection.ts
 * @description Which lane wins one session-sync drain tick, and with which
 * candidate ids. Extracted from the grandfathered (shrink-only)
 * `agent-session-sync-service.ts` in the same collaborator style as the ack and
 * failure folds, so the selection policy is unit-testable without the service's
 * cursor/hydration/transport machinery.
 *
 * Pure: it reads queue state and a `pickReady` probe, and returns the decision
 * plus the coalescing stamp the caller must apply. It never mutates.
 *
 * The policy:
 *
 *  - FEA-1461 — try incremental first, then fall through to backfill. The ready
 *    filter can reject every queued incremental session (all inside a rate-limit
 *    backoff window), and before that fall-through the tick returned early and
 *    skipped backfill entirely for the whole window.
 *  - ISS-6166 — but incremental may not win FOREVER. Priority was strict, and
 *    `INCREMENTAL_SESSION_READY_THRESHOLD` is 1, so one ready incremental row
 *    took every tick. An actively-used install never empties that lane, so the
 *    historical backfill was never selected at all: the reported machine held
 *    646 backfill rows motionless for two days, and the durable cursor — which
 *    only persists once BOTH queues drain — sat 29 h stale behind them. After
 *    `MAX_CONSECUTIVE_INCREMENTAL_PASSES` consecutive incremental wins the next
 *    tick is RESERVED for backfill.
 *
 *    The reservation is a FLOOR on fairness and never a ceiling on throughput:
 *    a reserved tick whose backfill work turns out not to be ready hands the
 *    tick straight back to incremental, exactly as
 *    `loadReadyInvocationSyncOutboxParts` returns an unspent never-attempted
 *    reservation to its FIFO half (`main/sync/AGENTS.md` invariant 5).
 *
 * ISS-4712 removed one SOURCE of the incremental pressure (rebuild `updated_at`
 * churn re-enqueuing rows the backfill queue already owned). That dedup cannot
 * help here — the pressure this bounds is genuinely-new sessions, which no dedup
 * may drop — so the answer is a fairness floor rather than another filter.
 */
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import {
  BACKFILL_SESSION_BATCH_SIZE,
  INCREMENTAL_SESSION_BATCH_SIZE,
  INCREMENTAL_SESSION_READY_THRESHOLD,
  MAX_CONSECUTIVE_INCREMENTAL_PASSES,
} from "./agent-session-sync-limits.js";
import { capBatchForBisection } from "./agent-session-sync-validation-failure.js";

/**
 * ISS-5085: how long a sub-threshold incremental tail coalesces before it ships
 * anyway. Moved here with the selection policy — it is read at exactly one
 * decision point and nowhere else.
 */
const MIN_INCREMENTAL_SYNC_INTERVAL_MS = 30_000;

export type DrainSelectionInput = {
  nowMs: number;
  incrementalQueue: readonly string[];
  backfillQueue: readonly string[];
  /** The ISS-5085 coalescing stamp; see {@link DrainSelection.incrementalAttemptedAtMs}. */
  lastIncrementalBatchAttemptedAtMs: number;
  consecutiveIncrementalPasses: number;
  /** The service's own ready predicate (deferred-retry deadlines applied). */
  pickReady: (
    queue: readonly string[],
    limit: number,
    nowMs: number
  ) => string[];
  validationBisectIds: ReadonlySet<string>;
};

export type DrainSelection = {
  /** `null` when no lane could field a batch this tick. */
  syncMode: AgentSessionSyncMode | null;
  candidateIds: string[];
  /**
   * ISS-5085: the new coalescing stamp when — and only when — an incremental
   * batch was actually selected. `null` leaves the caller's stamp alone, so a
   * pick the ready filter emptied cannot restart the 30 s window.
   */
  incrementalAttemptedAtMs: number | null;
};

/**
 * Resolve one drain tick's lane and candidates. See the module header for the
 * policy and why the backfill reservation exists.
 */
export function selectDrainCandidates(
  input: DrainSelectionInput
): DrainSelection {
  const reserveForBackfill = shouldReserveTickForBackfill(input);
  if (!reserveForBackfill) {
    const incremental = pickIncrementalBatch(input);
    if (incremental.length > 0) {
      return incrementalSelection(incremental, input.nowMs);
    }
  }
  if (input.backfillQueue.length > 0) {
    const backfill = capBatchForBisection(
      input.pickReady(
        input.backfillQueue,
        BACKFILL_SESSION_BATCH_SIZE,
        input.nowMs
      ),
      input.validationBisectIds
    );
    if (backfill.length > 0) {
      return {
        syncMode: AgentSessionSyncMode.Backfill,
        candidateIds: backfill,
        incrementalAttemptedAtMs: null,
      };
    }
  }
  if (reserveForBackfill) {
    const incremental = pickIncrementalBatch(input);
    if (incremental.length > 0) {
      return incrementalSelection(incremental, input.nowMs);
    }
  }
  return {
    syncMode: null,
    candidateIds: [],
    incrementalAttemptedAtMs: null,
  };
}

/**
 * ISS-6166: how many consecutive incremental wins the counter carries AFTER this
 * tick. A backfill win resets it; a tick that selected nothing leaves it alone,
 * so an idle lane neither spends nor resets the reservation.
 */
export function advanceIncrementalPassCount(
  current: number,
  selected: AgentSessionSyncMode | null
): number {
  if (selected === null) {
    return current;
  }
  return selected === AgentSessionSyncMode.Incremental ? current + 1 : 0;
}

/**
 * Is this tick reserved for backfill? Only once the incremental lane has won
 * `MAX_CONSECUTIVE_INCREMENTAL_PASSES` ticks in a row AND there is backfill work
 * to be fair to — an empty backfill queue never reserves, so the policy is inert
 * on an install that has already drained its history.
 */
function shouldReserveTickForBackfill(input: DrainSelectionInput): boolean {
  return (
    input.backfillQueue.length > 0 &&
    input.consecutiveIncrementalPasses >= MAX_CONSECUTIVE_INCREMENTAL_PASSES
  );
}

/**
 * The incremental lane's whole pick: the ISS-5988 readiness gate, the ready
 * filter, and the bisection cap. Returns `[]` when the gate is shut or nothing
 * is ready.
 */
function pickIncrementalBatch(input: DrainSelectionInput): string[] {
  if (input.incrementalQueue.length === 0) {
    return [];
  }
  const gateOpen =
    input.incrementalQueue.length >= INCREMENTAL_SESSION_READY_THRESHOLD ||
    input.nowMs - input.lastIncrementalBatchAttemptedAtMs >=
      MIN_INCREMENTAL_SYNC_INTERVAL_MS;
  if (!gateOpen) {
    return [];
  }
  return capBatchForBisection(
    input.pickReady(
      input.incrementalQueue,
      INCREMENTAL_SESSION_BATCH_SIZE,
      input.nowMs
    ),
    input.validationBisectIds
  );
}

function incrementalSelection(
  candidateIds: string[],
  nowMs: number
): DrainSelection {
  return {
    syncMode: AgentSessionSyncMode.Incremental,
    candidateIds,
    incrementalAttemptedAtMs: nowMs,
  };
}
