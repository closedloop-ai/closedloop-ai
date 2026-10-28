import { describe, expect, it } from "vitest";
import { CollectorTailSamplingPolicy } from "../collector-tail-sampling-policy";
import {
  AppTelemetryAttributes,
  SyncTelemetryAttributes,
  TelemetryAttribute,
} from "../src/attributes";
import {
  SyncMeasureRetention,
  SyncMeasureSampling,
} from "../src/sync-sampling-bias";
import { SyncBatchCounterSchema, SyncLane, SyncOutcome } from "../sync";

/**
 * Hand-listed rather than mapped from `SyncTelemetryAttributes`: the enumeration
 * IS the guard. A derived list agrees with the table by construction and would
 * stay green through a coordinated edit that drops an attribute from both. The
 * members are the canonical `TelemetryAttribute` references, not respelled
 * literals — independence is about not deriving the LIST, not about re-typing
 * values that already have an owner.
 */
const syncAttributeKeys = [
  TelemetryAttribute.SyncEvent,
  TelemetryAttribute.SyncOutcome,
  TelemetryAttribute.SyncPayloadBytes,
  TelemetryAttribute.SyncLatencyMs,
  TelemetryAttribute.SyncReason,
  TelemetryAttribute.SyncLane,
  TelemetryAttribute.SyncDeadLetteredCount,
  TelemetryAttribute.SyncBatchId,
  TelemetryAttribute.SyncSessionCount,
  TelemetryAttribute.SyncAttempt,
  TelemetryAttribute.SyncPayloadShaping,
  TelemetryAttribute.SyncTilingStrippedCount,
  TelemetryAttribute.SyncFreshestSessionLagMs,
  TelemetryAttribute.AppOrganizationId,
  TelemetryAttribute.AppOperatingMode,
];

function keysWithRetention(retention: string): string[] {
  return Object.entries(SyncMeasureSampling)
    .filter(([, entry]) => entry.retention === retention)
    .map(([key]) => key)
    .sort();
}

describe("sync measure sampling bias (ISS-7497)", () => {
  it("classifies every attribute the sync schema admits, and nothing else", () => {
    expect(Object.keys(SyncMeasureSampling).sort()).toEqual(
      [...syncAttributeKeys].sort()
    );
    // Second leg, against the schema group rather than the literal: a new sync
    // attribute reaches the wire through this array, so an attribute added there
    // and left unclassified must not be able to ship.
    expect(Object.keys(SyncMeasureSampling).sort()).toEqual(
      [...SyncTelemetryAttributes].sort()
    );
  });

  it("splits Complete from Sampled only while the baseline keeps some traces but not all", () => {
    // At 100 nothing is sampled and every biased entry in the table is a lie; at
    // 0 no successful batch reaches the backend at all and the Sampled entries
    // describe an empty population. The whole classification is meaningful only
    // strictly between.
    expect(
      CollectorTailSamplingPolicy.baselineSamplingPercentage
    ).toBeGreaterThan(0);
    expect(CollectorTailSamplingPolicy.baselineSamplingPercentage).toBeLessThan(
      100
    );
  });

  it("gives a successful sync batch no attribute of its own that any keep policy reads", () => {
    // The load-bearing fact behind every Mixed and Sampled row.
    // `keep-server-errors` is the only keep policy left that reads an
    // ATTRIBUTE — ISS-9254 moved `keep-slow` onto the trace's own duration — and
    // the sync group does not carry its key, so a success trips nothing of its
    // own. Add `http.response.status_code` to the sync group and this goes red,
    // which is correct: retention would have changed and the table would need
    // rewriting. What a success can still ride is its TRACE-MATES (an errored
    // sibling, a long window); that is the correlation the table describes and
    // no attribute list can rule out.
    const syncKeys: readonly string[] = SyncTelemetryAttributes;
    expect(syncKeys).not.toContain(
      CollectorTailSamplingPolicy.serverErrorAttributeKey
    );
    // Positive sibling, so the absence above cannot be satisfied by a renamed
    // or misspelled policy key that no group carries.
    const appKeys: readonly string[] = AppTelemetryAttributes;
    expect(appKeys).toContain(
      CollectorTailSamplingPolicy.serverErrorAttributeKey
    );
  });

  it("certifies as Complete only what a producer pins to an ERROR span, and freshness lag as Sampled", () => {
    // Pinned literals, not a derivation: this is the set a dashboard author is
    // entitled to trust, and widening it is exactly the edit that must not pass
    // review silently. `sync.reason` is admitted by the contract only as why a
    // batch failed; `sync.dead_lettered_count` is attached only on the
    // dead-letter arm in sync-lane-cloud-health.ts. Both spans set status ERROR.
    expect(keysWithRetention(SyncMeasureRetention.Complete)).toEqual([
      "sync.dead_lettered_count",
      "sync.reason",
    ]);
    // Emitted from one call site, spread into the accepted-ack Success event, so
    // it exists only on the span the baseline samples. This is the assertion the
    // 15-minute freshness alarm has to survive before it can be built.
    expect(keysWithRetention(SyncMeasureRetention.Sampled)).toEqual([
      "sync.freshest_session_lag_ms",
    ]);
    // The measure the ticket names as wrong stays classified as biased on the
    // SPAN: a span-derived success rate reads a whole numerator over a sampled
    // denominator. The counter is what makes the rate answerable, not this.
    expect(SyncMeasureSampling[TelemetryAttribute.SyncOutcome].retention).toBe(
      SyncMeasureRetention.Mixed
    );
  });

  it("keeps the counter's outcome required and its attribute set closed", () => {
    // Required, unlike on the span. An increment that cannot say which way the
    // batch went belongs to neither numerator nor denominator, so admitting one
    // would silently deflate the very rate this instrument exists to correct.
    expect(
      SyncBatchCounterSchema.safeParse({
        [TelemetryAttribute.SyncLane]: SyncLane.SessionMetadata,
      }).success
    ).toBe(false);
    // Positive sibling, so the rejection above cannot be a blanket one.
    expect(
      SyncBatchCounterSchema.safeParse({
        [TelemetryAttribute.SyncOutcome]: SyncOutcome.Success,
        [TelemetryAttribute.SyncLane]: SyncLane.SessionMetadata,
      }).success
    ).toBe(true);
    // Lane is optional: lane 1 emitted batches before ISS-6338 named lanes, and
    // a counter that rejected them would drop the oldest installs' rates.
    expect(
      SyncBatchCounterSchema.safeParse({
        [TelemetryAttribute.SyncOutcome]: SyncOutcome.DeadLetter,
      }).success
    ).toBe(true);
    // Closed: cardinality is a counter's cost, so a byte count or an id must not
    // be able to ride it in and multiply the time series.
    expect(
      SyncBatchCounterSchema.safeParse({
        [TelemetryAttribute.SyncOutcome]: SyncOutcome.Success,
        [TelemetryAttribute.SyncPayloadBytes]: 2048,
      }).success
    ).toBe(false);
  });
});
