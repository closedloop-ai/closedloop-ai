/**
 * @file sync-lane-stall-telemetry.ts
 * @description ISS-5387 — emit the "a sync lane is working but not recording
 * progress" signal on the EXISTING desktop telemetry transport.
 *
 * ## Why it is not a method on `Observability`
 *
 * Two reasons, and both matter.
 *
 * 1. `Observability` sits at the 1,000-line ceiling (`noExcessiveLinesPerFile`)
 *    and is deliberately NOT grandfathered, so a new static there would have to
 *    displace an existing one.
 * 2. The obvious host, {@link Observability.storeIntegrityResult}, owns a
 *    four-state cadence machine over `storeIntegrityState`
 *    (detected/persistent/recovered/healthy). Feeding an unrelated condition
 *    into it would corrupt the SQLite probe's own transitions — the next healthy
 *    probe would report `recovered` from a failure that was never its own.
 *
 * So this rides the public {@link Observability.getTelemetryEmitter} escape
 * hatch, which is the same `TelemetryService` every other desktop signal goes
 * through. It is a new CATEGORY on an existing pipeline, not a new sink.
 *
 * ## Why a raw log would not be enough
 *
 * A lane whose durable cursor stops advancing keeps logging successful uploads —
 * ISS-5347 ran that way for three days behind 1,713 reassuring log lines, and
 * nothing in the lane raised a failure because, from the lane's point of view,
 * nothing failed. The condition is only visible by CORRELATION, so it needs a
 * monitored signal rather than a line someone might read.
 *
 * Content-free by construction: a lane id, a unit count, and an age. No session
 * ids, file paths, payload bodies, or credentials.
 */

import { SyncLaneStallKind } from "../../shared/sync-burndown-contract.js";
import { Observability } from "./observability.js";
import type { TelemetryTraceContext } from "./telemetry-protocol.js";

/** What the burn-down reporter knows about a stalled lane. */
export type SyncLaneStallTelemetryInput = {
  /** The lane id (`session_metadata`, `component_inventory`, …). */
  lane: string;
  /** Units the lane completed while the cursor did not move. */
  workCompletedSincePrevious: number;
  /** Age of the durable cursor's last write, or null when it never persisted one. */
  durableCursorAgeMs: number | null;
  /** Items this lane has abandoned, reported alongside so the alert is actionable. */
  deadLetteredCount: number;
  /**
   * ISS-5973: which stall this is. OPTIONAL, and an unrecognised value is
   * treated exactly like an absent one — both fall back to the cursor-frozen
   * wording. The alert is never dropped over a `kind` this build cannot read:
   * losing the signal is strictly worse than describing it imprecisely.
   */
  kind?: string;
  /** Items still owed when the stall was raised, where the lane counts a queue. */
  itemsRemaining?: number | null;
  /**
   * True when {@link itemsRemaining} is a FLOOR — the producing probe is bounded
   * and hit its cap. Absent means EXACT, which is the safe default for a
   * version-skewed producer that predates this field: a missing `>=` costs
   * precision, whereas defaulting to "lower bound" would decorate every exact
   * count with a qualifier it has not earned.
   */
  itemsRemainingIsLowerBound?: boolean;
};

function describeCursorAge(durableCursorAgeMs: number | null): string {
  if (durableCursorAgeMs === null) {
    // Never persisted at all — the `buildComponentCursorPersist(null)` case,
    // which is a different (and worse) failure than a merely stale write.
    return "never persisted";
  }
  return `${Math.round(durableCursorAgeMs / 1000)}s stale`;
}

/**
 * Report that `lane` completed work while its durable cursor stood still.
 *
 * Emission is rate-limited by the CALLER (the burn-down reporter reports a lane
 * once per stall episode and re-arms only after a genuine advance), so this
 * function stays a dumb emit with no cadence state of its own.
 */
export function reportSyncLaneStall(input: SyncLaneStallTelemetryInput): void {
  const trace: TelemetryTraceContext = {};
  Observability.getTelemetryEmitter().emit({
    severity: "error",
    category: "sync.durable_cursor.stalled",
    message: describeStall(input),
    trace,
  });
}

/**
 * ISS-5973: how many items the lane still owed, or an explicit "unknown".
 *
 * Never renders a fabricated `0` for an unmeasurable queue — a stall alert that
 * says "0 items remaining" reads as the opposite of the condition it reports.
 */
function describeItemsRemaining(
  itemsRemaining: number | null,
  isLowerBound: boolean
): string {
  if (itemsRemaining === null) {
    return "unknown";
  }
  // A bounded probe that capped out knows only "at least this many". Printing
  // the capped value bare is the same reassuring lie as a fabricated zero — a
  // 3,500-session backlog must not page as `200 item(s) still owed`.
  return isLowerBound ? `>=${itemsRemaining}` : String(itemsRemaining);
}

/**
 * ISS-5973: the alert line for whichever stall this is.
 *
 * `no_progress` is the only value that changes the wording. Anything else —
 * `cursor_frozen`, absent, or a value a newer build sends that this one has never
 * heard of — falls through to the original ISS-5387 sentence, which is the safe
 * default: it names the lane and the counts either way, so a skewed `kind` costs
 * precision, never the alert.
 */
function describeStall(input: SyncLaneStallTelemetryInput): string {
  if (input.kind === SyncLaneStallKind.NoProgress) {
    return `Sync lane ${input.lane} is running with ${describeItemsRemaining(input.itemsRemaining ?? null, input.itemsRemainingIsLowerBound ?? false)} item(s) still owed and completed 0 unit(s) across consecutive samples (${input.deadLetteredCount} dead-lettered). Local data is not reaching the cloud.`;
  }
  return `Sync lane ${input.lane} completed ${input.workCompletedSincePrevious} unit(s) with a durable cursor that did not advance (${describeCursorAge(input.durableCursorAgeMs)}, ${input.deadLetteredCount} dead-lettered)`;
}
