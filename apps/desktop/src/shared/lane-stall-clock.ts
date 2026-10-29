/**
 * @file lane-stall-clock.ts
 * @description PRD-699 §7.3 (ISS-8615): the lane-stall clock SHAPE, as pure
 * functions over `{state, now}`.
 *
 * When a failure class stops burning the retry budget it must start burning a
 * clock, or invariant 4 compliance quietly becomes an invariant 5 violation
 * (`main/sync/AGENTS.md`). Three lane-specific durable columns exist today:
 * `transcript_sync_state.lane_stalled_since` (ISS-7097, migration 0062),
 * `agent_session_sync_outbox.lane_stalled_since` (ISS-7730, migration 0068),
 * and `agent_component_invocation_sync_outbox.lane_stalled_since` (ISS-8591,
 * migration 0084). The columns stay per-lane: a shared sync-state table is a
 * recorded PLN-1562 non-goal, identity arity differs, and one hot table on a
 * single-writer SQLite store serializes every lane against every other. **What
 * is shared is the SHAPE**, and this file is it.
 *
 * That shape is three questions a lane asks of a stall run:
 *
 * 1. When did this run open, and how long has it been open? — {@link laneStallWindow}
 * 2. Has it outlived the ceiling? — the same, via the wall-clock arm of
 *    {@link SyncRetryBudget}, so the give-up comparison has one home.
 * 3. How long until the next attempt? — {@link laneStallDelayMs}
 *
 * The durable-column ceilings are deliberately kept EQUAL so lanes measuring the
 * same outage cannot disagree about when to give up; keeping them equal by SSOT
 * is what {@link LANE_STALL_CEILING_MS} is for. Cadence is deliberately NOT the
 * same invariant — a lane may stage its polling differently and still agree on
 * the terminal instant — so the schedule is a parameter with a default rather
 * than a constant.
 *
 * Node-free and dependency-free beyond its two `shared/` siblings, matching the
 * `exponential-backoff.ts` / `sync-lane-contract.ts` precedent.
 */

import { exponentialBackoffMs } from "./exponential-backoff.js";
import {
  isSyncRetryBudgetSpent,
  type SyncRetryBudget,
  SyncRetryBudgetKind,
  syncRetryBudgetRemainingMs,
} from "./sync-retry-budget.js";

/**
 * How long one row may sit in an unbroken lane-wide failure run before its lane
 * gives up on it anyway — the ONE ceiling every stall clock measures against.
 *
 * 24h matches the server's own stale-upload backstop, past which it aborts an
 * in-flight multipart upload: a stall this long is no longer a blip a lane
 * should keep silently absorbing. `TRANSCRIPT_LANE_STALL_CEILING_MS` and
 * `SESSION_LANE_STALL_CEILING_MS` are now both spellings of this value rather
 * than two hand-synchronised copies of it.
 */
export const LANE_STALL_CEILING_MS = 24 * 60 * 60_000;

/**
 * The FLOOR of a lane-wide retry schedule — the delay a stall run opens on, and
 * the shortest wait any environmental failure ever gets.
 *
 * Five minutes polls a fresh outage ~12 times an hour per row instead of 240.
 * ISS-7730 measured the alternative (30s across a 24h ceiling) at 2,880 requests
 * per row against a server that is already failing.
 */
export const LANE_STALL_RETRY_FLOOR_MS = 5 * 60_000;

/**
 * The ceiling on ONE retry delay, distinct from {@link LANE_STALL_CEILING_MS},
 * which bounds the whole run.
 *
 * An hour is where staging stops paying: past it the extra patience saves a
 * handful of requests across a 24h run while adding an hour to how long a
 * recovered cloud goes unnoticed. This caps what the schedule chooses on its
 * own; a server `Retry-After` may still ask for longer and is bounded by the run
 * ceiling instead.
 */
export const LANE_STALL_MAX_RETRY_MS = 60 * 60_000;

/**
 * One lane's stall policy: how it paces attempts during a run, and when it gives
 * up on the run entirely.
 *
 * `ceilingMs` is the part lanes are expected to share (see
 * {@link LANE_STALL_CEILING_MS}); `floorMs`/`maxRetryMs` are the part they may
 * legitimately differ on, which is why this is a parameter rather than three
 * more constants.
 */
export type LaneStallSchedule = {
  /** Delay for a freshly-opened run, and the shortest delay the ladder emits. */
  floorMs: number;
  /** Cap on any single delay the ladder chooses on its own. */
  maxRetryMs: number;
  /** How long the whole run may stay open before the terminal path opens. */
  ceilingMs: number;
};

/** The schedule an adopting lane gets unless it states otherwise. */
export const DEFAULT_LANE_STALL_SCHEDULE: LaneStallSchedule = {
  floorMs: LANE_STALL_RETRY_FLOOR_MS,
  maxRetryMs: LANE_STALL_MAX_RETRY_MS,
  ceilingMs: LANE_STALL_CEILING_MS,
};

/** The wall-clock budget a schedule's ceiling describes, for the shared table. */
export function laneStallBudget(
  schedule: LaneStallSchedule = DEFAULT_LANE_STALL_SCHEDULE
): SyncRetryBudget {
  return {
    kind: SyncRetryBudgetKind.WallClock,
    ceilingMs: schedule.ceilingMs,
  };
}

/**
 * The retry delay for a stall run that has been open for `stallAgeMs`, doubling
 * from the schedule's floor to its per-delay cap — 5, 10, 20, 40, 60 minutes on
 * the default schedule.
 *
 * Keyed off the stall CLOCK, never off a retry counter. That counter is frozen
 * for this failure class by design (invariant 4), so a delay derived from it
 * would not move — it would pin every stalled row to whatever rung it happened
 * to be on when the outage started, which for a healthy row is the opening rung
 * hammering an already-failing cloud. The age is the only thing that grows
 * during a stall, which is what makes it the right rung index.
 *
 * A non-finite or negative age reads as a fresh stall and gets the floor: a
 * clock we cannot subtract is not evidence that anything should wait longer.
 */
