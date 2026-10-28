import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
} from "@repo/api/src/types/branch-metrics";
import {
  BranchPhaseAttributionCompleteness,
  BranchPhaseAttributionCompletenessReason,
  type BranchPhaseAttributionResult,
  BranchVisibleLifecyclePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import { describe, expect, it } from "vitest";
import {
  divisorlessPhaseAttributionSegment,
  phaseAttributionSegment,
  rollupTotalUsd,
  unreconciledPhaseAttributionSegment,
} from "./__tests__/branch-phase-attribution-fixture";
import { microCentsToUsd, usdToMicroCents } from "./activity-attribution";
import { calculateBranchDetailMetrics } from "./branch-detail-outcomes";

const START_MS = Date.parse("2026-08-01T10:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

describe("ISS-6949 Branch-detail cost reconciliation kernel", () => {
  it("does not reconcile an empty segment set against a priced branch", () => {
    // `hasCompleteBranchMetricEventCost` is vacuously true here, so the predicate
    // alone would call this reconciled. It is the ticket's own $0.00-vs-$174.04
    // reproduction.
    const metrics = metricsFor(attributionWithRollups(0, []), 174.04);

    expect(metrics.totalCostUsd).toEqual(completeMetric(174.04));
    expect(metrics.phaseCostUsd.build.state).toBe(
      BranchMetricAvailability.Partial
    );
  });

  it("does not reconcile when a segment carries no identified cost events", () => {
    const attribution = attributionWithRollups(10, [
      unreconciledPhaseAttributionSegment({
        sessionId: "s1",
        phase: BranchVisibleLifecyclePhase.Build,
        startMs: START_MS,
        endMs: START_MS + HOUR_MS,
        estimatedCostUsd: 10,
      }),
    ]);

    expect(metricsFor(attribution, 10).phaseCostUsd.build.state).toBe(
      BranchMetricAvailability.Partial
    );
  });

  it("does not reconcile when a segment carries no branch-count divisor", () => {
    // The divisor guard is a DIFFERENT arm of `hasCompleteBranchMetricEventCost`
    // than the empty-events one above; this fixture keeps the cost events so the
    // only thing that can fail is the missing divisor.
    const attribution = attributionWithRollups(10, [
      divisorlessPhaseAttributionSegment({
        sessionId: "s1",
        phase: BranchVisibleLifecyclePhase.Build,
        startMs: START_MS,
        endMs: START_MS + HOUR_MS,
        estimatedCostUsd: 10,
      }),
    ]);

    expect(attribution.segments[0]?.costEvents).toBeDefined();
    expect(attribution.segments[0]?.qualifyingBranchCount).toBeUndefined();
    expect(metricsFor(attribution, 10).phaseCostUsd.build.state).toBe(
      BranchMetricAvailability.Partial
    );
  });

  it("reconciles cross-pipeline quantization drift the reader cannot see", () => {
    // The rollup total is snapped to the micro-cent grid by the attribution
    // allocator; the attributed total is a raw float sum from a different table.
    // These pairs render identically, so they must NOT be reported as a mismatch.
    for (const [rawCostUsd, branchCount] of [
      [174.041_234_567_8, 1],
      [100.000_001, 3],
    ] as const) {
      const rollup = microCentsToUsd(
        Math.round(usdToMicroCents(rawCostUsd) / branchCount)
      );
      const attributed = rawCostUsd / branchCount;

      expect(rollup).not.toBe(attributed);
      expect(
        metricsFor(reconcilingAttribution(rollup, branchCount), attributed)
          .phaseCostUsd.build.state
      ).toBe(BranchMetricAvailability.Complete);
    }
  });

  it("does not reconcile a gap the reader can see", () => {
    // One rendered cent apart: $9.99 vs $10.00.
    expect(
      metricsFor(reconcilingAttribution(9.9949, 1), 9.995).phaseCostUsd.build
        .state
    ).toBe(BranchMetricAvailability.Partial);
  });

  it("does not star a healthy high-volume branch", () => {
    // 200 priced turns through the real quantization on one side and a raw float
    // sum on the other. Micro-cent equality fails here; display precision must
    // not, or every real card ships a permanent and false incompleteness marker.
    // Sub-micro-cent fractions, so the per-event `usdToMicroCents` rounding
    // actually loses something — a turn cost that is already an exact micro-cent
    // multiple would make this assertion vacuous.
    const turns = Array.from(
      { length: 200 },
      (_, index) => 0.013_123_456_7 + index * 1.7e-6
    );
    const rollup = microCentsToUsd(
      turns.reduce((total, cost) => total + usdToMicroCents(cost), 0)
    );
    const attributed = turns.reduce((total, cost) => total + cost, 0);

    expect(usdToMicroCents(rollup)).not.toBe(usdToMicroCents(attributed));
    expect(
      metricsFor(reconcilingAttribution(rollup, 1), attributed).phaseCostUsd
        .build.state
    ).toBe(BranchMetricAvailability.Complete);
  });
});

describe("ISS-6949 Branch-detail cost gates", () => {
  it.each([
    ["not-a-number", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["negative", -1],
  ])("declines a %s attributed cost", (_label, attributed) => {
    const metrics = metricsFor(attributionWithRollups(0, []), attributed);

    expect(metrics.totalCostUsd.state).toBe(
      BranchMetricAvailability.Unavailable
    );
    expect(metrics.phaseCostUsd.build.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });

  it("declines when the accumulated rollup total overflows", () => {
    // Each operand passes the per-rollup guard; only the sum is non-finite, and
    // an Infinity would make the display-precision comparison NaN and silently
    // never reconcile.
    const base = attributionWithRollups(0, []);
    const attribution: BranchPhaseAttributionResult = {
      ...base,
      rollups: base.rollups.map((rollup) => ({
        ...rollup,
        estimatedCostUsd: Number.MAX_VALUE,
      })),
    };

    expect(Number.MAX_VALUE * 3).toBe(Number.POSITIVE_INFINITY);
    expect(metricsFor(attribution, 24).totalCostUsd.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });

  it("declines a canonical priced zero over priced rows", () => {
    // Emitting complete(0) here would short-circuit the card into "No priced
    // spend recorded yet." and hide the $8 of phase spend it shows today.
    for (const zero of [0, -0]) {
      expect(
        metricsFor(reconcilingAttribution(8, 1), zero).totalCostUsd.state
      ).toBe(BranchMetricAvailability.Unavailable);
    }
  });

  it("declines a null attributed cost over priced rows", () => {
    expect(
      metricsFor(reconcilingAttribution(8, 1), null).totalCostUsd.state
    ).toBe(BranchMetricAvailability.Unavailable);
  });

  it.each([
    ["a canonical priced zero", 0],
    ["no attributed cost at all", null],
  ])("keeps a settled zero readable for %s", (_label, attributed) => {
    const metrics = metricsFor(attributionWithRollups(0, []), attributed);

    expect(metrics.totalCostUsd).toEqual(completeMetric(0));
    expect(metrics.phaseCostUsd.build).toEqual(completeMetric(0));
  });

  it.each([
    ["a canonical priced zero", 0],
    ["no attributed cost at all", null],
  ])(
    "keeps the header marker on a zero total when coverage is incomplete for %s",
    (_label, attributed) => {
      // At zero the card short-circuits before any row renders, so the header
      // marker is the only disclosure channel the surface has left.
      const attribution = partialCoverage(attributionWithRollups(0, []));
      const metrics = metricsFor(attribution, attributed);

      expect(metrics.totalCostUsd).toEqual(partialMetric(0));
    }
  );

  it("presents the attributed total when the rows over-attribute", () => {
    const metrics = metricsFor(reconcilingAttribution(24, 1), 8);

    expect(metrics.totalCostUsd).toEqual(completeMetric(8));
    expect(metrics.phaseCostUsd.build).toEqual(
      partialMetric(24, BranchMetricDisclosure.DefaultIncomplete)
    );
  });

  it("names the shortfall the rows actually have, not one sentence for both", () => {
    // tamsinb review (PR #7912): `CostIncomplete` asserts that activity with
    // unavailable cost was excluded. The amounts-disagree arm excludes no such
    // activity — every priced thing the rows are built from was priced, the sum
    // just does not match the canonical total — so it takes the cause-neutral
    // sentence instead. Both arms are pinned here because one disclosure for
    // both is exactly what the reader could not tell apart.
    const disagreeing = metricsFor(reconcilingAttribution(24, 1), 8);
    const unpriced = metricsFor(
      partialCoverage(reconcilingAttribution(24, 1)),
      8
    );

    expect(disagreeing.phaseCostUsd.build).toEqual(
      partialMetric(24, BranchMetricDisclosure.DefaultIncomplete)
    );
    expect(unpriced.phaseCostUsd.build).toEqual(
      partialMetric(24, BranchMetricDisclosure.CostIncomplete)
    );
  });

  it("keeps the existing decline when phase coverage is unavailable", () => {
    const attribution: BranchPhaseAttributionResult = {
      ...attributionWithRollups(0, []),
      coverage: {
        completeness: BranchPhaseAttributionCompleteness.Unavailable,
        reason:
          BranchPhaseAttributionCompletenessReason.MissingActivitySegments,
      },
    };

    expect(metricsFor(attribution, 24).totalCostUsd.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });
});

function metricsFor(
  phaseAttribution: BranchPhaseAttributionResult,
  attributedCostUsd: number | null
) {
  return calculateBranchDetailMetrics({
    attributedCostUsd,
    phaseAttribution,
    selectedCycle: null,
    selectedPrAdditions: 100,
    selectedPrDeletions: 0,
    selectedPrLocComplete: true,
  });
}

/** Build-only rollups with the given cost, plus whatever segments are supplied. */
function attributionWithRollups(
  buildCostUsd: number,
  segments: BranchPhaseAttributionResult["segments"]
): BranchPhaseAttributionResult {
  return {
    segments,
    rollups: Object.values(BranchVisibleLifecyclePhase).map((phase) => ({
      phase,
      estimatedCostUsd:
        phase === BranchVisibleLifecyclePhase.Build ? buildCostUsd : 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      durationMs: 0,
      sessionCount: segments.length,
    })),
    coverage: {
      completeness: BranchPhaseAttributionCompleteness.Complete,
      // Build is the only priced phase, so the rollup sum is buildCostUsd exactly.
      subtotalUsd: buildCostUsd,
    },
  };
}

/** An attribution whose own event evidence reconciles, totalling `costUsd`. */
function reconcilingAttribution(
  costUsd: number,
  branchCount: number
): BranchPhaseAttributionResult {
  return attributionWithRollups(costUsd, [
    phaseAttributionSegment({
      sessionId: "s1",
      phase: BranchVisibleLifecyclePhase.Build,
      startMs: START_MS,
      endMs: START_MS + HOUR_MS,
      estimatedCostUsd: costUsd,
      qualifyingBranchCount: branchCount,
    }),
  ]);
}

function partialCoverage(
  attribution: BranchPhaseAttributionResult
): BranchPhaseAttributionResult {
  return {
    ...attribution,
    coverage: {
      completeness: BranchPhaseAttributionCompleteness.Partial,
      reason: BranchPhaseAttributionCompletenessReason.AmbiguousEvidence,
      subtotalUsd: rollupTotalUsd(attribution),
    },
  };
}

function completeMetric(value: number) {
  return { state: BranchMetricAvailability.Complete, value };
}

function partialMetric(
  value: number,
  disclosure: BranchMetricDisclosure = BranchMetricDisclosure.CostIncomplete
) {
  return {
    state: BranchMetricAvailability.Partial,
    value,
    disclosure,
  };
}
