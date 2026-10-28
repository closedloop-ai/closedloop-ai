/**
 * @file agent-session-sync-lane-stall-fold.ts
 * @description ISS-7730: the session lane's fold for the ENVIRONMENTAL ack
 * reasons — the ones that are LANE-WIDE rather than attributable to any row, and
 * are therefore bounded by a wall clock instead of a retry budget.
 *
 * ISS-8605 / ISS-8595 (PRD-699 Appendix A, F1/F2 + the unknown default) widened
 * it from the single `ingestion_failed` class it was built for to the four the
 * approved standard puts in that class. Each carries its own durable
 * `last_error`, its own dead-letter spelling, and its own retry SCHEDULE — see
 * {@link SESSION_ENVIRONMENTAL_DEFER_POLICY} — while sharing this one clock,
 * because "how long has this row been blocked by the world" is one fact per row,
 * not one per reason.
 *
 * ISS-8610 (PRD-699 F8) made those schedules STAGED. Each class keeps its own
 * floor and they all share the ceiling, which is the part `main/sync/AGENTS.md`
 * names as the invariant ("two lanes agreeing on when to give up is the
 * invariant; agreeing on how often to poll on the way there is not"). The rung a
 * defer lands on is read off the run the row is already in, so a row resumed
 * mid-outage picks up where its run had got to instead of restarting at the
 * floor — which is what the durable column was always for.
 *
 * WHY IT IS NOT THE SHARED BOUNDED FOLD. `ingestion_failed` is the sync route's
 * UNCLASSIFIED 500 fallthrough (returned only after Forbidden / ValidationFailed
 * / FeatureDisabled / RateLimited have all declined), and
 * `desktop-agent-sessions-client.ts` folds 502, 504, a deploy-skew 404 and a
 * non-contract 2xx into it as well. It means "the server failed and could not say
 * why". Nothing in it is reproducible from the persisted row, which is precisely
 * `main/sync/AGENTS.md` invariant 4's test for whether a failure may exhaust a
 * budget — so it may not, and the sibling invocation lane already reaches that
 * conclusion for the identical server reason
 * (`invocation-sync-rejection-policy.ts` → `TRANSIENT_REJECTION_BUDGET`).
 * Routing it through `applyBoundedFailureFold` with `countsToward: false` would
 * satisfy invariant 4 and violate invariant 5 in the same line: that fold's ONLY
 * terminal path is the counter it was just told not to advance, so no id would
 * ever dead-letter again.
 *
 * WHAT REPLACES THE BOUND. `lane_stalled_since` — the start of this row's current
 * unbroken lane-wide run — is stamped on the first such failure and read back on
 * every later one. A row still stalled after {@link SESSION_LANE_STALL_CEILING_MS}
 * dead-letters recoverably, which is the same terminal path the exhausted ladder
 * used to reach. It is DURABLE, and that is the whole reason this needed a schema
 * change: the lane's per-class counters are process-scoped, so an in-memory clock
 * would restart on every relaunch and a desktop restarted inside a long outage
 * would never terminate. Column-for-column the transcript lane's ISS-7097 bound.
 *
 * That write is therefore ACKNOWLEDGED, unlike every other durable write on the
 * rejection side. For a row-attributable class the outbox row is a diagnostic
 * hint and a dropped write costs a hint; here it is the bound itself, and a
 * dropped one silently returns the row to an unbounded stall —
 * {@link confirmStallClockWrites} carries the full reasoning and the re-attempt.
 *
 * The attempt tally is kept and still written to `attempt_count`, but nothing
 * terminal reads it: it is EVIDENCE of how hard the lane tried, which the
 * dead-letter row and the ISS-7248 failure diagnostic both report. A tally that
 * no terminal path consults is not a budget, and leaving it in place is what
 * keeps `loadPendingSessionOutboxEngineState` (which selects `attempt_count > 0`) able to
 * find a stalled row and rehydrate its clock.
 *
 * NOT to be confused with `telemetry/sync-lane-stall-telemetry.ts`. That
 * `reportSyncLaneStall` is invariant 5's DRAIN-stall alert — a running lane with
 * a ready backlog delivering nothing. This is a PER-ROW failure run. The name is
 * inherited from the `lane_stalled_since` column ISS-7097 established on the
 * transcript lane, and matching that precedent beat inventing a third spelling.
 * The abandonment this fold decides is already on a monitored path: it goes
 * through `markDeadLettered`, so it reaches the existing dead-letter telemetry
 * and the ISS-7248 failure diagnostic like every other terminal outcome.
 *
 * Pure over an injected collaborator, like its `agent-session-sync-ack-fold.ts`
 * sibling: it owns no state, so the service keeps ownership of its counters,
 * queues, and outbox.
 */

