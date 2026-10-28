/**
 * @file sync-lane-give-up-diagnostics.ts
 * @description ISS-9418 - the structured fields the `sync.lane.gave_up` /
 * `sync.lane.rearmed` pair carries, as fields a monitor can GROUP BY rather than
 * facts buried in prose.
 *
 * Its own module rather than two more members of `telemetry-protocol.ts`, which
 * is 1,231 physical lines against the 1,000-line `noExcessiveLinesPerFile`
 * ceiling and is deliberately NOT grandfathered. That file keeps the wire
 * envelope and the diagnostics union; the shape of one event family belongs
 * beside the family, the same split `db-host-telemetry-refusal-reason.ts` makes.
 *
 * The canonical cloud mirror is `syncLaneGaveUp` / `syncLaneReArmed` in
 * `@repo/observability/telemetry/schema`, which STRIPS unknown keys - so a field
 * added here and not added there never reaches the dashboard. Every value is a
 * count, a duration, or a closed enum: no session ids, source keys, file paths,
 * or payload bodies.
 */

import type {
  LaneGiveUpSource,
  SyncLane,
  SyncReason,
} from "@closedloop-ai/telemetry-contract/sync";
import type { LaneReArmTrigger } from "../../shared/lane-give-up.js";

/**
 * A lane that crossed its 24h environmental ceiling.
 *
 * What that COSTS is determined by the lane AND its PRODUCER, and PLN-2028 D7 is
 * why the producer is a field here: the component sweep's give-up is its
 * terminal state, and so is the session lane's environmental-gate give-up, while
 * the session lane's per-row ceiling terminates nothing lane-wide. Two of those
 * three live on one lane, so a monitor grouped by `lane` alone puts a terminal
 * outage and a routine row ceiling in the same bucket. The SHAPE is still
 * derived rather than passed (`LANE_GIVE_UP_SHAPE` in
 * `sync-lane-give-up-telemetry.ts`) - what the producer supplies is the
 * recorded fact, which is the same one it persists.
 */
export type SyncLaneGiveUpDiagnostics = {
  lane: SyncLane;
  /**
   * WHICH producer wrote this give-up (PLN-2028, ISS-10043).
   *
   * OPTIONAL and OMITTED rather than defaulted, for two different absences that
   * read the same here. A lane with only one producer has nothing to
   * disambiguate; and a give-up RESUMED from a row written before migration 0091
   * has no producer ON RECORD, so naming one would attribute a terminal state to
   * a producer nobody observed - the direction that holds a healthy lane.
   */
  source?: LaneGiveUpSource;
  /**
   * The ENVIRONMENTAL cause the lane kept failing on, never `lane_gave_up`
   * itself - the category already says the lane gave up, and spending this slot
   * on restating that would lose the only field that says WHY. A reason a
   * version-skewed producer names is folded onto the generic member by
   * `syncReasonForAckReason` rather than sent raw, because `sync.reason` is a
   * closed enum on the span side and an out-of-enum value is dropped, not
   * recorded.
   *
   * OPTIONAL and OMITTED for a give-up whose CAUSE the row could not supply.
   * Since PLN-2028 it usually can - `lane_gave_up_reason` is persisted beside the
   * stamp, so a relaunch inside an outage names the real cause - and what remains
   * is a row written before migration 0091, or one naming a `SyncReason` this
   * build does not know. `SyncReason` has no member meaning "unknown" and naming
   * one that means something else would send an operator after a precondition
   * that was never the problem. The absence reads as an absence, and the lane,
   * the duration and the counts still land.
   */
  reason?: SyncReason;
  /**
   * How long the lane's unbroken environmental run had been open when it gave
   * up. A DURATION and not the `stalledSinceMs` instant the gate holds: an epoch
   * from a machine whose clock may have stepped is not a measurement an operator
   * can act on, and every sibling field in this family (`durableCursorAgeMs`)
   * carries an age for that reason. Grows across a prolonged outage, because the
   * run origin is not reset by a re-give-up - so this is also "how long this
   * install has been unable to deliver".
   *
   * OPTIONAL and OMITTED - never zeroed - when the producer cannot measure it,
   * which is the whole point of the field. This is the load-bearing number on
   * the event, so a `0` from a backwards clock step or an arithmetic hole renders
   * as a lane that gave up INSTANTLY: the reassuring lie exactly where the
   * duration is the thing being reported. An absence reads as an absence and the
   * lane, the reason and the counts still land.
   */
  stalledForMs?: number;
  /**
   * Items the lane still owed at the give-up. OPTIONAL and OMITTED - never
   * zeroed - for a lane that keeps no queue at all: the component lane has only
   * a cursor position, so a `0` there would read as "nothing was owed" on the
   * exact event that says collection stopped. Omitted for a SECOND reason too:
   * a producer that cannot read the queue, which is the ordinary case for a
   * give-up resumed from the durable column. The two absences are identical here
   * and read differently in the prose, where `LANE_ITEM_QUEUE` in
   * `sync-lane-give-up-telemetry.ts` derives which one it is from `lane` - so a
   * monitor grouped by `lane` separates them without a second dimension to keep
   * in step. None of these items is charged; an environmental give-up is not
   * item-attributable (invariant 4).
   *
   * Counts what is still QUEUED after the ceiling, so it is not the count of
   * what the ceiling just gave up on - {@link deadLetteredCount} is.
   */
  itemsOwed?: number;
  /**
   * Items this ceiling ABANDONED to the dead-letter ledger, mirroring
   * `SyncLaneStallDiagnostics.deadLetteredCount` on the sibling stall event
   * rather than inventing a second name for the same quantity.
   *
   * OPTIONAL and OMITTED for a lane with no queue to abandon from. Carried
   * because it is the one fact the ceiling actually CHANGED: `itemsOwed` counts
   * the remainder afterwards, so an operator reading only that concludes nothing
   * left the queue while N sessions were moved out of it. Abandoned is not lost -
   * these rows stay re-drivable through the FEA-3795 window - but it is not
   * nothing either, and this is the only channel that could say so.
   */
  deadLetteredCount?: number;
};

/** A given-up lane that may attempt again. */
export type SyncLaneReArmDiagnostics = {
  lane: SyncLane;
  /**
   * WHICH recovery door opened. OPTIONAL and OMITTED rather than defaulted, for
   * the reason `deadLetteredBasis` is: a lane whose give-up ended because the
   * server ANSWERED did not come through a door at all, and naming one would
   * assert the precise thing this field exists to distinguish - `event` says a
   * blocked precondition genuinely changed, `window` says only that a retry
   * timer elapsed, and the two make different claims about whether the world is
   * fixed.
   */
  trigger?: LaneReArmTrigger;
  /**
   * How long the lane had been given up. OPTIONAL and OMITTED when the producer
   * does not hold the stamp, never zeroed: a `0` reads as "it recovered
   * instantly", which is the reassuring lie an outage measure exists to prevent.
   */
  gaveUpForMs?: number;
};
