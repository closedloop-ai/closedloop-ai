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
import { beforeEach, describe, expect, it, vi } from "vitest";

const emitTelemetryMetric = vi.fn();

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: (metric: unknown) => emitTelemetryMetric(metric),
}));

import { ActivityTilingSkipReason } from "./activity-segment-persistence";
import type { UpsertSessionSliceResult } from "./session-slice-result";
import { SessionSyncMetric } from "./session-sync-metrics";
import { createStatusFoldTally } from "./status-fold-telemetry";

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
    persisted: true,
    unmodelledStatus: null,
    droppedContradictorySessionEnd: false,
    observedRepositoryFullNames: [],
    indexKeyProjections: 0,
    ...overrides,
  };
}

describe("createStatusFoldTally — never-throw contract (ISS-5981)", () => {
  // ISS-7556: `emitTelemetryMetric` is file-scoped and neither
  // `vitest.config.mts` nor `__tests__/setup.ts` resets mocks, so these tests
  // would otherwise share one call log — the first test's negative held only
  // because `emitFoldCount` returns early on a zero count, and swapping the two
  // blocks reds it. `mockReset`, not `mockClear`: only reset also drops the
  // queued `mockImplementationOnce`, so a throwing emitter cannot leak forward.
  beforeEach(() => {
    emitTelemetryMetric.mockReset();
  });

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
    expect(emitTelemetryMetric).toHaveBeenCalledTimes(1);
  });
});

describe("createStatusFoldTally — contradictory session ends (ISS-8552)", () => {
  beforeEach(() => {
    emitTelemetryMetric.mockReset();
  });

  it("emits ONE batch count carrying every slice that dropped an end", () => {
    const tally = createStatusFoldTally();
    tally.record(buildOutcome({ droppedContradictorySessionEnd: true }));
    tally.record(buildOutcome({ droppedContradictorySessionEnd: false }));
    tally.record(buildOutcome({ droppedContradictorySessionEnd: true }));

    tally.emit(CONTEXT);

    // The count, not merely the metric name: a per-slice emission (the
    // amplification `apps/api/AGENTS.md` forbids) would produce two calls of
    // count 1, and a tally that counted every slice would report 3.
    expect(emitTelemetryMetric).toHaveBeenCalledTimes(1);
    expect(emitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.ContradictorySessionEndDropped,
        computeTargetId: CONTEXT.computeTargetId,
        count: 2,
      })
    );
  });

  // The metric measures a draining population, so a clean batch must be silent
  // rather than reporting a zero that turns it into a traffic counter.
  it("stays silent when no slice dropped an end", () => {
    const tally = createStatusFoldTally();
    tally.record(buildOutcome({ droppedContradictorySessionEnd: false }));

    tally.emit(CONTEXT);

    expect(emitTelemetryMetric).not.toHaveBeenCalled();
  });

  // The two refusals are independent: a batch can fold an unmodelled spelling
  // WITHOUT dropping an end (the row was terminal, so max-wins kept it), and one
  // counter must not stand in for the other.
  it("keeps the ingest refusals on separate counters", () => {
    const tally = createStatusFoldTally();
    tally.record(
      buildOutcome({
        unmodelledStatus: "brand-new-status",
        droppedContradictorySessionEnd: false,
      })
    );

    tally.emit(CONTEXT);

    expect(emitTelemetryMetric).toHaveBeenCalledTimes(1);
    expect(emitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.UnmodelledStatusFolded,
      })
    );
  });

  // Same never-throw contract the unmodelled field carries, for the same reason:
  // `emit` runs from the caller's `finally` ahead of the ingest watermark
  // stamps, and an outcome shape without this field must read as "nothing was
  // dropped" rather than take those stamps down.
  it("tolerates an outcome that omits the field entirely", () => {
    const tally = createStatusFoldTally();
    const partial = buildOutcome({ droppedContradictorySessionEnd: true });
    Reflect.deleteProperty(partial, "droppedContradictorySessionEnd");

    expect(() => tally.record(partial)).not.toThrow();
    expect(() => tally.emit(CONTEXT)).not.toThrow();
    expect(emitTelemetryMetric).not.toHaveBeenCalled();
  });
});

describe("createStatusFoldTally — dropped createdAt (ISS-12251)", () => {
  beforeEach(() => {
    emitTelemetryMetric.mockReset();
  });

  it("emits ONE batch count carrying every slice that dropped a createdAt", () => {
    const tally = createStatusFoldTally();
    tally.record(buildOutcome({ droppedImplausibleCreatedAt: true }));
    tally.record(buildOutcome({ droppedImplausibleCreatedAt: false }));
    tally.record(buildOutcome({ droppedImplausibleCreatedAt: true }));
    tally.record(buildOutcome());

    tally.emit(CONTEXT);

    expect(emitTelemetryMetric).toHaveBeenCalledTimes(1);
    expect(emitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.ImplausibleCreatedAtDropped,
        computeTargetId: CONTEXT.computeTargetId,
        count: 2,
      })
    );
  });
});

