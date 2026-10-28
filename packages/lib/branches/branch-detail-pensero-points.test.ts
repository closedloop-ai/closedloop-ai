import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
  BranchMetricPullRequestOutcome,
} from "@repo/api/src/types/branch-metrics";
import {
  BranchPhaseAttributionCompleteness,
  type BranchPhaseAttributionResult,
  BranchVisibleLifecyclePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import { describe, expect, it } from "vitest";
import {
  phaseAttributionSegment,
  rollupTotalUsd,
} from "./__tests__/branch-phase-attribution-fixture";
import {
  type BranchDetailMetricInput,
  calculateBranchDetailMetrics,
} from "./branch-detail-outcomes";
import { calculateDetailPenseroPointsPerDollar } from "./branch-detail-pensero-points";

/**
 * ISS-9814 — the Pensero points numerator on the canonical branch-detail ratio.
 *
 * The magnitudes are pinned as INDEPENDENT literals rather than re-derived from
 * the fixture: 100 lines and 40 points over the same $20 give 5 LOC/$ and
 * 2 pts/$, and a test that recomputed either from the inputs would pass for a
 * kernel that had swapped the denominator underneath it.
 */
const LIFETIME_LOC = 100;
const BRANCH_COST_USD = 20;
const PENSERO_POINTS = 40;
const EXPECTED_LOC_PER_DOLLAR = 5;
const EXPECTED_POINTS_PER_DOLLAR = 2;

describe("ISS-9814 branch-detail Pensero points per dollar", () => {
  it("pins the fixture the ratios are read against", () => {
    // The kernel reads the two selected-PR fields individually; this states the
    // lifetime LOC they sum to, so the LOC/$ expectation below is anchored to a
    // number rather than to whatever the fixture happens to hold.
    const input = baseInput();
    expect(
      (input.selectedPrAdditions ?? 0) + (input.selectedPrDeletions ?? 0)
    ).toBe(LIFETIME_LOC);
    expect(input.attributedCostUsd).toBe(BRANCH_COST_USD);
  });

  it("AC1: divides summed points by the same cost the LOC ratio uses", () => {
    const metrics = calculateBranchDetailMetrics(
      inputWith({
        points: PENSERO_POINTS,
        hasFailedAcquisitionDay: false,
        hasAmbiguousPoints: false,
        hasUnreadablePointValues: false,
      })
    );

    expect(metrics.penseroPointsPerDollar).toEqual({
      state: BranchMetricAvailability.Partial,
      value: EXPECTED_POINTS_PER_DOLLAR,
      disclosure: BranchMetricDisclosure.PenseroAcquisitionIncomplete,
    });
    // AC4: one population. The denominator is the branch's canonical attributed
    // cost, and BOTH ratios divide by it — so the two differ only in numerator.
    expect(metrics.totalCostUsd.value).toBe(BRANCH_COST_USD);
    expect(metrics.locPerDollar.value).toBe(EXPECTED_LOC_PER_DOLLAR);
  });

  it("AC3: a genuine zero-point population is a MEASURED 0, not unavailable", () => {
    const metrics = calculateBranchDetailMetrics(
      inputWith({
        points: 0,
        hasFailedAcquisitionDay: false,
        hasAmbiguousPoints: false,
        hasUnreadablePointValues: false,
      })
    );

    // The defect this guards is `0` being routed to the unavailable path by a
    // falsy or nullish test somewhere between the read and the render.
    expect(metrics.penseroPointsPerDollar).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 0,
      disclosure: BranchMetricDisclosure.PenseroAcquisitionIncomplete,
    });
    expect(metrics.penseroPointsPerDollar?.state).not.toBe(
      BranchMetricAvailability.Unavailable
    );
  });

  it("AC2: no Pensero numerator omits the field and leaves LOC/$ untouched", () => {
    // The EMPTY-table state: the org is in the rollout, the read ran, and no row
    // resolved to this branch. That must read as *no Pensero data* — a distinct
    // outcome from the measured zero above, which the previous case pins.
    const metrics = calculateBranchDetailMetrics(inputWith(null));

    expect(metrics.penseroPointsPerDollar).toBeUndefined();
    expect(metrics.locPerDollar.value).toBe(EXPECTED_LOC_PER_DOLLAR);
  });

  it("AC2: the whole bundle is byte-identical to a producer that never knew the field", () => {
    // The strongest form of "renders exactly as today": with no Pensero input,
    // every key of the bundle equals the one the pre-ISS-9814 kernel produced.
    const withoutField = calculateBranchDetailMetrics(baseInput());
    const withExplicitNull = calculateBranchDetailMetrics(inputWith(null));

    expect(withExplicitNull).toEqual(withoutField);
    expect(Object.hasOwn(withoutField, "penseroPointsPerDollar")).toBe(false);
  });

  it("ISS-9930 AC2/AC3: a failed acquisition day names itself and still publishes", () => {
    // Replaces the shipped "refuses to publish a rate whose evidence is short"
    // case, which the 2026-09-17 ruling obsoletes: withholding a number whose
    // points sum and cost are both present is the defect, not the safe default.
    const metrics = calculateBranchDetailMetrics(
      inputWith({
        points: PENSERO_POINTS,
        hasFailedAcquisitionDay: true,
        hasAmbiguousPoints: false,
        hasUnreadablePointValues: false,
      })
    );

    expect(metrics.penseroPointsPerDollar).toEqual({
      state: BranchMetricAvailability.Partial,
      value: EXPECTED_POINTS_PER_DOLLAR,
      disclosure: BranchMetricDisclosure.PenseroAcquisitionDaysFailed,
    });
  });

  // ISS-10608 AC3: all eight members, each reached by its own combination.
  // The expected member is written out per row rather than derived, so a
  // resolver that swapped or collapsed two combinations fails here.
  it.each([
    [false, false, false, BranchMetricDisclosure.PenseroAcquisitionIncomplete],
    [true, false, false, BranchMetricDisclosure.PenseroAcquisitionDaysFailed],
    [false, true, false, BranchMetricDisclosure.PenseroAttributionAmbiguous],
    [false, false, true, BranchMetricDisclosure.PenseroPointValuesUnreadable],
    [
      true,
      true,
      false,
      BranchMetricDisclosure.PenseroDaysFailedAndAttributionAmbiguous,
    ],
    [
      true,
      false,
      true,
      BranchMetricDisclosure.PenseroDaysFailedAndPointValuesUnreadable,
    ],
    [
      false,
      true,
      true,
      BranchMetricDisclosure.PenseroAttributionAmbiguousAndPointValuesUnreadable,
    ],
    [
      true,
      true,
      true,
      BranchMetricDisclosure.PenseroDaysFailedAttributionAmbiguousAndPointValuesUnreadable,
    ],
  ])(
    "ISS-10608: days=%s ambiguous=%s values=%s publishes the value with its own disclosure",
    (hasFailedAcquisitionDay, hasAmbiguousPoints, hasUnreadablePointValues, disclosure) => {
      const metrics = calculateBranchDetailMetrics(
        inputWith({
          points: PENSERO_POINTS,
          hasFailedAcquisitionDay,
          hasAmbiguousPoints,
          hasUnreadablePointValues,
        })
      );

      expect(metrics.penseroPointsPerDollar).toEqual({
        state: BranchMetricAvailability.Partial,
        value: EXPECTED_POINTS_PER_DOLLAR,
        disclosure,
      });
    }
  );

  it("refuses a negative point total instead of clamping it to a fake zero", () => {
    // A clamp here would be indistinguishable from the genuine zero above. An
    // IMPOSSIBLE operand is still refused; only the COVERAGE refusal is gone.
    const metrics = calculateBranchDetailMetrics(
      inputWith({
        points: -1,
        hasFailedAcquisitionDay: false,
        hasAmbiguousPoints: false,
        hasUnreadablePointValues: false,
      })
    );

    expect(metrics.penseroPointsPerDollar?.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });

  it("ISS-9930 AC1: no reachable input publishes Complete", () => {
    // The ruling's load-bearing half. A state check on one fixture would pass
    // for a kernel that still published Complete on some other input, so this
    // sweeps every shortfall axis and the measured-zero axis together.
    const inputs = [false, true].flatMap((hasFailedAcquisitionDay) =>
      [false, true].flatMap((hasAmbiguousPoints) =>
        [false, true].flatMap((hasUnreadablePointValues) =>
          [0, PENSERO_POINTS].map((points) =>
            inputWith({
              points,
              hasFailedAcquisitionDay,
              hasAmbiguousPoints,
              hasUnreadablePointValues,
            })
          )
        )
      )
    );

    const disclosures = new Set<string>();
    for (const input of inputs) {
      const result = calculateBranchDetailMetrics(input).penseroPointsPerDollar;
      expect(result?.state).toBe(BranchMetricAvailability.Partial);
      expect(result?.value).not.toBeNull();
      if (result?.state === BranchMetricAvailability.Partial) {
        disclosures.add(result.disclosure);
      }
    }
    // Every shortfall combination reaches its OWN sentence: a selector that
    // collapsed two of them would still satisfy the Partial assertions above.
    expect(disclosures.size).toBe(8);
  });
});

