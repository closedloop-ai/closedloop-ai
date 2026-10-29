/**
 * @file sync-lane-give-up-telemetry.ts
 * @description ISS-9418 (PLN-1961 section 4) - the operator's ONLY view of a
 * lane give-up: the `sync.lane.gave_up` / `sync.lane.rearmed` pair, plus the
 * once-per-transition cadence that keeps a 5-second tick from reporting one
 * give-up thousands of times.
 *
 * ## Why this is the whole channel
 *
 * A give-up deliberately does NOT surface to the user - no badge, no settings
 * row, no notification (PLN-1961 D-a). These lanes are background collection the
 * user never asked for, and the condition self-heals on the next sign-in,
 * org-policy change, machine switch, or backoff window. The consequence to hold
 * onto is that telemetry is the only way anybody learns a lane stopped trying,
 * so a dimension an operator needs and this event omits is not a cosmetic gap.
 *
 * ## Why it is not `Observability.storeIntegrityResult`
 *
 * That method owns a four-state cadence machine over `storeIntegrityState`, and
 * `desktop-sync-lane-composition.ts` already refuses to fold lane stalls into
 * it: feeding an unrelated condition through those transitions would make the
 * next healthy SQLite probe report `recovered` from a failure that was never its
 * own. This rides the public `Observability.getTelemetryEmitter` seam - a new
 * category on the existing pipeline, not a new sink - and carries its own small
 * cadence, which is the same split `sync-lane-stall-telemetry.ts` made.
 *
 * ## The cadence, and why the gate cannot supply it
 *
 * `LaneEnvironmentalDeferGate.isGivenUp` and `.reArmTrigger` are deliberately
 * PURE READS that do not clear the stamp - the one attempt a re-arm buys belongs
 * to the outcome of that attempt, not to whoever happened to ask. So neither can
 * be used as an edge trigger, and a given-up lane is asked on every tick. The
 * latch below is what supplies the edge: one `gave_up` per give-up, one
 * `rearmed` per recovery, whatever the tick rate.
 *
 * The latch is keyed by lane, so it is bounded by construction - the key space
 * is the closed {@link SyncLane} set and cannot grow with input, the same shape
 * `sync-lane-stall-clock-telemetry.ts` uses for its anomaly kinds. It is
 * module-level rather than per-lane-instance because the session lane's edges
 * are reached from two different modules (the ceiling fold notices the give-up;
 * the outbox writers both RESUME one on hydration and see the clear), and
 * threading one instance between them would mean a new dependency through three
 * files and the grandfathered sync service.
 *
 * Latching on ACCEPTANCE and never on the attempt, for the reason
 * `telemetry-delivery-readiness.ts` gives: the lane drops silently when its send
 * gate is shut, so a latch set on the attempt would be burned by an event that
 * provably reached nothing, and the resulting silence reads as "this lane never
 * gave up".
 *
 * ISS-9418 note, because latching on acceptance is only half of that argument:
 * an unlatched announcement is worth nothing unless SOMEBODY calls again, and
 * the send gate here (`isHttpReady()` plus a known compute target) is shut by
 * exactly the sustained connectivity loss that drove the lane past its 24h
 * ceiling in the first place. So a give-up is announced from every tick that
 * still holds - `ComponentLaneGiveUp.holdTick` for the component sweep, and for
 * the session lane each staggered per-row fold plus every environmental outcome
 * its gate folds - and the latch is what makes those repeats free. A one-shot caller would report nothing at all for the one
 * outage class this event exists to surface. Both lanes announce from ONE more
 * place, which is not a repeat: hydration, where a process that relaunched
 * inside the outage resumes a give-up it never saw happen and would otherwise
 * hold it, and its recovery, in silence.
 *
 * Content-free by construction: a lane id, a closed reason, a duration and a
 * count. No session ids, source keys, paths, or payload bodies - those stay in
 * the desktop-local diagnostic line, where an operator on that machine can act
 * on them.
 */

import {
  LaneGiveUpSource,
  SyncLane,
  type SyncReason,
} from "@closedloop-ai/telemetry-contract/sync";
import { LaneReArmTrigger } from "../../shared/lane-give-up.js";
import { buildDesktopClientVersionTrace } from "./desktop-client-version.js";
import { Observability } from "./observability.js";
import type {
  SyncLaneGiveUpDiagnostics,
  SyncLaneReArmDiagnostics,
} from "./sync-lane-give-up-diagnostics.js";
import { canDeliverTelemetry } from "./telemetry-delivery-readiness.js";

