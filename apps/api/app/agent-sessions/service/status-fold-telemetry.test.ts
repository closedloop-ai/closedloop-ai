/**
 * ISS-5981: the batch status-fold tally's NEVER-THROW contract.
 *
 * `emit` runs from the caller's `finally`, AHEAD of the ingest watermark stamps
 * (`upsert-sessions-batch.ts`). A throw anywhere in this module therefore skips
 * those stamps — leaving the org readable as QUIET — and replaces whatever real
 * ingest error was already unwinding. The module says so; nothing pinned it.
 *
 * That gap was not theoretical: adding the unmodelled-spelling sample (#5047)
 * introduced a `.slice()` on a field a partial outcome does not carry, and it
 * was caught only incidentally, by unrelated suites whose fixtures happen to be
 * partial. These drive the contract directly so the next such change reds here.
 */
import { describe, expect, it, vi } from "vitest";

const emitTelemetryMetric = vi.fn();

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: (metric: unknown) => emitTelemetryMetric(metric),
}));

import { SessionSyncMetric } from "./session-sync-metrics";
import { createStatusFoldTally } from "./status-fold-telemetry";
import type { UpsertSessionSliceResult } from "./upsert-session-slice";

const CONTEXT = {
  organizationId: "org-1",
  userId: "user-1",
  computeTargetId: "target-1",
};

/** A slice outcome with only the fields a caller is guaranteed to set. */
function buildOutcome(
  overrides: Partial<UpsertSessionSliceResult> = {}
): UpsertSessionSliceResult {
  return {
    loopBacklink: null,
    persisted: true,
    unmodelledStatus: null,
    ...overrides,
  };
}

describe("createStatusFoldTally — never-throw contract (ISS-5981)", () => {
  it("tolerates an outcome that omits the unmodelled field entirely", () => {
    const tally = createStatusFoldTally();
    // The shape a partial fixture — or an older outcome — actually produces.
    const partial = buildOutcome();
    Reflect.deleteProperty(partial, "unmodelledStatus");

    expect(() => tally.record(partial)).not.toThrow();
    expect(() => tally.emit(CONTEXT)).not.toThrow();
    expect(emitTelemetryMetric).not.toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.UnmodelledStatusFolded,
      })
    );
  });

  it("does not throw when the emitter itself throws", () => {
    // The guard exists so a telemetry outage cannot take the watermark stamps
    // down with it. Asserting the emit was ATTEMPTED first, so this cannot pass
    // by silently emitting nothing.
    emitTelemetryMetric.mockImplementationOnce(() => {
      throw new Error("datadog unavailable");
    });
    const tally = createStatusFoldTally();
    tally.record(buildOutcome({ unmodelledStatus: "brand-new-status" }));

    expect(() => tally.emit(CONTEXT)).not.toThrow();
    expect(emitTelemetryMetric).toHaveBeenCalled();
  });
});