describe("calculateDetailPenseroPointsPerDollar denominator states", () => {
  const numerator = {
    points: PENSERO_POINTS,
    hasFailedAcquisitionDay: false,
    hasAmbiguousPoints: false,
    hasUnreadablePointValues: false,
  };

  it("passes a null-valued denominator state through as its own state", () => {
    expect(
      calculateDetailPenseroPointsPerDollar(numerator, {
        state: BranchMetricAvailability.NotApplicable,
        value: null,
      })
    ).toEqual({ state: BranchMetricAvailability.NotApplicable, value: null });
    expect(
      calculateDetailPenseroPointsPerDollar(numerator, {
        state: BranchMetricAvailability.NoData,
        value: null,
      })
    ).toEqual({ state: BranchMetricAvailability.NoData, value: null });
    expect(
      calculateDetailPenseroPointsPerDollar(numerator, {
        state: BranchMetricAvailability.Unavailable,
        value: null,
      })
    ).toEqual({ state: BranchMetricAvailability.Unavailable, value: null });
  });

  it("treats a partial zero cost as unavailable but a complete zero cost as not applicable", () => {
    expect(
      calculateDetailPenseroPointsPerDollar(numerator, {
        state: BranchMetricAvailability.Partial,
        value: 0,
        disclosure: BranchMetricDisclosure.CostIncomplete,
      })
    ).toEqual({ state: BranchMetricAvailability.Unavailable, value: null });
    expect(
      calculateDetailPenseroPointsPerDollar(numerator, {
        state: BranchMetricAvailability.Complete,
        value: 0,
      })
    ).toEqual({ state: BranchMetricAvailability.NotApplicable, value: null });
  });

  it("divides by a positive partial cost", () => {
    expect(
      calculateDetailPenseroPointsPerDollar(numerator, {
        state: BranchMetricAvailability.Partial,
        value: BRANCH_COST_USD,
        disclosure: BranchMetricDisclosure.CostIncomplete,
      })
    ).toEqual({
      state: BranchMetricAvailability.Partial,
      value: EXPECTED_POINTS_PER_DOLLAR,
      disclosure: BranchMetricDisclosure.PenseroAcquisitionIncomplete,
    });
  });

  it("refuses a non-finite cost the divider cannot use", () => {
    expect(
      calculateDetailPenseroPointsPerDollar(numerator, {
        state: BranchMetricAvailability.Complete,
        value: Number.POSITIVE_INFINITY,
      })
    ).toEqual({ state: BranchMetricAvailability.Unavailable, value: null });
  });
});

