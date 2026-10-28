/**
 * FEA-3659: which in-memory consecutive-failure budget a persisted outbox
 * `last_error` belongs to. Resume must seed the SAME budget the original failure
 * was accruing, so the routing lives in one place rather than per caller.
 */
import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import { OutboxStatus } from "../../shared/sync-lane-contract.js";
import { UNKNOWN_ACK_REASON } from "../cloud/cloud-protocol.js";
import { MAX_TRACKED_LANE_STALLS } from "./agent-session-sync-backoff-policy.js";
import type { SessionOutboxEngineState } from "./agent-session-sync-source.js";
import { isValidationFailureReason } from "./agent-session-sync-validation-failure.js";
import { readPendingSessionOutboxEngineState } from "./sync-source-reply-boundary.js";

/**
 * The per-reason counters a resume can seed. Not all of them are budgets: the
 * four environmental classes (`ingestion_failed`, `rate_limited`, `ack_timeout`,
 * `unknown_ack_reason`) keep an attempt TALLY that no terminal path reads — see
 * `agent-session-sync-lane-stall-fold.ts`. Seeding it still matters, because
 * `loadPendingSessionOutboxEngineState` is the durable handoff for the lane's
 * outbox engine state: retry budget, permanent-attempt budget, recovery ladder,
 * and lane-stall clock.
 */
export type SessionOutboxEngineCounters = {
  ackOmitted: Map<string, number>;
  ackTimeout: Map<string, number>;
  ingestionFailed: Map<string, number>;
  rateLimited: Map<string, number>;
  unknownAckReason: Map<string, number>;
  validationFailed: Map<string, number>;
};

/**
 * Only the transient classes that defer with backoff have a counter; an
 * unrecognized or absent reason returns null, and the caller re-arms the
 * `next_attempt_at` deadline class-agnostically either way.
 */
export function retryCounterMapForReason(
  reason: string | null,
  counters: SessionOutboxEngineCounters
): Map<string, number> | null {
  switch (reason) {
    case SyncReason.IngestionFailed:
      return counters.ingestionFailed;
    case SyncReason.RateLimited:
      return counters.rateLimited;
    // ISS-8605 / ISS-8595: both became durably-recorded environmental defers, so
    // — unlike the pre-F2 `ack_timeout`, which wrote no outbox row at all — a
    // resume can and must find their tallies again.
    case SyncReason.AckTimeout:
      return counters.ackTimeout;
    case UNKNOWN_ACK_REASON:
      return counters.unknownAckReason;
    case SyncReason.AckOmitted:
      // Goal stage 2: recorded durably on defer, so resume re-seeds it too.
      return counters.ackOmitted;
    default:
      // ISS-5090: every validation-rejection reason (row-attributable,
      // envelope-attributable, envelope-exhausted) shares ONE budget, so all
      // three seed the same counter.
      return isValidationFailureReason(reason)
        ? counters.validationFailed
        : null;
  }
}

/** The resume-time state a rehydration seeds, plus its log sink. */
export type SessionOutboxEngineHydrationTarget = {
  counters: SessionOutboxEngineCounters;
  /** Deferred-retry deadlines, re-armed so `pickReadyCandidates` keeps deferring. */
  nextRetryAfterMs: Map<string, number>;
  /**
   * ISS-7730: per-id start of the current unbroken LANE-WIDE failure run (ms
   * since epoch). Seeding this is what makes the wall-clock bound survive a
   * relaunch: `ingestion_failed` advances no budget toward a dead-letter, so the
   * clock is its ONLY terminal path, and a desktop restarted inside a long
   * outage would otherwise reset it on every launch and never reach it.
   */
  laneStalledSinceMsById: Map<string, number>;
  /** Durable recovery ladder position, preserved across dead-letter recovery. */
  deadLetterRecoveryCountById: Map<string, number>;
  /** ISS-9182: ack-omitted cycles already spent, so a restart grants no new ones. */
  ackOmittedCycleById: Map<string, number>;
  /**
   * Rows already set aside this resume; they are revisited via their own
   * deadline path. Membership-only, so the caller's Set or id-keyed Map both
   * satisfy it without this module caring which.
   */
  deadLetteredIds: { has(id: string): boolean };
  logInfo: (message: string) => void;
  /**
   * ISS-8115: where {@link resumeSessionOutboxEngineState} states that the durable read
   * itself failed. Separate from {@link SessionOutboxEngineHydrationTarget.logInfo}
   * because a resume that could not read its budget is not the same event as a
   * resume that read an empty one.
   */
  logWarn?: (message: string) => void;
  /**
   * ISS-7730: the MONITORED report for a persisted `lane_stalled_since` that
   * cannot be right. Injected rather than imported so this module stays pure and
   * the telemetry transport is the caller's concern — the same split
   * `reportFreshestSessionLagAnomaly` uses on the accepted-ack path.
   */
  reportInvalidStallClock: (anomaly: LaneStallClockAnomaly) => void;
};

