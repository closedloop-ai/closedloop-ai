/**
 * @file sync-burndown-gauges.ts
 * @description ISS-9246 — promote the ISS-5387 device-side sync burn-down from
 * `gatewayLog` to telemetry.
 *
 * ## What this signal covers, and what it does not
 *
 * COVERS: how much each desktop→cloud sync lane still owes the cloud, and how
 * old the oldest owed item is — backlog DEPTH and backlog AGE, per lane, per
 * install. That is a property of what has NOT arrived, so no cloud query can
 * answer it: the cloud holds only what has. This is the only vantage point from
 * which the number exists at all.
 *
 * DOES NOT COVER, and this is the load-bearing half: **these figures are
 * DEVICE-REPORTED and therefore subject to the device's own clock.**
 * {@link SyncBurndownGaugeName.OldestPendingAgeMs} is `now - pending_since` with
 * both terms read on the same machine, so it is immune to server skew but
 * exposed to a clock STEP on that machine — a device whose clock jumps forward
 * reports an age that never elapsed, and one that jumps back reports an age
 * clamped at 0 (`ageMsFrom` floors at zero rather than emitting a negative).
 *
 * That is exactly the axis on which it differs from the shipped
 * `session.ingestion.*` pair
 * (`apps/api/app/cron/sample-session-ingestion-health/service.ts`), whose two
 * timestamps are BOTH server-stamped inside the accepted-batch transaction and
 * are therefore single-clock and skew-proof. The two are complements, not
 * substitutes, and neither replaces the other:
 *
 * - `session.ingestion.*` answers "is this fleet's data still LANDING?" — trustworthy
 *   about arrival, blind to depth.
 * - these gauges answer "how much is still OWED, and how old is it?" — the only
 *   answer to depth, trusted only as far as the reporting device's clock.
 *
 * ISS-9246 also settles what must NOT be built from this: there is no cloud-side
 * gauge over `session_updated_at` vs `last_synced_at`, because that predicate
 * subtracts a device clock from a server clock and its sign is dominated by
 * propagation delay rather than backlog (measured in prod: the reverse
 * comparison matched 30,249 of 30,249 rows, `equal = 0`).
 *
 * ## Absent is not zero
 *
 * A figure this install did not MEASURE is not recorded at all. A `0` on any of
 * these gauges is a measurement — "this lane owes nothing", "this lane holds no
 * dead letters" — never a placeholder for "nobody looked". Each guard below says
 * which unmeasured case it is refusing to fabricate.
 *
 * ## Absence only means "unmeasured" because the gauges export DELTA
 *
 * Under the SDK's default CUMULATIVE temporality a gauge series that stops being
 * recorded is carried forward and re-exported at its LAST value rather than
 * going absent, so "record nothing" would publish a stale REAL number instead of
 * nothing: a lane that reported three dead letters and then lost its source key
 * would keep reporting three for the life of the process.
 * `desktop-metric-temporality.ts` therefore selects DELTA for GAUGE on the
 * desktop metric exporters — invisible on the wire, because OTLP's `Gauge`
 * message carries no temporality field at all — which is what makes an
 * unrecorded series genuinely absent. Every guard below rests on that.
 *
 * The drain case still records an explicit `0` rather than falling silent: under
 * DELTA, silence reads as "not measured", and a drained lane DID measure — it
 * counted its queue and found nothing owed.
 */

import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import {
  SyncBurndownGaugeName,
  SyncBurndownGaugeSchema,
} from "@closedloop-ai/telemetry-contract/sync";
import { metrics } from "@opentelemetry/api";
import {
  isLaneMeasured,
  laneMeasuredAnEmptyQueue,
  laneMeasuresOldestPendingAge,
  type SyncBurndownSnapshot,
  type SyncLaneBurndown,
} from "../../shared/sync-burndown-contract.js";
import { SYNC_METER_NAME } from "./sync-batch-counter.js";

/**
 * Description and unit per gauge, as an exhaustive `Record` so a gauge added to
 * {@link SyncBurndownGaugeName} fails `tsc` here instead of shipping nameless.
 */
const GAUGE_META: Record<
  SyncBurndownGaugeName,
  { description: string; unit: string }
> = {
  [SyncBurndownGaugeName.ItemsRemaining]: {
    description:
      "Items a desktop sync lane still owes the cloud, counted with the lane's own pending predicate. A measured 0 means drained; a capped probe reports a FLOOR, so read '>= N', never '= N'.",
    unit: "{item}",
  },
  [SyncBurndownGaugeName.OldestPendingAgeMs]: {
    description:
      "Age of the oldest item a desktop sync lane still owes, on the DEVICE's own clock. Not comparable with the server-stamped session.ingestion.* pair.",
    unit: "ms",
  },
  [SyncBurndownGaugeName.DeadLettered]: {
    description:
      "Items a desktop sync lane is holding in an abandoned state at this sample. Not a cumulative loss tally — it decreases when a lane re-pends.",
    unit: "{item}",
  },
};