/** What a lane knows at the instant it gives up. */
export type SyncLaneGaveUpTelemetryInput = {
  lane: SyncLane;
  /**
   * The ENVIRONMENTAL cause it kept failing on, or `null` when the producer is
   * holding a give-up whose cause it cannot say. Since PLN-2028 the durable row
   * RECORDS the cause, so a relaunch inside the outage announces the real one -
   * this stays `null` for a row that predates migration 0091 or names a
   * `SyncReason` this build does not know.
   *
   * OMITTED on the wire rather than filled in. `SyncReason` has no member
   * meaning "unknown", and spending this slot on a member that means something
   * else sends an operator after a precondition that was never the problem - the
   * same argument {@link stalledForMs} makes for refusing a fabricated `0`.
   */
  reason: SyncReason | null;
  /**
   * PLN-2028 (ISS-10043): WHICH producer wrote this give-up, or `null` when the
   * lane has none to name - a resumed give-up off a row written before migration
   * 0091 records no producer.
   *
   * Passed rather than derived, unlike the SHAPE it selects: it is the same fact
   * the producer persists, and no other module can know it. What it must never
   * be is a claim about what the give-up MEANS - {@link LANE_GIVE_UP_SHAPE}
   * decides that from the (lane, producer) pair, so a producer cannot tell an
   * operator the opposite of what its lane does.
   */
  source: LaneGiveUpSource | null;
  /**
   * How long its unbroken environmental run had been open, or `null` when the
   * producer cannot measure it. OMITTED on the wire rather than zeroed: a `0`
   * here renders as a lane that gave up instantly, on the one field that says
   * how long an outage has been running.
   */
  stalledForMs: number | null;
  /**
   * Items still owed, or `null` both for a lane that keeps no queue and for a
   * producer that cannot read one - a give-up RESUMED from the durable stamp
   * holds an instant and no queue reading. `null` is OMITTED on the wire rather
   * than sent as a zero - see the field's own note in
   * `sync-lane-give-up-diagnostics.ts` - and WHICH absence it is comes from the
   * lane ({@link LANE_ITEM_QUEUE}), so no producer has to assert it.
   */
  itemsOwed: number | null;
  /**
   * Items this ceiling ABANDONED to the dead-letter ledger, or `null` for a lane
   * that keeps no queue to abandon from. Separate from {@link itemsOwed}, which
   * counts what is still queued AFTER the abandonment: an operator reading only
   * the remainder concludes nothing left the queue.
   */
  deadLetteredCount: number | null;
};

/** What a lane knows at the instant a give-up ends. */
export type SyncLaneReArmedTelemetryInput = {
  lane: SyncLane;
  /**
   * Which door opened, or `null` when the give-up ended without one - a lane
   * whose server ANSWERED is reachable again on stronger evidence than either
   * door provides, and naming a door there would assert the distinction this
   * field exists to keep.
   */
  trigger: LaneReArmTrigger | null;
  /** How long the lane had been given up, or `null` when unmeasured. */
  gaveUpForMs: number | null;
};

/**
 * Lanes whose give-up this process has ANNOUNCED and not yet answered with a
 * re-arm. Bounded by construction: the key space is the closed {@link SyncLane}
 * set, so it cannot grow with input.
 */
const ANNOUNCED_GIVE_UPS = new Set<SyncLane>();

/**
 * Report that `lane` gave up - once per give-up, however many ticks ask.
 *
 * A repeat call for a lane already announced is a no-op, which is what makes the
 * caller free to announce from every environmental outcome rather than having to
 * detect the edge itself. The latch is released by
 * {@link reportSyncLaneReArmed}, so a lane that gives up again after a re-arm is
 * a NEW transition and does emit.
 */
export function reportSyncLaneGaveUp(
  input: SyncLaneGaveUpTelemetryInput
): void {
  if (ANNOUNCED_GIVE_UPS.has(input.lane)) {
    return;
  }
  Observability.getTelemetryEmitter().emit({
    severity: "error",
    category: "sync.lane.gave_up",
    message: describeGiveUp(input),
    diagnostics: { syncLaneGaveUp: buildGiveUpDiagnostics(input) },
    trace: buildDesktopClientVersionTrace(),
  });
  if (canDeliverTelemetry()) {
    ANNOUNCED_GIVE_UPS.add(input.lane);
  }
}