import {
  LaneGiveUpSource,
  SyncLane,
  type SyncReason,
} from "@closedloop-ai/telemetry-contract/sync";
import type { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import {
  LANE_STALL_MAX_RETRY_MS,
  type LaneStallSchedule,
  laneStallDelayMs,
} from "../../shared/lane-stall-clock.js";
import {
  isSyncRetryBudgetSpent,
  SyncRetryBudgetKind,
} from "../../shared/sync-retry-budget.js";
import {
  DesktopAgentSessionsAckReason,
  UNKNOWN_ACK_REASON,
} from "../cloud/cloud-protocol.js";
import { laneGiveUpSourceFor } from "../sync/lane-run-policy.js";
import { reportSyncLaneGaveUp } from "../telemetry/sync-lane-give-up-telemetry.js";
import {
  MAX_TRACKED_LANE_STALLS,
  RATE_LIMIT_BACKOFF_MS,
  SESSION_LANE_STALL_CEILING_MS,
  SESSION_LANE_STALL_RETRY_MS,
} from "./agent-session-sync-backoff-policy.js";
import { syncReasonForAckReason } from "./sync-failure-diagnostic.js";

/**
 * Which ENVIRONMENTAL class a defer belongs to. The three server-answered
 * members are spelled by reference to the ack contract, never copied, because
 * `retryCounterMapForReason` routes a resumed row's tally by this exact string
 * and a resume must seed the tally the original failure was accruing.
 */
export const SessionEnvironmentalDeferClass = {
  AckTimeout: DesktopAgentSessionsAckReason.AckTimeout,
  IngestionFailed: DesktopAgentSessionsAckReason.IngestionFailed,
  RateLimited: DesktopAgentSessionsAckReason.RateLimited,
  UnknownAckReason: UNKNOWN_ACK_REASON,
} as const;

export type SessionEnvironmentalDeferClass =
  (typeof SessionEnvironmentalDeferClass)[keyof typeof SessionEnvironmentalDeferClass];

/** What one environmental class writes and how long it waits between attempts. */
export type EnvironmentalDeferPolicy = {
  /**
   * The `last_error` a defer records; also the resumed-tally routing key.
   *
   * ISS-9418 narrowed this from `string` to the ack-reason union so
   * `syncReasonForAckReason` can fold it onto the closed `sync.reason`
   * vocabulary for the give-up event. Every value here already WAS one of
   * these; typing it is what makes the fold the canonical one rather than a
   * second, drifting copy of the ack-reason-to-telemetry mapping.
   */
  retryReason: DesktopAgentSessionsAckReason | typeof UNKNOWN_ACK_REASON;
  /**
   * The `last_error` a wall-clock dead-letter records — distinct from
   * {@link EnvironmentalDeferPolicy.retryReason} so an operator reading the
   * outbox can tell a row abandoned after a day of unreachable cloud from one
   * still deferring. Mirrors how `CHUNK_VALIDATION_FAILED_REASON` splits off
   * from `validation_failed`.
   */
  deadLetterReason: string;
  /**
   * How this class paces its attempts across one run, and when the run's
   * terminal path opens.
   *
   * ISS-8610 (PRD-699 F8) turned this from a flat number into a schedule. The
   * delay is derived from the row's own stall clock rather than from an attempt
   * counter — that counter is frozen for this class by design (invariant 4), so
   * a delay read off it would never move. ISS-10014 added the schedule's other
   * input: a server `Retry-After`, forwarded on the ack when the cloud sent one,
   * which the helper honors as a MINIMUM against this schedule and then caps by
   * what remains of the run ceiling.
   */
  schedule: LaneStallSchedule;
  /** How the deferral names itself in the info log. */
  deferLabel: string;
};

/**
 * ISS-8610: the schedule the three 30s-floor classes share — one object rather
 * than three identical literals, so a change to the shared floor cannot land on
 * two of them and miss the third.
 */
const SESSION_ENVIRONMENTAL_FLOOR_SCHEDULE: LaneStallSchedule = {
  floorMs: RATE_LIMIT_BACKOFF_MS,
  maxRetryMs: LANE_STALL_MAX_RETRY_MS,
  ceilingMs: SESSION_LANE_STALL_CEILING_MS,
};

/**
 * The per-class policy. Every entry defers with budgets intact and terminates
 * only on the shared 24h wall clock (`main/sync/AGENTS.md` invariants 4 and 5);
 * they differ only in what they write and how often they re-poll.
 *
 * The FLOORS are NOT uniform, and the asymmetry is deliberate.
 * `ingestion_failed` opens at 5 minutes because ISS-7730 measured 30s × 24h as
 * 2,880 requests per row against an already-failing server. The other three open
 * on the shared 30s window PRD-699 F1 names as the backoff FLOOR, which for 429
 * and the unknown default is the cadence they already had — this change removes
 * their dead-letter, it does not make them poll harder — and for 408 is a 6x
 * REDUCTION from the 5s tick it used to re-attempt on.
 *
 * ISS-8610: from that floor every class doubles to the same one-hour per-delay
 * cap and terminates on the same 24h ceiling, so the lanes agree on the terminal
 * instant while keeping the opening cadence each class was argued into.
 */
export const SESSION_ENVIRONMENTAL_DEFER_POLICY: Record<
  SessionEnvironmentalDeferClass,
  EnvironmentalDeferPolicy
> = {
  [SessionEnvironmentalDeferClass.IngestionFailed]: {
    retryReason: DesktopAgentSessionsAckReason.IngestionFailed,
    deadLetterReason: `${DesktopAgentSessionsAckReason.IngestionFailed}_lane_stalled`,
    schedule: {
      floorMs: SESSION_LANE_STALL_RETRY_MS,
      maxRetryMs: LANE_STALL_MAX_RETRY_MS,
      ceilingMs: SESSION_LANE_STALL_CEILING_MS,
    },
    deferLabel: "ingestion_failed (lane-wide server failure)",
  },
  [SessionEnvironmentalDeferClass.RateLimited]: {
    retryReason: DesktopAgentSessionsAckReason.RateLimited,
    deadLetterReason: `${DesktopAgentSessionsAckReason.RateLimited}_lane_stalled`,
    schedule: SESSION_ENVIRONMENTAL_FLOOR_SCHEDULE,
    deferLabel: "rate_limited (per-target server throttle)",
  },
  [SessionEnvironmentalDeferClass.AckTimeout]: {
    retryReason: DesktopAgentSessionsAckReason.AckTimeout,
    deadLetterReason: `${DesktopAgentSessionsAckReason.AckTimeout}_lane_stalled`,
    schedule: SESSION_ENVIRONMENTAL_FLOOR_SCHEDULE,
    deferLabel: "ack_timeout (intermediary 408)",
  },
  [SessionEnvironmentalDeferClass.UnknownAckReason]: {
    retryReason: UNKNOWN_ACK_REASON,
    deadLetterReason: `${UNKNOWN_ACK_REASON}_lane_stalled`,
    schedule: SESSION_ENVIRONMENTAL_FLOOR_SCHEDULE,
    deferLabel: "unrecognized ack reason (version skew)",
  },
};

export type LaneStallFoldConfig = {
  ids: string[];
  syncMode: AgentSessionSyncMode;
  payloadBytes: number;
  /** Which environmental class this batch's rejection belongs to. */
  deferClass: SessionEnvironmentalDeferClass;
  /**
   * Per-id attempt TALLY. Written and reported, never consulted by a terminal
   * path — see the file header for why that distinction is load-bearing.
   */
  attemptsById: Map<string, number>;
  /**
   * Per-id start of the current unbroken lane-wide run (ms since epoch),
   * rehydrated from the durable `lane_stalled_since`. An id absent from the map
   * is starting a new run now — unless the map is at
   * {@link MAX_TRACKED_LANE_STALLS}, in which case it defers untracked until a
   * slot frees. Admission-capped, never evicted: see the constant.
   */
  stalledSinceMsById: Map<string, number>;
  /**
   * ISS-10014: the wait the SERVER asked for on this rejection, in ms, when it
   * sent a `Retry-After` this build could parse.
   *
   * Optional in both directions — an older cloud sends no header, and a newer
   * one must never be REQUIRED to — so an absent hint leaves the staged ladder
   * exactly as it was rather than reading as a wait of zero.
   */
  retryAfterMs?: number;
};

/**
 * One durable environmental-defer write. Named rather than left inline on
 * {@link LaneStallFoldDeps} because the fold now RE-ISSUES an attempt that did
 * not land, and it must re-issue this exact object: a re-attempt that rebuilt
 * the write would restamp `laneStalledSince` and hand the row a fresh day.
 */
export type OutboxStallWrite = {
  id: string;
  attemptCount: number;
  nextAttemptAtMs: number;
  reason: string;
  /** The ISO instant this row's current unbroken lane-wide run began. */
  laneStalledSince: string;
};

/** A stall write in flight, kept beside the write that produced it. */
type PendingStallWrite = {
  write: OutboxStallWrite;
  confirmed: Promise<boolean>;
};

/** The service state and collaborators this fold drives. */
export type LaneStallFoldDeps = {
  nextRetryAfterMs: Map<string, number>;
  clearFailureStateForId: (id: string) => void;
  markDeadLettered: (
    id: string,
    recoverable: boolean,
    reason: string,
    attemptCount: number
  ) => void;
  dequeue: (syncMode: AgentSessionSyncMode, ids: string[]) => void;
  /**
   * The durable defer write, ACKNOWLEDGED: resolves `true` only once the row
   * committed, `false` when it did not. Never rejects — a caller that had to
   * catch could not tell a refusal from a crash. `laneStalledSince` is what
   * survives the relaunch the in-memory map does not, so unlike the
   * row-attributable folds' fire-and-forget `recordOutboxRetry` this one reports:
   * see {@link confirmStallClockWrites} for what a dropped write costs.
   */
  recordOutboxStall: (input: OutboxStallWrite) => Promise<boolean>;
  /**
   * ISS-9418: stamp this LANE's durable give-up on its `sync_state` lane-run row.
   *
   * Called ALONGSIDE the per-row dead-letter, never instead of it. The dead-
   * letter is what releases the watermark and is already correct; this names the
   * lane-level fact it has always implied — that the world has been broken for a
   * day — so the give-up has a bound an operator can observe and a recovery door
   * that is reachable rather than implicit.
   *
   * Fire-and-forget: the row dead-letter is the terminal path this lane actually
   * takes, so a dropped stamp costs the lane-level name, never the row.
   *
   * `gaveUpAtMs` is what this fold NOTICED, not necessarily what gets written:
   * the writer anchors to the give-up already on record. See the call site.
   *
   * PLN-2028 (ISS-9963): `reason` is the CAUSE recorded beside it, the same one
   * this fold already derives for its telemetry. Without it the column carries an
   * instant alone, so the process that RESUMES this give-up announces it with no
   * cause at all — on the only channel a give-up is ever observed.
   */
  noteLaneGiveUp: (gaveUpAtMs: number, reason: SyncReason) => void;
  queueSizes: () => {
    incremental: number;
    backfill: number;
    deadLettered: number;
  };
  logWarn: (message: string) => void;
  logInfo: (message: string) => void;
  formatBytes: (bytes: number) => string;
};

/**
 * How long `id` has been in its current lane-wide run, and when it started, or
 * `null` when the map is saturated and this id is not tracked yet.
 *
 * An id ALREADY tracked is always returned — the cap gates admission only, so no
 * live clock can be evicted and restarted. See {@link MAX_TRACKED_LANE_STALLS}.
 */
function stallWindowFor(
  id: string,
  stalledSinceMsById: Map<string, number>,
  nowMs: number
): { startedAtMs: number; elapsedMs: number } | null {
  const trackedStartMs = stalledSinceMsById.get(id);
  if (trackedStartMs !== undefined) {
    return { startedAtMs: trackedStartMs, elapsedMs: nowMs - trackedStartMs };
  }
  if (stalledSinceMsById.size >= MAX_TRACKED_LANE_STALLS) {
    return null;
  }
  stalledSinceMsById.set(id, nowMs);
  return { startedAtMs: nowMs, elapsedMs: 0 };
}

/** Classify one id as wall-clock-expired vs still deferring, applying its effects. */
function foldOneId(
  id: string,
  config: LaneStallFoldConfig,
  deps: LaneStallFoldDeps,
  nowMs: number,
  pendingWrites: PendingStallWrite[]
): FoldOneIdOutcome {
  const { attemptsById, stalledSinceMsById } = config;
  const policy = SESSION_ENVIRONMENTAL_DEFER_POLICY[config.deferClass];
  const attemptCount = (attemptsById.get(id) ?? 0) + 1;
  const stallWindow = stallWindowFor(id, stalledSinceMsById, nowMs);
  if (stallWindow === null) {
    // Saturated: defer exactly as a tracked row does, minus the durable stall
    // write. Omitting that write is deliberate — stamping `nowMs` would publish
    // a start this fold did not observe, and would overwrite a genuine older
    // stamp already on the row (the case a resume that hit the cap leaves
    // behind). The row keeps retrying and is admitted once a slot frees.
    //
    // ISS-8610: and the ladder opens at the class FLOOR here, because a `null`
    // run origin opens a window at `nowMs`. That is the honest rung — this fold
    // has no clock for the row, and reading a rung off a run it cannot see would
    // be a delay derived from nothing.
    attemptsById.set(id, attemptCount);
    const untrackedDelayMs = laneStallDelayMs({
      stalledSinceMs: null,
      nowMs,
      schedule: policy.schedule,
      retryAfterMs: config.retryAfterMs,
    });
    deps.nextRetryAfterMs.set(id, nowMs + untrackedDelayMs);
    return { outcome: "untracked", deferredForMs: untrackedDelayMs };
  }
  const { startedAtMs } = stallWindow;
  // ISS-8615: the wall-clock arm of the shared budget table. This lane keeps its
  // own map and its own durable column — the SHAPE is what is shared, not the
  // state — but the give-up comparison itself now has one home, which is what
  // lets `sync-retry-budget.ts` claim to be the only spelling of it.
  const ceilingReached = isSyncRetryBudgetSpent(
    {
      kind: SyncRetryBudgetKind.WallClock,
      ceilingMs: SESSION_LANE_STALL_CEILING_MS,
    },
    { attemptCount, originMs: startedAtMs, nowMs }
  );
  if (ceilingReached) {
    // `clearFailureStateForId` drops the stall clock with every other per-class
    // budget, so a recovered row starts a fresh run rather than inheriting an
    // already-expired one and dead-lettering on its first post-recovery failure.
    deps.clearFailureStateForId(id);
    // RECOVERABLE, always. The wall clock says the world stayed broken for a
    // day, never that these bytes are bad, so the row keeps its FEA-3363
    // retry-after door and is re-driven rather than abandoned.
    deps.markDeadLettered(id, true, policy.deadLetterReason, attemptCount);
    return { outcome: "deadLettered", deferredForMs: null };
  }
  attemptsById.set(id, attemptCount);
  // ISS-8610: the rung is read off the run this row is already in, so a row
  // resumed from a 3-hour-old `lane_stalled_since` picks up at the rung its run
  // earned rather than restarting at the floor. The helper also caps the delay
  // by what is left of the ceiling while budget remains, so a defer issued late
  // in a run can no longer be scheduled past the give-up instant.
  const deferredForMs = laneStallDelayMs({
    stalledSinceMs: startedAtMs,
    nowMs,
    schedule: policy.schedule,
    retryAfterMs: config.retryAfterMs,
  });
  const nextAttemptAtMs = nowMs + deferredForMs;
  deps.nextRetryAfterMs.set(id, nextAttemptAtMs);
  const write: OutboxStallWrite = {
    id,
    attemptCount,
    nextAttemptAtMs,
    reason: policy.retryReason,
    laneStalledSince: new Date(startedAtMs).toISOString(),
  };
  pendingWrites.push({ write, confirmed: deps.recordOutboxStall(write) });
  return { outcome: "deferred", deferredForMs };
}

/**
 * Confirm every durable stall write this fold issued, re-issuing the ones that
 * did not land — with the SAME write object, so the anchor is the run's original
 * start and not the instant of the re-attempt.
 *
 * A dropped write here is not a lost diagnostic hint, which is what makes this
 * the one durable write on the rejection side that is acknowledged rather than
 * fire-and-forget. The clock it stamps is the ONLY terminal path an
 * environmental class has (its counters are tallies — see the file header), and
 * `loadPendingSessionOutboxEngineState` selects on `attempt_count > 0`, so a row whose
 * write never committed is invisible to the resume: the next launch finds no
 * run in progress and stamps a NEW start. A desktop restarting inside a long
 * outage would then cycle forever and never reach {@link
 * LaneStallFoldDeps.markDeadLettered} — an unbounded stall that looks like a
 * healthy backoff. Re-stamping the clock on the re-attempt would be the same
 * defect with a durable column to hide behind.
 *
 * A write still unconfirmed after the re-attempt keeps its in-memory clock (so
 * this process still terminates the row) and is named on the monitored warn
 * path; the next defer, 30s or 5m later, re-issues the same anchor.
 */
async function confirmStallClockWrites(
  pending: readonly PendingStallWrite[],
  deps: LaneStallFoldDeps
): Promise<void> {
  if (pending.length === 0) {
    return;
  }
  const landed = await Promise.all(
    pending.map(async (entry) => {
      if (await entry.confirmed) {
        return true;
      }
      return deps.recordOutboxStall(entry.write);
    })
  );
  const unconfirmed = pending
    .filter((_entry, index) => !landed[index])
    .map((entry) => entry.write.id);
  if (unconfirmed.length === 0) {
    return;
  }
  deps.logWarn(
    `the durable lane-stall clock did not commit for ${unconfirmed.length} session(s) even after a re-attempt; ` +
      `their ${Math.round(SESSION_LANE_STALL_CEILING_MS / 3_600_000)}h ceiling is in-memory only until a later defer lands, ` +
      `so a relaunch before then restarts it; ids: ${unconfirmed.join(", ")}`
  );
}

/**
 * Defer every id with its retry budget intact (invariant 4), dead-lettering only
 * those whose durable stall clock has passed the ceiling (invariant 5). Every
 * in-memory effect is applied synchronously; the returned promise settles once
 * the durable stall clocks are confirmed (see {@link confirmStallClockWrites}),
 * which is what the ack path awaits before it calls the batch handled.
 */
export async function applyLaneStallFold(
  config: LaneStallFoldConfig,
  deps: LaneStallFoldDeps
): Promise<void> {
  const { ids, syncMode, payloadBytes } = config;
  const policy = SESSION_ENVIRONMENTAL_DEFER_POLICY[config.deferClass];
  const nowMs = Date.now();
  const deadLettered: string[] = [];
  const deferred: string[] = [];
  const pendingWrites: PendingStallWrite[] = [];
  let untrackedCount = 0;
  // ISS-9418: the age of the longest run this fold gave up on, for the give-up
  // event. Read BEFORE the fold: a dead-letter clears the row's stall clock
  // along with every other per-class budget, so afterwards there is nothing left
  // to measure and the event would report a fabricated zero on the one signal
  // that says how long this install has been unable to deliver.
  let gaveUpAfterMs = 0;
  // ISS-8610: the delays this fold actually scheduled. One batch can carry rows
  // at different rungs — a resumed row and a fresh one — so the deferral log has
  // to report what was chosen rather than a single policy constant.
  const deferredForMs: number[] = [];
  for (const id of ids) {
    const stalledSinceMs = config.stalledSinceMsById.get(id);
    const folded = foldOneId(id, config, deps, nowMs, pendingWrites);
    if (folded.outcome === "deadLettered") {
      deadLettered.push(id);
      if (stalledSinceMs !== undefined) {
        gaveUpAfterMs = Math.max(gaveUpAfterMs, nowMs - stalledSinceMs);
      }
      continue;
    }
    if (folded.outcome === "untracked") {
      untrackedCount += 1;
    }
    // An untracked row IS deferred — it just carries no clock yet — so it
    // belongs in the deferral log alongside the tracked ones.
    deferred.push(id);
    if (folded.deferredForMs !== null) {
      deferredForMs.push(folded.deferredForMs);
    }
  }
  const bytes = deps.formatBytes(payloadBytes);
  if (untrackedCount > 0) {
    deps.logWarn(
      `lane-stall clock map is at its ${MAX_TRACKED_LANE_STALLS}-session cap; ` +
        `${untrackedCount} session(s) in this batch defer WITHOUT a stall clock and cannot ` +
        "reach the 24h ceiling until a tracked run ends and frees a slot (their durable " +
        "lane_stalled_since is left untouched, not restarted)"
    );
  }
  if (deadLettered.length > 0) {
    // ISS-9418: at least one row crossed the 24h environmental ceiling, which is
    // the lane-level fact "the world has been broken for a day". Reported ONCE
    // per fold, not per id: the give-up belongs to the lane, not to whichever
    // row happened to notice.
    //
    // `nowMs` is this fold's reading and NOT necessarily the value written. This
    // lane's clocks are PER ROW, so through a long outage the rows added at
    // different times run out at different real instants and fold again and
    // again — change-detection alone would let every one of those slide the
    // column forward, so `SessionLaneRun.noteRowCeilingGiveUp` anchors to the
    // give-up already on record and a later fold writes nothing.
    deps.noteLaneGiveUp(nowMs, syncReasonForAckReason(policy.retryReason));
    deps.dequeue(syncMode, deadLettered);
    const sizes = deps.queueSizes();
    // ISS-9418: and SAY SO on the monitored path. A give-up has no user-facing
    // surface by explicit decision (PLN-1961 D-a), so this event is the only way
    // anybody learns this lane stopped delivering - the dead-letter rows below
    // are a per-row record an operator has to already be looking for.
    //
    // Once per GIVE-UP, not once per fold. This lane's clocks are per ROW, so a
    // prolonged outage folds again and again as each staggered clock runs out;
    // `reportSyncLaneGaveUp` latches on the lane for exactly that reason, and the
    // matching `sync.lane.rearmed` is what releases it.
    //
    // `itemsOwed` counts what is STILL QUEUED after the dequeue above, never the
    // dead-lettered rows: those are recorded and re-drivable through the
    // FEA-3795 window, and counting them here would report abandoned work as
    // owed work on the event an operator reads as a loss. They are reported as
    // their own dimension instead, under the name the sibling stall event
    // already uses for the same quantity - a remainder alone reads as "nothing
    // left the queue" when N sessions just did.
    //
    // The message says this lane KEEPS ATTEMPTING - this ceiling dead-letters the
    // expired rows and terminates nothing lane-wide, so every other row keeps
    // deferring on `policy.schedule`, unlike the component sweep where the
    // give-up IS the terminal. Derived inside the reporter from the (lane,
    // producer) pair and not asserted here: it is a property of this PRODUCER's
    // architecture (its clocks are per row), so passing the sentence would let a
    // producer claim the opposite of what it does and nothing would disagree.
    reportSyncLaneGaveUp({
      lane: SyncLane.SessionMetadata,
      reason: syncReasonForAckReason(policy.retryReason),
      source: laneGiveUpSourceFor(
        SyncLane.SessionMetadata,
        LaneGiveUpSource.RowCeiling
      ),
      stalledForMs: gaveUpAfterMs,
      itemsOwed: sizes.incremental + sizes.backfill,
      deadLetteredCount: deadLettered.length,
    });
    deps.logWarn(
      `dead-lettered ${deadLettered.length} agent session(s) after ${Math.round(SESSION_LANE_STALL_CEILING_MS / 3_600_000)}h ` +
        `of unbroken lane-wide ${policy.retryReason} rejections (payload ~${bytes}); ids: ${deadLettered.join(", ")}; ` +
        `remaining incremental=${sizes.incremental} backfill=${sizes.backfill} deadLettered=${sizes.deadLettered}`
    );
  }
  if (deferred.length > 0) {
    // Reduced rather than spread into `Math.max`: a backfill batch can carry
    // more ids than an argument list should.
    const oldestStallMs = deferred.reduce(
      (longest, id) =>
        Math.max(longest, nowMs - (config.stalledSinceMsById.get(id) ?? nowMs)),
      0
    );
    deps.logInfo(
      `agent-session batch (${syncMode}, ~${bytes}) ${policy.deferLabel}; ` +
        `deferring ${deferred.length} session(s) for ${formatDeferSpanSeconds(deferredForMs)} ` +
        `with retry budgets intact (stalled ${Math.round(oldestStallMs / 1000)}s of a ` +
        `${Math.round(SESSION_LANE_STALL_CEILING_MS / 1000)}s ceiling); batch left queued for retry`
    );
  }
  await confirmStallClockWrites(pendingWrites, deps);
}

/** What {@link foldOneId} decided about one id, and the wait it scheduled. */
type FoldOneIdOutcome = {
  outcome: "deadLettered" | "deferred" | "untracked";
  /** The delay actually scheduled, or `null` for a dead-letter (no next attempt). */
  deferredForMs: number | null;
};

/**
 * ISS-8610: how the deferral log names the wait it is actually taking.
 *
 * The delay is now read off each row's own run clock, so one batch can carry
 * rows at different rungs — a row resumed from a long run and a freshly-stalled
 * one defer for different lengths. Printing one policy number would state a wait
 * most of the batch is not taking, which is the defect this whole fold's header
 * warns about in the other direction.
 *
 * Reduced rather than spread into `Math.min`/`Math.max`: a backfill batch can
 * carry more ids than an argument list should.
 */
function formatDeferSpanSeconds(delaysMs: readonly number[]): string {
  if (delaysMs.length === 0) {
    return "0s";
  }
  let shortestMs = Number.POSITIVE_INFINITY;
  let longestMs = 0;
  for (const delayMs of delaysMs) {
    shortestMs = Math.min(shortestMs, delayMs);
    longestMs = Math.max(longestMs, delayMs);
  }
  const shortestSeconds = Math.round(shortestMs / 1000);
  const longestSeconds = Math.round(longestMs / 1000);
  if (shortestSeconds === longestSeconds) {
    return `${shortestSeconds}s`;
  }
  return `${shortestSeconds}-${longestSeconds}s`;
}
