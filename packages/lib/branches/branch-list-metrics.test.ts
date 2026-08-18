import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import { BranchVisibleLifecyclePhase } from "@repo/api/src/types/branch-phase-attribution";
import { describe, expect, it } from "vitest";
import {
  type BranchListMetricInput,
  calculateBranchListMetrics,
} from "./branch-list-metrics";
import { buildAdjacentBranchMetricWindows } from "./branch-metric-windows";

const NOW = new Date("2026-08-03T21:00:00.000Z");
const CURRENT = "2026-08-01T12:00:00.000Z";
const PRIOR = "2026-07-25T12:00:00.000Z";

describe("canonical Branch List metrics", () => {
  it("calculates ratio-of-totals, distinct PR metrics, and adjacent comparisons", () => {
    const result = calculateBranchListMetrics(
      {
        cohortSize: 2,
        lastActiveCoverageComplete: true,
        lastActiveEvents: [
          { sourceEventId: "event-1", occurredAt: CURRENT },
          { sourceEventId: "event-1", occurredAt: PRIOR },
        ],
        statusSnapshots: [
          { branchId: "a", currentActive: true, priorActive: true },
          { branchId: "b", currentActive: false, priorActive: true },
        ],
        locContributions: [
          loc("current-a", "a", CURRENT, 100, 0),
          loc("current-b", "b", CURRENT, 0, 100),
          loc("prior-a", "a", PRIOR, 25, 25),
        ],
        locCompleteBranchIds: ["a", "b"],
        pullRequestCoverageComplete: true,
        pullRequests: [
          pullRequest("repo#1", CURRENT, null, 10, 30),
          pullRequest("repo#2", CURRENT, null, 30, 50),
          pullRequest("repo#2", CURRENT, null, 30, 50),
          pullRequest("repo#3", PRIOR, null, 10, 10),
          pullRequest("repo#4", null, CURRENT, 1, 1),
        ],
        costCompleteBranchIds: ["a", "b"],
        costContributions: [
          cost("source-a", "a", CURRENT, 60, 2),
          cost("source-a", "b", CURRENT, 60, 2),
          cost("source-a", "a", CURRENT, 60, 2),
          cost("source-b", "a", CURRENT, 20, 1),
          cost("source-c", "a", PRIOR, 10, 1),
        ],
      },
      buildAdjacentBranchMetricWindows(BranchMetricPeriod.SevenDays, NOW)
    );

    // Ratio of totals: (100 + 100) / (50 + 30), not a mean of ratios.
    expect(result.locPerDollar.current).toEqual(complete(2.5));
    expect(result.medianPrSize.current).toEqual(complete(60));
    expect(result.aiSpendUsd.current).toEqual(complete(80));
    expect(result.mergeRatePct.current).toEqual(complete((2 / 3) * 100));
    expect(result.activeBranches.current).toEqual(complete(1));
    expect(result.activeBranches.comparison?.deltaPct).toEqual(complete(-50));
    expect(result.lastActiveAt).toEqual(complete(CURRENT));
  });

  it("keeps equal-looking distinct source events and dedupes stable identities", () => {
    const input = emptyInput(1);
    input.costContributions = [
      cost("source-a", "a", CURRENT, 10, 1),
      cost("source-a", "a", CURRENT, 10, 1),
      cost("source-b", "a", CURRENT, 10, 1),
    ];
    const result = calculateBranchListMetrics(
      input,
      buildAdjacentBranchMetricWindows(BranchMetricPeriod.SevenDays, NOW)
    );
    expect(result.aiSpendUsd.current).toEqual(complete(20));
  });

  it("marks paired exclusions partial without leaking one side into either total", () => {
    const input = emptyInput(1);
    input.cohortSize = 2;
    input.statusSnapshots = [
      { branchId: "a", currentActive: true, priorActive: true },
      { branchId: "b", currentActive: true, priorActive: true },
    ];
    input.locContributions = [
      loc("complete", "a", CURRENT, 30, 20),
      loc("missing-cost", "b", CURRENT, 1000, 1000),
    ];
    input.locCompleteBranchIds = ["a", "b"];
    input.costContributions = [cost("complete", "a", CURRENT, 10, 1)];
    input.costCompleteBranchIds = ["a"];
    const result = calculateBranchListMetrics(
      input,
      buildAdjacentBranchMetricWindows(BranchMetricPeriod.SevenDays, NOW)
    );
    expect(result.locPerDollar.current).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 5,
      coverage: { included: 1, total: 2 },
      disclosure: BranchMetricDisclosure.LocIncomplete,
    });
    expect(result.locPerDollar.comparison?.deltaPct.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });

  it("distinguishes zero, zero denominators, empty cohorts, and unavailable evidence", () => {
    const zero = emptyInput(1);
    zero.locContributions = [loc("zero", "a", CURRENT, 0, 0)];
    zero.locCompleteBranchIds = ["a"];
    zero.costContributions = [cost("zero", "a", CURRENT, 10, 1)];
    zero.costCompleteBranchIds = ["a"];
    expect(
      calculateBranchListMetrics(
        zero,
        buildAdjacentBranchMetricWindows(BranchMetricPeriod.SevenDays, NOW)
      ).locPerDollar.current
    ).toEqual(complete(0));

    const zeroDenominator = emptyInput(1);
    zeroDenominator.locContributions = [loc("zero-cost", "a", CURRENT, 10, 0)];
    zeroDenominator.locCompleteBranchIds = ["a"];
    zeroDenominator.costCompleteBranchIds = ["a"];
    expect(
      calculateBranchListMetrics(
        zeroDenominator,
        buildAdjacentBranchMetricWindows(BranchMetricPeriod.SevenDays, NOW)
      ).locPerDollar.current.state
    ).toBe(BranchMetricAvailability.NotApplicable);

    const empty = calculateBranchListMetrics(
      emptyInput(0),
      buildAdjacentBranchMetricWindows(BranchMetricPeriod.All, NOW)
    );
    expect(empty.locPerDollar.current.state).toBe(
      BranchMetricAvailability.NoData
    );
    expect(empty.activeBranches.current.state).toBe(
      BranchMetricAvailability.NoData
    );

    const missing = emptyInput(1);
    missing.locContributions = [loc("missing", "a", CURRENT, null, null)];
    missing.costContributions = [cost("missing", "a", CURRENT, null, null)];
    expect(
      calculateBranchListMetrics(
        missing,
        buildAdjacentBranchMetricWindows(BranchMetricPeriod.SevenDays, NOW)
      ).locPerDollar.current.state
    ).toBe(BranchMetricAvailability.Unavailable);
    expect(
      calculateBranchListMetrics(
        missing,
        buildAdjacentBranchMetricWindows(BranchMetricPeriod.SevenDays, NOW)
      ).aiSpendUsd.current.state
    ).toBe(BranchMetricAvailability.Unavailable);
  });

  it("keeps a missing prior status snapshot unavailable", () => {
    const input = emptyInput(1);
    input.statusSnapshots = [
      { branchId: "a", currentActive: false, priorActive: null },
    ];
    const result = calculateBranchListMetrics(
      input,
      buildAdjacentBranchMetricWindows(BranchMetricPeriod.SevenDays, NOW)
    );
    expect(result.activeBranches.current).toEqual(complete(0));
    expect(result.activeBranches.comparison?.deltaPct.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });

  it("uses event-specific windows instead of a Branch's unrelated recent activity", () => {
    const input = emptyInput(1);
    input.lastActiveEvents = [{ sourceEventId: "recent", occurredAt: CURRENT }];
    input.pullRequests = [pullRequest("repo#old", PRIOR, null, 50, 50)];
    const result = calculateBranchListMetrics(
      input,
      buildAdjacentBranchMetricWindows(BranchMetricPeriod.SevenDays, NOW)
    );
    expect(result.lastActiveAt).toEqual(complete(CURRENT));
    expect(result.medianPrSize.current.state).toBe(
      BranchMetricAvailability.NoData
    );
    expect(result.medianPrSize.comparison?.deltaPct.state).toBe(
      BranchMetricAvailability.NotApplicable
    );
  });

  it("returns a complete zero spend when complete evidence has no contributions", () => {
    const input = emptyInput(1);
    const result = calculateBranchListMetrics(
      input,
      buildAdjacentBranchMetricWindows(BranchMetricPeriod.SevenDays, NOW)
    );
    expect(result.aiSpendUsd.current).toEqual(complete(0));
  });

  it("degrades conflicting stable identities deterministically", () => {
    const first = emptyInput(1);
    first.costContributions = [
      cost("same", "a", CURRENT, 10, 1),
      cost("same", "a", PRIOR, 20, 1),
    ];
    const second = emptyInput(1);
    second.costContributions = [...first.costContributions].reverse();
    const windows = buildAdjacentBranchMetricWindows(
      BranchMetricPeriod.SevenDays,
      NOW
    );
    expect(
      calculateBranchListMetrics(first, windows).aiSpendUsd.current
    ).toEqual(calculateBranchListMetrics(second, windows).aiSpendUsd.current);
    expect(
      calculateBranchListMetrics(first, windows).aiSpendUsd.current.state
    ).toBe(BranchMetricAvailability.Unavailable);
  });

  it("finds Last active without spreading a large cohort into function arguments", () => {
    const input = emptyInput(100_001);
    input.lastActiveEvents = Array.from({ length: 100_001 }, (_, index) => ({
      sourceEventId: `event-${index}`,
      occurredAt: index === 100_000 ? CURRENT : PRIOR,
    }));
    const result = calculateBranchListMetrics(
      input,
      buildAdjacentBranchMetricWindows(BranchMetricPeriod.All, NOW)
    );
    expect(result.lastActiveAt).toEqual(complete(CURRENT));
  });

  it("does not fabricate exact Last-active coverage for an incomplete source", () => {
    const input = emptyInput(1);
    input.lastActiveCoverageComplete = false;
    input.lastActiveEvents = [{ sourceEventId: "known", occurredAt: CURRENT }];
    const result = calculateBranchListMetrics(
      input,
      buildAdjacentBranchMetricWindows(BranchMetricPeriod.All, NOW)
    );
    expect(result.lastActiveAt).toEqual({
      state: BranchMetricAvailability.Partial,
      value: CURRENT,
      disclosure: BranchMetricDisclosure.DefaultIncomplete,
    });
  });

  it("excludes ambiguous phase costs from canonical spend and LOC per dollar", () => {
    const input = emptyInput(1);
    input.locContributions = [loc("loc", "a", CURRENT, 50, 50)];
    input.locCompleteBranchIds = ["a"];
    input.costContributions = [
      {
        ...cost("ambiguous", "a", CURRENT, 10, 1),
        phase: null,
      },
    ];
    input.costCompleteBranchIds = ["a"];
    const result = calculateBranchListMetrics(
      input,
      buildAdjacentBranchMetricWindows(BranchMetricPeriod.SevenDays, NOW)
    );
    expect(result.aiSpendUsd.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
    expect(result.locPerDollar.current.state).toBe(
      BranchMetricAvailability.NotApplicable
    );
  });

  it("uses undated lifetime LOC only for all-time metrics", () => {
    const input = emptyInput(1);
    input.locContributions = [loc("lifetime-loc", "a", null, 50, 50)];
    input.locCompleteBranchIds = ["a"];
    input.costContributions = [cost("known-cost", "a", CURRENT, 10, 1)];
    input.costCompleteBranchIds = ["a"];

    const allTime = calculateBranchListMetrics(
      input,
      buildAdjacentBranchMetricWindows(BranchMetricPeriod.All, NOW)
    );
    const finite = calculateBranchListMetrics(
      input,
      buildAdjacentBranchMetricWindows(BranchMetricPeriod.SevenDays, NOW)
    );

    expect(allTime.locPerDollar.current).toEqual(complete(10));
    expect(finite.locPerDollar.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });

  it("excludes future all-time evidence while degrading coverage", () => {
    const input = emptyInput(1);
    input.locContributions = [
      loc("known-loc", "a", CURRENT, 50, 50),
      loc("future-loc", "a", "2026-08-04T00:00:00.000Z", 900, 100),
      loc("undated-loc", "a", null, 500, 500),
    ];
    input.locCompleteBranchIds = ["a"];
    input.costContributions = [
      cost("known", "a", CURRENT, 10, 1),
      cost("future", "a", "2026-08-04T00:00:00.000Z", 90, 1),
      cost("undated", "a", null, 50, 1),
    ];
    input.costCompleteBranchIds = ["a"];

    const result = calculateBranchListMetrics(
      input,
      buildAdjacentBranchMetricWindows(BranchMetricPeriod.All, NOW)
    );

    expect(result.aiSpendUsd.current).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 10,
      disclosure: BranchMetricDisclosure.CostIncomplete,
    });
    expect(result.locPerDollar.current).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 110,
      coverage: { included: 1, total: 1 },
      disclosure: BranchMetricDisclosure.LocIncomplete,
    });
  });
});