/**
 * Report that a given-up `lane` may attempt again - once per recovery.
 *
 * Silent for a lane whose give-up was never announced: a `rearmed` with no
 * `gave_up` before it would read as a recovery from a condition the operator was
 * never told about, and the caller cannot know whether the announcement landed.
 * That is also why this releases the latch BEFORE the emit rather than after: if
 * the recovered half is dropped at a shut send gate the give-up half is the one
 * worth keeping repeatable, and holding the latch would suppress the NEXT
 * give-up instead.
 */
export function reportSyncLaneReArmed(
  input: SyncLaneReArmedTelemetryInput
): void {
  if (!ANNOUNCED_GIVE_UPS.delete(input.lane)) {
    return;
  }
  Observability.getTelemetryEmitter().emit({
    severity: "info",
    category: "sync.lane.rearmed",
    message: describeReArm(input),
    diagnostics: { syncLaneReArmed: buildReArmDiagnostics(input) },
    trace: buildDesktopClientVersionTrace(),
  });
}

/**
 * Forget what was announced for `lane` WITHOUT reporting a recovery - an
 * identity switch or a lane shutdown.
 *
 * The give-up belonged to a different (lane, compute target) pair, so there is
 * nothing to recover and a `rearmed` here would claim the previous account's
 * outage ended. Dropping the latch is still required: without it the new
 * identity's first genuine give-up would be swallowed as a duplicate.
 */
export function clearSyncLaneGiveUpAnnouncement(lane: SyncLane): void {
  ANNOUNCED_GIVE_UPS.delete(lane);
}

function buildGiveUpDiagnostics(
  input: SyncLaneGaveUpTelemetryInput
): SyncLaneGiveUpDiagnostics {
  const diagnostics: SyncLaneGiveUpDiagnostics = { lane: input.lane };
  // OMITTED for a give-up this process RESUMED rather than measured. There is no
  // `SyncReason` meaning "unknown", and the receiving vocabulary already folds a
  // value it does not recognise onto an `unknown` bucket - so inventing a
  // producer-side spelling for it would only add a second name for that bucket
  // while asserting a cause nobody observed.
  if (input.reason !== null) {
    diagnostics.reason = input.reason;
  }
  // OMITTED and never defaulted, for the reason the cause above is: a give-up
  // resumed off a pre-0091 row has no producer ON RECORD, and naming one would
  // attribute a terminal lane-wide state to a producer nobody observed.
  if (input.source !== null) {
    diagnostics.source = input.source;
  }
  // OMITTED and never `?? 0`, for the reason {@link wholeCount} exists at all: a
  // `0` on THIS field renders as a lane that gave up instantly, which is a
  // fabricated measurement on the one signal that says how long an install has
  // been unable to deliver. An override here would make the guard a no-op for
  // the only field it was written to protect.
  const stalledForMs = wholeCount(input.stalledForMs);
  if (stalledForMs !== null) {
    diagnostics.stalledForMs = stalledForMs;
  }
  const itemsOwed = wholeCount(input.itemsOwed);
  if (itemsOwed !== null) {
    diagnostics.itemsOwed = itemsOwed;
  }
  const deadLetteredCount = wholeCount(input.deadLetteredCount);
  if (deadLetteredCount !== null) {
    diagnostics.deadLetteredCount = deadLetteredCount;
  }
  return diagnostics;
}

function buildReArmDiagnostics(
  input: SyncLaneReArmedTelemetryInput
): SyncLaneReArmDiagnostics {
  const diagnostics: SyncLaneReArmDiagnostics = { lane: input.lane };
  if (input.trigger !== null) {
    diagnostics.trigger = input.trigger;
  }
  const gaveUpForMs = wholeCount(input.gaveUpForMs);
  if (gaveUpForMs !== null) {
    diagnostics.gaveUpForMs = gaveUpForMs;
  }
  return diagnostics;
}

/**
 * A non-negative whole number inside the exactly-representable integer range, or
 * `null` for anything that is not a measurement.
 *
 * The cloud mirror validates every numeric field here as
 * `z.number().int().nonnegative()`, and that schema STRIPS the whole diagnostics
 * object on a value it rejects - so a fractional millisecond from a
 * high-resolution clock, a negative from a backwards clock step, or a `NaN` from
 * an arithmetic hole would take the lane and the reason down with it. Refusing
 * the field is the honest degradation; refusing the event is not.
 *
 * A negative is REFUSED and not clamped. Clamping it would satisfy the validator
 * with a `0`, and a `0` is a measurement - "no time passed" - so the clamp would
 * launder a broken clock into a confident instant-give-up reading that the
 * validator on the other side then has no way to reject. Rounding a FRACTION is
 * different in kind and stays: a sub-millisecond remainder is noise on a
 * duration measured in hours, not a value that says something false.
 *
 * A MAGNITUDE past `Number.MAX_SAFE_INTEGER` is refused for a reason none of the
 * three above covers, and it is the one that gets WRITTEN: `Number.MAX_VALUE` is
 * finite, non-negative and survives `Math.round`, and `Number.isInteger` reports
 * true for it, so the cloud mirror's `.int().nonnegative()` accepts it too and it
 * renders as a confident measurement. Past this bound a double no longer holds
 * consecutive integers, so such a value cannot be an exact count of items or of
 * milliseconds whatever produced it believed - which makes it the same fabricated
 * reading as the `0` above, arriving from the other end of the range.
 */