export function laneStallRetryMs(
  stallAgeMs: number,
  schedule: LaneStallSchedule = DEFAULT_LANE_STALL_SCHEDULE
): number {
  const age = Number.isFinite(stallAgeMs) && stallAgeMs > 0 ? stallAgeMs : 0;
  const floorMs = Number.isFinite(schedule.floorMs)
    ? Math.max(1, schedule.floorMs)
    : LANE_STALL_RETRY_FLOOR_MS;
  // 1-indexed rung: the exponent crosses at each doubling of the floor, so the
  // delay is the one the run has actually earned rather than one per attempt
  // (attempts are what the frozen counter would have measured).
  const rung = 1 + Math.floor(Math.log2(age / floorMs + 1));
  return exponentialBackoffMs(rung, floorMs, schedule.maxRetryMs);
}

/** What a lane needs to know to schedule or terminate one stalled row. */
export type LaneStallClockInput = {
  /**
   * When this row's current unbroken failure run opened, or `null` when it has
   * no run on record — an absent column, or one `Date.parse` could not read.
   */
  stalledSinceMs: number | null;
  nowMs: number;
  schedule?: LaneStallSchedule;
};

/**
 * Where a row stands in its stall run: when the run opened, how long it has been
 * open, and whether it has outlived the ceiling.
 *
 * PURE — it reports the run a caller should persist rather than starting one
 * itself. The session lane's in-memory map and the transcript lane's column are
 * both writers of `startedAtMs`, and keeping the decision free of that write is
 * what lets the same shape serve a lane with a durable column, a lane with an
 * in-memory clock, and a test.
 *
 * A `null` or unreadable `stalledSinceMs` OPENS a run at `nowMs` rather than
 * expiring one: an unknown clock is not evidence that a row has waited, and
 * treating it as expired would dead-letter healthy rows the first time a column
 * failed to parse.
 */
export type LaneStallWindow = {
  /** The instant this run began — the value the caller should persist. */
  startedAtMs: number;
  /** How long the run has been open, never negative. */
  elapsedMs: number;
  /** Whether the run has outlived {@link LaneStallSchedule.ceilingMs}. */
  expired: boolean;
  /** Whether this call OPENED the run (there was none on record). */
  opened: boolean;
};

export function laneStallWindow(input: LaneStallClockInput): LaneStallWindow {
  const schedule = input.schedule ?? DEFAULT_LANE_STALL_SCHEDULE;
  const recorded = input.stalledSinceMs;
  const readable = recorded !== null && Number.isFinite(recorded);
  // A FUTURE stamp is clamped to now, not left ahead: `now - startedAt` would
  // otherwise be negative for as long as the skew lasts, making the ceiling
  // unreachable and the row's terminal path unreachable with it.
  const startedAtMs = readable ? Math.min(recorded, input.nowMs) : input.nowMs;
  const state = { attemptCount: 0, originMs: startedAtMs, nowMs: input.nowMs };
  return {
    startedAtMs,
    elapsedMs: Math.max(0, input.nowMs - startedAtMs),
    expired: isSyncRetryBudgetSpent(laneStallBudget(schedule), state),
    opened: !readable,
  };
}

/**
 * How long the lane waits before its next attempt on a stalled row.
 *
 * `Retry-After` is a MINIMUM wait, so honoring it means never scheduling earlier
 * than the server asked — hence `max`, not `min`. A `min` would let a transient
 * 60-second hint pin the schedule to its opening rung forever and defeat the
 * staging entirely (PRD-699 F8), while a long configuration hint would simply be
 * ignored.
 *
 * While budget REMAINS the result is capped by it, so the next attempt can never
 * land past the give-up instant. Without that cap a hint issued late in a run
 * would push the next attempt beyond the ceiling, and the ceiling is only
 * evaluated when an attempt actually runs — the terminal path would be scheduled
 * out of reach.
 *
 * Once the budget is SPENT the cap stops applying, deliberately: a row past its
 * ceiling is dead-letter-eligible on every attempt, but dead-lettering is
 * ack-gated, so a cloud that cannot record the terminal outcome leaves the row on
 * this schedule with a negative remainder. Clamping that to zero would retry it
 * every tick — a hot loop strictly worse than the flat delay this schedule
 * replaced, reachable in exactly the outage where the ack is least likely to
 * land.
 */
export function laneStallDelayMs(
  input: LaneStallClockInput & { retryAfterMs?: number }
): number {
  const schedule = input.schedule ?? DEFAULT_LANE_STALL_SCHEDULE;
  const window = laneStallWindow(input);
  const staged = laneStallRetryMs(window.elapsedMs, schedule);
  // Clamped to the run ceiling before anything else: a hint longer than the
  // whole budget is not a schedule, and left unclamped it would set the next
  // attempt years out on a row whose budget is already spent (where the
  // remaining-budget cap below no longer applies).
  const requested =
    input.retryAfterMs !== undefined && Number.isFinite(input.retryAfterMs)
      ? Math.min(Math.max(0, input.retryAfterMs), schedule.ceilingMs)
      : 0;
  const desired = Math.max(staged, requested);
  const remainingMs = syncRetryBudgetRemainingMs(laneStallBudget(schedule), {
    attemptCount: 0,
    originMs: window.startedAtMs,
    nowMs: input.nowMs,
  });
  if (remainingMs !== null && remainingMs > 0) {
    return Math.min(desired, remainingMs);
  }
  return desired;
}
