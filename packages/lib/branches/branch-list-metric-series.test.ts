import { BranchMetricPeriod } from "@repo/api/src/types/branch-metrics";
import { describe, expect, it } from "vitest";
import type { BranchListMetricInput } from "./branch-list-metrics";
import { calculateMetricsWithSpendFacts as calculateBranchListMetrics } from "./branch-list-metrics.test-helpers";
import { buildAdjacentBranchMetricWindows } from "./branch-metric-windows";

const NOW = new Date("2026-08-08T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** `daysBack` whole days before the window's end instant. */
function at(daysBack: number): string {
  return new Date(NOW.getTime() - daysBack * DAY_MS + 60_000).toISOString();
}

function sevenDayWindows() {
  return buildAdjacentBranchMetricWindows(BranchMetricPeriod.SevenDays, NOW);
}

function input(): BranchListMetricInput {
  return {
    cohortSize: 1,
    lastActiveEvents: [],
    lastActiveCoverageComplete: true,
    statusSnapshots: [
      { branchId: "a", currentActive: true, priorActive: true },
    ],
    locContributions: [],
    locCompleteBranchIds: ["a"],
    pullRequests: [],
    pullRequestCoverageComplete: true,
    costContributions: [],
    costCompleteBranchIds: ["a"],
  };
}

function cost(sourceEventId: string, occurredAt: string, costUsd: number) {
  return {
    sourceEventId,
    branchId: "a",
    sessionId: `session-${sourceEventId}`,
    occurredAt,
    costUsd,
    qualifyingBranchCount: 1,
  };
}

function pullRequest(identity: string, mergedAt: string, size: number) {
  return {
    identity,
    branchId: "a",
    additions: size,
    deletions: 0,
    mergedAt,
    closedAt: null,
  };
}

describe("Branch list metric series (ISS-10363)", () => {
  it("places each day's spend in its own bucket, oldest first", () => {
    const spend = input();
    spend.costContributions = [
      cost("old", at(6), 10),
      cost("mid", at(3), 20),
      cost("new", at(1), 30),
    ];
    const result = calculateBranchListMetrics(spend, sevenDayWindows());

    // Seven daily buckets over a seven-day window, each carrying only the cost
    // that fell inside it — and the whole line reconciling with the headline.
    expect(result.aiSpendUsd.series).toEqual([0, 10, 0, 0, 20, 0, 30]);
    expect(result.aiSpendUsd.current.value).toBe(60);
  });

  it("carries the series on a window with no comparison to draw", () => {
    // The two operands are independent: this is the exact card ISS-10208 leaves
    // without a delta, and it still knows the shape of its own period.
    const spend = input();
    spend.costContributions = [cost("old", at(6), 10), cost("new", at(1), 30)];
    const windows = sevenDayWindows();
    const result = calculateBranchListMetrics(spend, {
      ...windows,
      prior: null,
    });
    expect(result.aiSpendUsd.comparison).toBeUndefined();
    expect(result.aiSpendUsd.series).toEqual([0, 10, 0, 0, 0, 0, 30]);
  });

  it("omits the series on the all-time range, which cannot be cut", () => {
    const spend = input();
    spend.costContributions = [cost("old", at(6), 10), cost("new", at(1), 30)];
    const result = calculateBranchListMetrics(
      spend,
      buildAdjacentBranchMetricWindows(BranchMetricPeriod.All, NOW)
    );
    expect(result.aiSpendUsd.current.value).toBe(40);
    expect(result.aiSpendUsd.series).toBeUndefined();
  });

  it("omits the series on the boundary-snapshot and single-denominator metrics", () => {
    // Active branches is read at the window edge, so every bucket returns the
    // same figure; canonical LOC/$ divides one window-wide cost scalar, so a
    // bucket would report a LOC-only change as an efficiency change. Neither
    // absence is version skew — there is no per-bucket operand to draw.
    const spend = input();
    spend.costContributions = [cost("old", at(6), 10), cost("new", at(1), 30)];
    const result = calculateBranchListMetrics(spend, sevenDayWindows());
    expect(result.activeBranches.series).toBeUndefined();
    expect(result.canonicalLocPerDollar?.series).toBeUndefined();
  });

  it("omits a series holding exactly one real point", () => {
    // ISS-10363 (tamsinb review on #7448): this is the boundary
    // MIN_SERIES_POINTS actually guards, and it needs a metric that genuinely
    // produces ONE finite bucket — zero finite buckets is the neighbouring case
    // below, and it clears the same bar for a different reason.
    //
    // Median PR size is unknown in a bucket holding no decided pull request, so
    // one merged PR in the window yields exactly ONE finite bucket. The sibling
    // case below runs the same construction with two pull requests and pins the
    // published line — [null, null, 20, null, null, null, 60] — which is what
    // shows that this fixture's single PR lands as one point and not as none.
    const single = input();
    single.pullRequests = [pullRequest("solo", at(1), 40)];
    const result = calculateBranchListMetrics(single, sevenDayWindows());
    expect(result.medianPrSize.series).toBeUndefined();
    // The figure itself is still published — one point is too few to DRAW, never
    // too few to measure.
    expect(result.medianPrSize.current.value).toBe(40);
  });

  it("draws a series that reaches exactly two real points", () => {
    // The other side of the same boundary, so the assertion above pins a bar
    // rather than a metric that can never clear it.
    const pair = input();
    pair.pullRequests = [
      pullRequest("first", at(5), 20),
      pullRequest("second", at(1), 60),
    ];
    const result = calculateBranchListMetrics(pair, sevenDayWindows());
    expect(result.medianPrSize.series).toEqual([
      null,
      null,
      20,
      null,
      null,
      null,
      60,
    ]);
  });

  it("omits a series whose every bucket is unknown", () => {
    // Zero finite points, the case the previous fixture actually created before
    // this change: with no pull requests at all, every bucket is `noData` and
    // there is nothing to plot.
    const empty = input();
    const result = calculateBranchListMetrics(empty, sevenDayWindows());
    expect(result.medianPrSize.series).toBeUndefined();
  });
});