function wholeCount(value: number | null): number | null {
  if (
    value === null ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    return null;
  }
  return Math.round(value);
}

/**
 * A duration an operator reads at a glance. Coarse on purpose: the exact
 * millisecond is in the diagnostics, and this sentence is about whether to open
 * the runbook.
 *
 * A value that is not a measurement SAYS SO rather than reading as `0min`. The
 * prose is the half of this event an operator actually reads, so laundering a
 * refused duration into a number here would undo the omission
 * {@link buildGiveUpDiagnostics} just made on the wire.
 */
function describeElapsed(ms: number | null): string {
  const safeMs = wholeCount(ms);
  if (safeMs === null) {
    return "an UNMEASURED interval";
  }
  if (safeMs < 7_200_000) {
    return `${Math.round(safeMs / 60_000)}min`;
  }
  if (safeMs < 172_800_000) {
    return `${Math.round(safeMs / 3_600_000)}h`;
  }
  return `${Math.round(safeMs / 86_400_000)}d`;
}

/** How many items the lane still owed, or which KIND of absence that is. */
function describeItemsOwed(lane: SyncLane, itemsOwed: number | null): string {
  const owed = wholeCount(itemsOwed);
  if (owed !== null) {
    return `${owed} item(s) still owed and uncharged`;
  }
  if (LANE_ITEM_QUEUE[lane] === LaneItemQueue.None) {
    // Printing "0 item(s) still owed" for a lane with no queue invites the
    // reader to treat a structural absence as a measurement that could have been
    // non-zero - and on THIS event that reads as "nothing was lost".
    return "this lane keeps no item queue, so nothing is owed to count";
  }
  // And saying THAT for a lane whose queue is real is the same sentence lying in
  // the other direction: the absence is a count this producer could not take,
  // not a queue that does not exist.
  return "how many items are still owed is UNMEASURED";
}

/**
 * What this ceiling ABANDONED, when the lane keeps a queue to abandon from.
 *
 * The one fact that actually changed at a session-lane ceiling, and absent from
 * {@link describeItemsOwed}, which counts what is still queued AFTERWARDS - so a
 * reader given only the remainder concludes nothing left the queue.
 */
function describeAbandoned(deadLetteredCount: number | null): string {
  const abandoned = wholeCount(deadLetteredCount);
  if (abandoned === null) {
    return "";
  }
  return `, ${abandoned} ABANDONED to the dead-letter ledger at this ceiling and re-drivable from it`;
}

function describeGiveUp(input: SyncLaneGaveUpTelemetryInput): string {
  const opening = `Sync lane ${input.lane} GAVE UP after ${describeElapsed(input.stalledForMs)} of unbroken environmental failure (${describeCause(input.reason)})`;
  const ledger = `(${describeItemsOwed(input.lane, input.itemsOwed)}${describeAbandoned(input.deadLetteredCount)})`;
  const charging =
    "Nothing was charged to any item: an environmental give-up is not item-attributable.";
  const shape = laneGiveUpShape(input.lane, input.source);
  if (shape === LaneGiveUpShape.Terminal) {
    return `${opening} and has stopped attempting ${ledger}. Local data is not reaching the cloud and this lane is no longer trying; it resumes only when a recovery door opens - a precondition change (sign-in, org policy, compute target) or the widening retry window. ${charging}`;
  }
  if (shape === LaneGiveUpShape.Ceiling) {
    return `${opening} ${ledger}. Local data is not reaching the cloud. This lane KEEPS ATTEMPTING on its ordinary retry cadence - the ceiling abandoned the rows whose own clocks expired and terminates nothing lane-wide, so there is no recovery door to wait for. ${charging}`;
  }
  return `${opening} ${ledger}. Local data is not reaching the cloud. Whether this lane STOPPED ATTEMPTING or only abandoned the rows past their own ceiling is UNCLASSIFIED for it - ${describeUnclassified(input.source)}, so treat the scope as unknown. ${charging}`;
}