/**
 * Record one burn-down sample.
 *
 * Best-effort by construction: observing a lane must never throw into the
 * reporter that produced the snapshot, for the same reason
 * {@link recordSyncBatchOutcome} swallows — the burn-down is an OBSERVER and a
 * lane's behaviour must be byte-identical whether or not it is watched.
 */
export function recordSyncBurndownSample(snapshot: SyncBurndownSnapshot): void {
  for (const lane of snapshot.lanes) {
    recordLaneBurndown(lane);
  }
}

function recordLaneBurndown(lane: SyncLaneBurndown): void {
  try {
    // The lane's dead-letter population was never read, so its `0` is a
    // placeholder and the row is refused rather than published with one figure
    // silently fabricated.
    //
    // ISS-10082 narrowed what this predicate is EVIDENCE of, and left a known
    // gap here rather than widening the refusal. It reads `deadLetteredBasis`,
    // which is `unmeasured` on ISS-8768's never-promoted branch too — where the
    // remainder beside it IS a real bounded count. So an unpaired install's
    // genuine template backlog reaches no gauge. That is a pre-existing
    // ISS-9246 shortfall, not a regression, and widening it to the new
    // `lane.remainderBasis` would start publishing a series for a population
    // whose dead letters are still unread; which way that should go is a
    // telemetry decision with its own ticket. The guards below already refuse a
    // `null` remainder on their own.
    if (!isLaneMeasured(lane)) {
      return;
    }
    const attributes = SyncBurndownGaugeSchema.parse({
      [TelemetryAttribute.SyncLane]: lane.lane,
    });

    // `null` here means the store never queried this lane's queue (ISS-10082),
    // which is not a drained queue. A 0 would claim it looked and found nothing.
    if (lane.itemsRemaining !== null) {
      recordGauge(
        SyncBurndownGaugeName.ItemsRemaining,
        lane.itemsRemaining,
        attributes
      );
    }

    const oldestPendingAgeMs = measuredOldestPendingAgeMs(lane);
    if (oldestPendingAgeMs !== null) {
      recordGauge(
        SyncBurndownGaugeName.OldestPendingAgeMs,
        oldestPendingAgeMs,
        attributes
      );
    }

    // Unconditional past the measurement guard: every remaining basis is a real
    // answer, `no_dead_letter_state` included — that lane structurally cannot
    // dead-letter, so its `0` is as true a measurement as a counted one.
    recordGauge(
      SyncBurndownGaugeName.DeadLettered,
      lane.deadLetteredCount,
      attributes
    );
  } catch {
    // Best-effort: the burn-down never participates in the lanes it observes.
  }
}

/**
 * The oldest-pending age this sample actually MEASURED, or `null` when it did
 * not measure one.
 *
 * The snapshot's own `oldestPendingAgeMs` is `null` for two different facts, and
 * only one of them is unmeasured. A lane that counted its queue and found it
 * EMPTY has genuinely measured "nothing is owed", and its backlog age is a real
 * 0 — saying so out loud is what distinguishes a drain from a lane that went
 * unread, now that an unrecorded series is genuinely absent. A lane that could
 * not classify some of its rows has not measured an empty queue, so its 0 would
 * be a fabrication, and a timestamp that would not parse is unknown rather than
 * new.
 *
 * The "counted its queue and found nothing owed" half is
 * {@link laneMeasuredAnEmptyQueue}, shared rather than re-derived here: the
 * operator log line renders the same fact as `none`, and two copies of a
 * three-term predicate is the drift this repo tracks.
 */
function measuredOldestPendingAgeMs(lane: SyncLaneBurndown): number | null {
  if (!laneMeasuresOldestPendingAge(lane)) {
    return null;
  }
  if (lane.oldestPendingAgeMs !== null) {
    return lane.oldestPendingAgeMs;
  }
  return laneMeasuredAnEmptyQueue(lane) ? 0 : null;
}

function recordGauge(
  name: SyncBurndownGaugeName,
  value: number,
  attributes: Record<string, string>
): void {
  const meta = GAUGE_META[name];
  // Resolved per call rather than cached at module scope, for the reason
  // `sync-batch-counter.ts` gives: a gauge captured from a retired
  // MeterProvider silently drops every later record, and the suite runs more
  // than one runtime in sequence.
  metrics
    .getMeter(SYNC_METER_NAME)
    .createGauge(name, {
      description: meta.description,
      unit: meta.unit,
    })
    .record(value, attributes);
}