/**
 * FEA-3659: rehydrate the in-memory retry budget + deferred-retry deadline from
 * the durable outbox. Re-enqueuing the pending ids is not enough: the
 * per-session counters and `nextRetryAfterMs` start empty on a fresh process, so
 * without this a row that was mid-backoff (e.g. `attempt_count=4`) would be
 * retried IMMEDIATELY and its next rejection would recompute `(0 + 1) = 1`,
 * overwriting the persisted budget back to 1 and letting an outage that spans
 * restarts dodge the intended dead-letter cap.
 *
 * The caller owns loading and its failure log; an empty `rows` is the resume
 * that had nothing to rehydrate, not an error.
 *
 * Returns how many rows were seeded.
 */
export function rehydrateSessionOutboxEngineState(
  rows: readonly SessionOutboxEngineState[],
  target: SessionOutboxEngineHydrationTarget
): number {
  let seeded = 0;
  for (const row of rows) {
    if (seedSessionOutboxEngineRow(row, target)) {
      seeded += 1;
    }
  }
  if (seeded > 0) {
    target.logInfo(
      `rehydrated durable outbox engine state for ${seeded} agent session(s) on resume`
    );
  }
  return seeded;
}

function seedSessionOutboxEngineRow(
  row: SessionOutboxEngineState,
  target: SessionOutboxEngineHydrationTarget
): boolean {
  const isDeadLetteredRow =
    row.status === OutboxStatus.DeadLettered ||
    target.deadLetteredIds.has(row.id);
  const recoveryCountSeeded = seedDeadLetterRecoveryCount(row, target);
  const ackOmittedCyclesSeeded = seedAckOmittedCycleCount(row, target);
  if (isDeadLetteredRow) {
    return recoveryCountSeeded || ackOmittedCyclesSeeded;
  }
  return [
    seedRetryBudget(row, target),
    recoveryCountSeeded,
    ackOmittedCyclesSeeded,
    seedStallClock(row, target),
  ].some(Boolean);
}

function seedRetryBudget(
  row: SessionOutboxEngineState,
  target: SessionOutboxEngineHydrationTarget
): boolean {
  const budgetAttemptCount = durableAttemptCount(row);
  if (budgetAttemptCount <= 0) {
    return false;
  }
  const counter = retryCounterMapForReason(row.lastError, target.counters);
  if (counter) {
    counter.set(row.id, budgetAttemptCount);
  }
  const deadlineMs = row.nextAttemptAt
    ? Date.parse(row.nextAttemptAt)
    : Number.NaN;
  if (Number.isFinite(deadlineMs)) {
    target.nextRetryAfterMs.set(row.id, deadlineMs);
  }
  return true;
}

function seedDeadLetterRecoveryCount(
  row: SessionOutboxEngineState,
  target: SessionOutboxEngineHydrationTarget
): boolean {
  if (row.deadLetterRecoveryCount <= 0) {
    return false;
  }
  target.deadLetterRecoveryCountById.set(row.id, row.deadLetterRecoveryCount);
  return true;
}

function durableAttemptCount(row: SessionOutboxEngineState): number {
  if (
    usesPermanentAttemptBudget(row.lastError) &&
    row.permanentAttemptCount > 0
  ) {
    return row.permanentAttemptCount;
  }
  return row.attemptCount;
}

function usesPermanentAttemptBudget(reason: string | null): boolean {
  return reason === SyncReason.AckOmitted || isValidationFailureReason(reason);
}

/**
 * ISS-7730: why a persisted `lane_stalled_since` could not be trusted. A closed
 * two-member set, mirroring `FreshestSessionLagAnomaly` — the reporter picks one
 * of two fixed content-free sentences from it, so no timestamp or session id
 * ever leaves the machine.
 */
export const LaneStallClockAnomaly = {
  /** The column held a string `Date.parse` could not read. */
  Unreadable: "unreadable",
  /** The column held a finite instant AHEAD of the local clock reading it. */
  Future: "future",
} as const;

export type LaneStallClockAnomaly =
  (typeof LaneStallClockAnomaly)[keyof typeof LaneStallClockAnomaly];