/**
 * WHY a give-up's scope could not be classified - and the two cases ask
 * different things of the reader.
 *
 * Only ONE of them is a wiring defect. A give-up with no producer AT ALL came off
 * a durable row that records none - written before the producer column, or naming
 * a producer this build does not know - and nothing was mis-wired, so sending an
 * operator to look for a missing {@link LANE_GIVE_UP_SHAPE} entry spends the one
 * signal this event is on a search that ends nowhere (marisolashgrove review). A
 * NAMED producer landing here is that entry genuinely missing.
 */
function describeUnclassified(source: LaneGiveUpSource | null): string {
  if (source === null) {
    return "the give-up names no producer, because the durable row it was resumed from could not supply one";
  }
  return `no shape has been classified for this lane's ${source} producer`;
}

/**
 * The recovery line, in three shapes because the operator action differs. An
 * `event` says the thing that was broken changed, so a failure after it is a NEW
 * problem; a `window` says only that time passed, so a failure after it is the
 * SAME problem and the lane will widen again; no door at all says the server
 * answered, which is the strongest evidence of the three and needs no follow-up.
 */
function describeReArm(input: SyncLaneReArmedTelemetryInput): string {
  // Decided by the SAME predicate the diagnostics field is, so an unmeasurable
  // value is absent from the prose and the wire together rather than reading as
  // an instant recovery in one of them.
  const gaveUpForMs = wholeCount(input.gaveUpForMs);
  const held =
    gaveUpForMs === null
      ? ""
      : ` after ${describeElapsed(gaveUpForMs)} given up`;
  if (input.trigger === null) {
    return `Sync lane ${input.lane} is collecting again${held}: its give-up cleared because the lane ANSWERED - the server was reachable enough to judge its bytes, so the world is demonstrably no longer the problem.`;
  }
  if (input.trigger === LaneReArmTrigger.Event) {
    return `Sync lane ${input.lane} RE-ARMED${held} because a precondition it was blocked on CHANGED (sign-in, org policy, or compute target). It gets exactly one attempt; a failure re-stamps the give-up immediately, and that failure would be a new problem rather than the old one.`;
  }
  return `Sync lane ${input.lane} RE-ARMED${held} because its widening retry window ELAPSED - nothing says the world is fixed, only that it is worth one more attempt. A failure re-stamps the give-up immediately and widens the window again.`;
}

/**
 * What a give-up MEANS for the lane that reported it.
 *
 * `Terminal` - the give-up is the lane's terminal state: the tick returns and
 * nothing is attempted until a recovery door opens. `Ceiling` - the give-up
 * abandoned the rows whose own clocks expired and terminates nothing lane-wide,
 * so the lane keeps attempting on its ordinary cadence. `Unclassified` - no
 * give-up producer has been wired for that lane yet, so nothing here may assert
 * either.
 */
const LaneGiveUpShape = {
  Terminal: "terminal",
  Ceiling: "ceiling",
  Unclassified: "unclassified",
} as const;

type LaneGiveUpShape = (typeof LaneGiveUpShape)[keyof typeof LaneGiveUpShape];

/**
 * Which shape each (lane, PRODUCER) pair's give-up has - DERIVED, never passed
 * in.
 *
 * PLN-2028 (ISS-10043) keyed this by producer as well as lane, and the session
 * lane is why. It has TWO producers making opposite claims about the same lane:
 * its environmental gate says the world has been broken for a day and the lane
 * is terminal, while its per-row ceiling abandons the rows whose own clocks
 * expired and terminates nothing lane-wide. Pinned to the lane alone, a gate
 * give-up announced "this lane KEEPS ATTEMPTING" - on the exact event that says
 * collection stopped.
 *
 * Still derived rather than threaded in as a boolean, which is the older half of
 * this argument: an answer a producer could set independently is one a producer
 * could get backwards, and nothing would disagree. What a producer passes is the
 * recorded PRODUCER, which is the same fact it persists.
 *
 * Exhaustive over both closed sets on purpose: a new lane, a third producer,
 * or a give-up producer wired for a pair that has none, fails `tsc` here until
 * somebody classifies it. Every unwired pair is `Unclassified` rather than
 * defaulted to a shape, because a default is exactly the silent answer this map
 * exists to refuse - whoever wires the producer names the shape in the same
 * change.
 */