function emptyInput(cohortSize: number): BranchListMetricInput {
  return {
    cohortSize,
    lastActiveEvents: [] as Array<{
      sourceEventId: string;
      occurredAt: string | null;
    }>,
    lastActiveCoverageComplete: true,
    statusSnapshots: Array.from({ length: cohortSize }, (_, index) => ({
      branchId: String.fromCharCode(97 + index),
      currentActive: true,
      priorActive: true,
    })),
    locContributions: [] as ReturnType<typeof loc>[],
    locCompleteBranchIds: [],
    pullRequests: [] as ReturnType<typeof pullRequest>[],
    pullRequestCoverageComplete: true,
    costContributions: [] as ReturnType<typeof cost>[],
    costCompleteBranchIds: Array.from({ length: cohortSize }, (_, index) =>
      String.fromCharCode(97 + index)
    ),
  };
}

function loc(
  sourceEventId: string,
  branchId: string,
  occurredAt: string | null,
  additions: number | null,
  deletions: number | null
) {
  return { sourceEventId, branchId, occurredAt, additions, deletions };
}

function pullRequest(
  identity: string,
  mergedAt: string | null,
  closedAt: string | null,
  additions: number | null,
  deletions: number | null
) {
  return {
    identity,
    mergedAt,
    closedAt,
    isDraft: false,
    additions,
    deletions,
  };
}

function cost(
  sourceEventId: string,
  branchId: string,
  occurredAt: string | null,
  costUsd: number | null,
  qualifyingBranchCount: number | null
) {
  return {
    sourceEventId,
    branchId,
    sessionId: `session-${sourceEventId}`,
    occurredAt,
    phase: BranchVisibleLifecyclePhase.Build,
    costUsd,
    qualifyingBranchCount,
  };
}

function complete(value: number | string) {
  return { state: BranchMetricAvailability.Complete, value };
}