describe("createStatusFoldTally — tiling slice refusals (ISS-8603)", () => {
  beforeEach(() => {
    emitTelemetryMetric.mockReset();
  });

  // The metric is documented as additive so a monitor reading `sum(count)` sees
  // the batch total. Replace the accumulator with a constant 1 and this is the
  // assertion that reds.
  it("SUMS same-reason refusals into ONE emission per batch", () => {
    const tally = createStatusFoldTally();
    tally.record(
      buildOutcome({
        activityTilingSkipReason: ActivityTilingSkipReason.VersionMismatch,
      })
    );
    tally.record(buildOutcome({ activityTilingSkipReason: null }));
    tally.record(
      buildOutcome({
        activityTilingSkipReason: ActivityTilingSkipReason.VersionMismatch,
      })
    );

    tally.emit(CONTEXT);

    expect(emitTelemetryMetric).toHaveBeenCalledTimes(1);
    expect(emitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.ActivityTilingSliceRefused,
        reason: "version_mismatch",
        count: 2,
      })
    );
  });

  // A draining population, like its siblings: a zero on either reason would turn
  // the metric into a sync-traffic counter and a `value > 0` monitor into a page.
  it("stays silent when no slice was refused", () => {
    const tally = createStatusFoldTally();
    tally.record(buildOutcome({ activityTilingSkipReason: null }));

    tally.emit(CONTEXT);

    expect(emitTelemetryMetric).not.toHaveBeenCalled();
  });

  // whitlockk, #7101. The recorder guarded with `in`, which walks the prototype
  // chain: a reason spelled for an `Object.prototype` member passed the guard
  // and `++` opened that name as an own key. The reason must be DROPPED, exactly
  // as `"not_a_reason"` is below — the block promises to ignore what it does not
  // model, and a member of the base prototype is no more modelled than any other
  // unrecognized spelling.
  it("drops a reason that names an Object.prototype member", () => {
    const tally = createStatusFoldTally();
    for (const inherited of ["toString", "constructor", "valueOf"]) {
      tally.record(
        buildOutcome({
          activityTilingSkipReason: inherited as ActivityTilingSkipReason,
        })
      );
    }

    expect(() => tally.emit(CONTEXT)).not.toThrow();
    expect(emitTelemetryMetric).not.toHaveBeenCalled();
  });

  // The SECOND half of that defect, and the half a "the reason is absent"
  // assertion leaves unpinned: `++` on an inherited member yields NaN, and the
  // emission gate reads `count <= 0`, which NaN does not satisfy. The metric
  // therefore carried a count that is not a measurement at all. A real refusal
  // shares the batch so this cannot pass vacuously over an empty call log.
  it("never emits a count that is not a positive whole measurement", () => {
    const tally = createStatusFoldTally();
    tally.record(
      buildOutcome({
        activityTilingSkipReason: ActivityTilingSkipReason.VersionMismatch,
      })
    );
    tally.record(
      buildOutcome({
        activityTilingSkipReason: "toString" as ActivityTilingSkipReason,
      })
    );

    tally.emit(CONTEXT);

    const emittedCounts: unknown[] = emitTelemetryMetric.mock.calls.map(
      (call) => call[0].count
    );
    expect(emittedCounts).toEqual([1]);
    for (const count of emittedCounts) {
      expect(Number.isInteger(count)).toBe(true);
      expect(count).toBeGreaterThan(0);
    }
  });

  // Same never-throw contract as the fields beside it, for the same reason: this
  // runs from the batch `finally` ahead of the ingest watermark stamps. An
  // unrecognized reason is dropped rather than opened as a key no monitor knows.
  it("tolerates an omitted field and an unmodelled reason", () => {
    const tally = createStatusFoldTally();
    const partial = buildOutcome();
    Reflect.deleteProperty(partial, "activityTilingSkipReason");
    const bogus = buildOutcome({
      activityTilingSkipReason: "not_a_reason" as ActivityTilingSkipReason,
    });

    expect(() => {
      tally.record(partial);
      tally.record(bogus);
    }).not.toThrow();
    expect(() => tally.emit(CONTEXT)).not.toThrow();
    expect(emitTelemetryMetric).not.toHaveBeenCalled();
  });
});