const LANE_GIVE_UP_SHAPE: Record<
  SyncLane,
  Record<LaneGiveUpSource, LaneGiveUpShape>
> = {
  [SyncLane.ComponentInventory]: {
    [LaneGiveUpSource.EnvironmentalGate]: LaneGiveUpShape.Terminal,
    // This lane has no row queue at all, only a cursor position.
    [LaneGiveUpSource.RowCeiling]: LaneGiveUpShape.Unclassified,
  },
  [SyncLane.SessionMetadata]: {
    [LaneGiveUpSource.EnvironmentalGate]: LaneGiveUpShape.Terminal,
    [LaneGiveUpSource.RowCeiling]: LaneGiveUpShape.Ceiling,
  },
  [SyncLane.InvocationParts]: {
    [LaneGiveUpSource.EnvironmentalGate]: LaneGiveUpShape.Unclassified,
    [LaneGiveUpSource.RowCeiling]: LaneGiveUpShape.Unclassified,
  },
  [SyncLane.TranscriptArchive]: {
    [LaneGiveUpSource.EnvironmentalGate]: LaneGiveUpShape.Unclassified,
    [LaneGiveUpSource.RowCeiling]: LaneGiveUpShape.Unclassified,
  },
  [SyncLane.TraceComments]: {
    [LaneGiveUpSource.EnvironmentalGate]: LaneGiveUpShape.Unclassified,
    [LaneGiveUpSource.RowCeiling]: LaneGiveUpShape.Unclassified,
  },
};

/**
 * The shape to announce for a give-up whose producer is unknown.
 *
 * `Unclassified` and not the lane's usual one: a give-up resumed off a row
 * written before migration 0091 records no producer, and on a lane with two of
 * them the two shapes say opposite things. Guessing either would be the
 * confident wrong sentence this map exists to prevent, so the prose says the
 * scope is unknown, which is what the reader actually has.
 */
function laneGiveUpShape(
  lane: SyncLane,
  source: LaneGiveUpSource | null
): LaneGiveUpShape {
  return source === null
    ? LaneGiveUpShape.Unclassified
    : LANE_GIVE_UP_SHAPE[lane][source];
}

/**
 * Whether a lane HAS an item queue to owe from.
 *
 * It decides what an ABSENT `itemsOwed` MEANS, and the two readings are not
 * interchangeable. The component sweep holds only a cursor position, so "there
 * is no queue to count" is the truth for it. The session lane's outbox is real,
 * so an absence there is a count the producer could not take - the ordinary case
 * for a give-up RESUMED from the durable row, which records no queue depth and
 * never could. Telling an operator THAT lane keeps no item queue reads as
 * "nothing was lost" on the one event that says collection stopped.
 *
 * Derived from the lane and never passed in, for the reason
 * {@link LANE_GIVE_UP_SHAPE} is: it is a property of the lane's architecture, so
 * a producer allowed to assert it is a producer allowed to assert the opposite
 * of what its lane does.
 *
 * `Unclassified` for the lanes with no give-up producer, exactly as the
 * shape map leaves them, and it renders as the unmeasured reading rather than
 * the structural one - a lane nobody has classified must not be reported as
 * keeping nothing. Whoever wires a producer answers this in the same change.
 */
const LaneItemQueue = {
  Keeps: "keeps",
  None: "none",
  Unclassified: "unclassified",
} as const;

type LaneItemQueue = (typeof LaneItemQueue)[keyof typeof LaneItemQueue];

const LANE_ITEM_QUEUE: Record<SyncLane, LaneItemQueue> = {
  [SyncLane.ComponentInventory]: LaneItemQueue.None,
  [SyncLane.SessionMetadata]: LaneItemQueue.Keeps,
  [SyncLane.InvocationParts]: LaneItemQueue.Unclassified,
  [SyncLane.TranscriptArchive]: LaneItemQueue.Unclassified,
  [SyncLane.TraceComments]: LaneItemQueue.Unclassified,
};

/**
 * The cause, or an explicit "this process never saw it".
 *
 * Says so rather than reading as a cause, for the reason
 * {@link describeElapsed} says "an UNMEASURED interval": the prose is the half
 * an operator acts on, so laundering an absent cause into a plausible one here
 * would undo the omission {@link buildGiveUpDiagnostics} just made on the wire.
 */
function describeCause(reason: SyncReason | null): string {
  if (reason === null) {
    return "cause UNKNOWN - a give-up resumed from a durable row that could not supply one";
  }
  return reason;
}