/**
 * Seed one row's lane-wide stall clock, reporting a value that cannot be right
 * instead of quietly dropping or accepting it.
 *
 * Both invalid shapes end the same 24-hour bound in practice and neither is
 * visible from anywhere else — the row keeps deferring, nothing throws — so both
 * ride the monitored lane before degrading:
 *
 * - UNREADABLE: left unseeded. The row is treated as having no run in progress
 *   and starts a fresh clock on its next lane-wide failure, which also rewrites
 *   the corrupt column. Seeding the `NaN` instead would make every later
 *   comparison false and silently remove the bound altogether.
 * - FUTURE: clamped to now and seeded. `nowMs - startedAtMs` would otherwise be
 *   NEGATIVE for as long as the skew lasts, so the ceiling is unreachable and
 *   the row defers forever. Clamping is the honest reading of "the run started
 *   no later than now" and is self-repairing: the next defer stamps the clamped
 *   start back over the corrupt one.
 *
 * A saturated map admits nothing (see {@link MAX_TRACKED_LANE_STALLS}); the row
 * simply resumes untracked, keeping its durable stamp for a later pass.
 */
function seedStallClock(
  row: SessionOutboxEngineState,
  target: SessionOutboxEngineHydrationTarget
): boolean {
  if (!row.laneStalledSince) {
    return false;
  }
  const stalledSinceMs = Date.parse(row.laneStalledSince);
  if (!Number.isFinite(stalledSinceMs)) {
    target.reportInvalidStallClock(LaneStallClockAnomaly.Unreadable);
    return false;
  }
  const nowMs = Date.now();
  if (stalledSinceMs > nowMs) {
    target.reportInvalidStallClock(LaneStallClockAnomaly.Future);
  }
  if (target.laneStalledSinceMsById.size >= MAX_TRACKED_LANE_STALLS) {
    return false;
  }
  target.laneStalledSinceMsById.set(row.id, Math.min(stalledSinceMs, nowMs));
  return true;
}

/**
 * FEA-3659 / ISS-8115 — load the persisted retry budget for `sourceKey` and seed
 * it, as one step.
 *
 * Extracted from `agent-session-sync-service.ts` (a grandfathered over-ceiling
 * file) so the read, its boundary validation, its failure log and the seeding it
 * feeds live with the counter routing they depend on rather than inline in the
 * service. Seeding the counters preserves the persisted budget and seeding
 * `nextRetryAfterMs` re-arms the backoff, so `pickReadyCandidates` keeps
 * deferring the row until its persisted `next_attempt_at` elapses.
 *
 * `load` is typed `() => unknown` on purpose. Under the FEA-2038 build it is a
 * db-host IPC round-trip, so `SessionOutboxEngineState[]` would be an ASSERTION about
 * the peer rather than a fact about the bytes; `readPendingSessionOutboxEngineState` is
 * what re-establishes the shape, and ISS-8594 made its `undefined` — the reply
 * could not be read — as much a FAILED READ here as a thrown delegate is. It
 * used to degrade to the pre-FEA-3659 unseeded budget and let the pass carry on,
 * which is the conclusion that ticket overturned: an unseeded budget reaching
 * candidate selection uploads against empty maps, bypassing both the persisted
 * backoff and the dead-letter cap.
 *
 * Never throws. The `try` spans the seeding as well as the `await`, which the
 * service's own guard did not: a non-array reply used to throw from
 * `rehydrateSessionOutboxEngineState`'s `for...of` — outside the catch — and take
 * identity hydration down with it.
 *
 * ISS-8116 (davetho review): `isCurrentSourceState` is re-read AFTER the load
 * and before the seeding, because the seeding writes into maps the SERVICE
 * shares across identities. `stop()` clears the single-flight `syncing` flag, so
 * a pass for identity B can run start-to-finish while this load is outstanding;
 * without this reading, A's persisted backoff, lane-stall clocks and dead-letter
 * set landed in the maps B's live pass was already reading from. Required rather
 * than optional so a caller has to state which lifecycle its seeding belongs to.
 * That check is tested BEFORE the unreadable-reply check, deliberately: a
 * superseded pass is not a read failure, and it keeps the behavior it has today.
 * ISS-9823 review extended the same rule to the `catch` arm, which used to
 * answer `ReadFailed` for a read the supersede itself may have broken.
 *
 * Returns which of the three things happened, and how many rows were seeded —
 * meaningful only on {@link OutboxResumeOutcome.Seeded}, and `0` otherwise.
 */