/** The shipped branch-detail input: 100 lifetime lines over $20 of branch cost. */
function baseInput(): BranchDetailMetricInput {
  const phaseAttribution = attribution();
  return {
    selectedPrAdditions: 80,
    selectedPrDeletions: 20,
    selectedPrLocComplete: true,
    attributedCostUsd: rollupTotalUsd(phaseAttribution),
    phaseAttribution,
    selectedCycle: {
      cycleId: "latest-cycle",
      openedAt: "2026-08-01T10:00:00.000Z",
      terminalAt: "2026-08-01T13:00:00.000Z",
      outcome: BranchMetricPullRequestOutcome.Merged,
      successfulPushes: [
        { cycleId: "latest-cycle", occurredAt: "2026-08-01T11:00:00.000Z" },
      ],
    },
  };
}

/** The same input carrying a Pensero numerator. */
function inputWith(
  penseroPoints: BranchDetailMetricInput["penseroPoints"]
): BranchDetailMetricInput {
  return { ...baseInput(), penseroPoints };
}

/** One complete Build phase worth the whole branch cost. */
function attribution(): BranchPhaseAttributionResult {
  const segments = [
    phaseAttributionSegment({
      sessionId: "session-1",
      phase: BranchVisibleLifecyclePhase.Build,
      startMs: Date.parse("2026-08-01T10:30:00.000Z"),
      endMs: Date.parse("2026-08-01T11:30:00.000Z"),
      estimatedCostUsd: BRANCH_COST_USD,
    }),
  ];
  return {
    segments,
    rollups: Object.values(BranchVisibleLifecyclePhase).map((phase) => ({
      phase,
      estimatedCostUsd: segments
        .filter((item) => item.phase === phase)
        .reduce((sum, item) => sum + item.estimatedCostUsd, 0),
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      durationMs: 0,
      sessionCount: 1,
    })),
    coverage: {
      completeness: BranchPhaseAttributionCompleteness.Complete,
      subtotalUsd: BRANCH_COST_USD,
    },
  };
}