export async function resumeSessionOutboxEngineState(
  load: () => unknown,
  target: SessionOutboxEngineHydrationTarget,
  isCurrentSourceState: () => boolean
): Promise<OutboxResumeResult> {
  try {
    const rows = readPendingSessionOutboxEngineState(await load());
    if (!isCurrentSourceState()) {
      return { outcome: OutboxResumeOutcome.Discarded, seeded: 0 };
    }
    if (rows === undefined) {
      target.logWarn?.(
        "failed to load pending outbox retry state on resume: the reply could not be read"
      );
      return { outcome: OutboxResumeOutcome.ReadFailed, seeded: 0 };
    }
    return {
      outcome: OutboxResumeOutcome.Seeded,
      seeded: rehydrateSessionOutboxEngineState(rows, target),
    };
  } catch (error) {
    // ISS-9823 review: the supersede check the success path already makes,
    // made on the failure path too. A `stop()` or compute-target switch tears
    // down the db-host channel this read is parked on, so the switch is itself a
    // plausible cause of the rejection, and answering `ReadFailed` there latches
    // a durable fault against whatever identity is now live — a page on every
    // account switch that happens to coincide with a transient read failure. The
    // ISS-8116 paragraph above already states the rule for the reply arm: a
    // superseded pass is NOT a read failure. Nothing is lost by preferring the
    // benign answer, because a genuine fault re-surfaces on the next tick under
    // the stable identity: the read keeps failing.
    if (!isCurrentSourceState()) {
      return { outcome: OutboxResumeOutcome.Discarded, seeded: 0 };
    }
    target.logWarn?.(
      `failed to load pending outbox retry state on resume: ${error instanceof Error ? error.message : String(error)}`
    );
    // ISS-8594 review asked for this arm to report on the boundary facet the
    // unreadable arm uses, so a thrown read is not invisible. It deliberately
    // does NOT: that facet's event states "refused the child's REPLY because it
    // did not match this build's schema", and a throw produced no reply to
    // refuse — emitting it here would put a false claim on a monitored facet,
    // which is the shape of defect this ticket exists to remove. The facet's
    // validator (`@repo/observability` `dbHostReplyRejectedDiagnosticsSchema`)
    // is `.strip()`ed to the op alone, so there is nowhere to carry "why"
    // without teaching that package a new dimension.
    //
    // ISS-9823 corrected what this paragraph used to claim next — that
    // `detectNoProgressStall` covers the wedge because the lane stays
    // `Draining`. It does not, and the abort is why: it returns before
    // `enqueueIncrementalUpdates`, so on a device that was already caught up no
    // outbox row is ever written, `pending` stays `0`, the lane classified as
    // `Drained`, and a detector requiring `Draining` on both samples could not
    // fire.
    //
    // What covers it now is the burn-down itself: the outcome below is teed to
    // `SessionResumeHealth`, and `classifyLaneDrainState` reads that liveness
    // fact AFTER the measured-backlog branch and ahead of every branch that
    // claims the queue emptied. So a wedged lane still holding rows keeps
    // answering `draining` — which is what `detectNoProgressStall` requires, and
    // why the check sits where it does — while the caught-up device this
    // paragraph is about reports `remaining_unknown`, so `areAllLanesFullySynced`
    // can no longer answer that it is fully synced. `detectResumeBlockedStall`
    // is what then PAGES on it: three consecutive samples of a running lane in
    // that condition raise `sync.durable_cursor.stalled` at
    // `kind: resume_read_failed`, whose sentence names the durable read and the
    // unapplied migration to look for.
    return { outcome: OutboxResumeOutcome.ReadFailed, seeded: 0 };
  }
}

/**
 * ISS-8594: which of three things one {@link resumeSessionOutboxEngineState} pass did.
 *
 * The distinction the caller needs is not "how many rows" but whether the read
 * HAPPENED. A seeded 0 and a failed read used to be the same number, and the
 * hydration could only treat them the same way.
 */
export const OutboxResumeOutcome = {
  /** The read landed. `seeded` may be 0 — an empty outbox is a real answer. */
  Seeded: "seeded",
  /** The pass was superseded mid-load. Not a failure; the caller's identity guard owns it. */
  Discarded: "discarded",
  /** The read did not happen: it threw, or answered a shape this build cannot read. */
  ReadFailed: "read_failed",
} as const;

export type OutboxResumeOutcome =
  (typeof OutboxResumeOutcome)[keyof typeof OutboxResumeOutcome];

/** What one {@link resumeSessionOutboxEngineState} pass established, and what it seeded. */
export type OutboxResumeResult = {
  outcome: OutboxResumeOutcome;
  /** Rows seeded; only {@link OutboxResumeOutcome.Seeded} can carry a non-zero. */
  seeded: number;
};

/**
 * ISS-9182: seed the ack-omitted cycles a row has already spent. The column can
 * run ahead of the map (it also counts the terminal cycle), and seeding the
 * larger value only ever makes a row terminal sooner, never later.
 */
function seedAckOmittedCycleCount(
  row: SessionOutboxEngineState,
  target: SessionOutboxEngineHydrationTarget
): boolean {
  const cycles = row.ackOmittedCycleCount ?? 0;
  if (cycles <= 0) {
    return false;
  }
  target.ackOmittedCycleById.set(row.id, cycles);
  return true;
}
