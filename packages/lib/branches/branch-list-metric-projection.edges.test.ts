/**
 * Edge cases for branch-list-metric-projection covering:
 * 1. branchMetricPeriodForRange — exactly 7 days with allowTolerance=false → SevenDays
 *    (matchesPeriod's difference===0 arm, not the tolerance arm)
 * 2. boundedEndFromStart — SevenDays branch (days = 7)
 * 3. boundedEndFromStart — ThirtyDays branch (days = 30)
 * 4. validDate — Date instance path (value instanceof Date → date = value directly)
 */
import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BranchMetricAvailability,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import { describe, expect, it } from "vitest";
import type { BranchMetricCostContribution } from "./branch-cost-evidence";
import { costFactsFromContributions } from "./branch-cost-facts-from-contributions";
import {
  branchMetricPeriodForRange,
  type CanonicalBranchListMetricProjectionInput,
  projectCanonicalBranchListMetrics,
  resolveCanonicalBranchMetricWindows,
} from "./branch-list-metric-projection";
import { branchMetricFactWindows } from "./branch-pull-request-metrics";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("branchMetricPeriodForRange edge cases", () => {
  it("classifies an exact 60-day range as SixtyDays rather than falling through to all-time", () => {
    const start = new Date("2026-07-27T00:00:00.000Z");
    const end = new Date(start.getTime() + 60 * DAY_MS);
    expect(branchMetricPeriodForRange(start, end, false)).toBe(
      BranchMetricPeriod.SixtyDays
    );
  });

  it("classifies exactly-7-days range as SevenDays when tolerance is disabled", () => {
    const start = new Date("2026-07-27T00:00:00.000Z");
    const end = new Date(start.getTime() + 7 * DAY_MS);
    // allowStartOnlyTolerance = false (default) → difference must be exactly 0
    const period = branchMetricPeriodForRange(start, end, false);
    expect(period).toBe(BranchMetricPeriod.SevenDays);
  });

  it("classifies a 6-day-23h range as SevenDays when tolerance is enabled (exercises tolerance arm)", () => {
    const start = new Date("2026-07-27T00:00:00.000Z");
    const slightlyShort = new Date(
      start.getTime() + 7 * DAY_MS - 4 * 60 * 1000
    );
    // allowTolerance=true → within 5-minute tolerance → SevenDays
    const period = branchMetricPeriodForRange(start, slightlyShort, true);
    expect(period).toBe(BranchMetricPeriod.SevenDays);
  });

  it("returns All when start date is invalid", () => {
    const period = branchMetricPeriodForRange("not-a-date", new Date());
    expect(period).toBe(BranchMetricPeriod.All);
  });

  it("returns All when end date is null/invalid", () => {
    const period = branchMetricPeriodForRange(new Date(), "not-a-date");
    expect(period).toBe(BranchMetricPeriod.All);
  });
});

describe("resolveCanonicalBranchMetricWindows — boundedEndFromStart SevenDays + ThirtyDays paths", () => {
  it("uses SevenDays (7-day bound) when startDate resolves to a 7-day period and endDate is absent", () => {
    const now = new Date("2026-08-03T00:00:00.000Z");
    // Start is exactly 7 days before now; no endDate → resolves SevenDays,
    // then boundedEndFromStart(start, SevenDays) → start + 7*DAY = now
    const start = new Date(now.getTime() - 7 * DAY_MS);
    const windows = resolveCanonicalBranchMetricWindows({
      startDate: start,
      endDate: undefined,
      now,
    });
    expect(windows.period).toBe(BranchMetricPeriod.SevenDays);
    expect(windows.current.endAt).toBe(now.toISOString());
    expect(windows.current.startAt).toBe(
      new Date(now.getTime() - 7 * DAY_MS).toISOString()
    );
  });

  it("uses ThirtyDays (30-day bound) when startDate resolves to a 30-day period and endDate is absent", () => {
    const now = new Date("2026-08-03T00:00:00.000Z");
    const start = new Date(now.getTime() - 30 * DAY_MS);
    const windows = resolveCanonicalBranchMetricWindows({
      startDate: start,
      endDate: undefined,
      now,
    });
    expect(windows.period).toBe(BranchMetricPeriod.ThirtyDays);
    expect(windows.current.endAt).toBe(now.toISOString());
  });
});

describe("validDate — Date instance path", () => {
  it("accepts a Date instance directly (value instanceof Date path)", () => {
    const now = new Date("2026-08-03T00:00:00.000Z");
    const start = new Date(now.getTime() - 7 * DAY_MS);
    // Both startDate and endDate are Date instances → validDate takes the instanceof Date branch
    const period = branchMetricPeriodForRange(start, now, false);
    expect(period).toBe(BranchMetricPeriod.SevenDays);
  });
});

describe("resolveCanonicalBranchMetricWindows — boundedEndFromStart NinetyDays path", () => {
  it("uses NinetyDays bound when startDate is 90 days before now (else-if ThirtyDays is false — arm 1)", () => {
    const now = new Date("2026-08-03T00:00:00.000Z");
    const start = new Date(now.getTime() - 90 * DAY_MS);
    // period resolves to NinetyDays → boundedEndFromStart: SevenDays-if is false,
    // ThirtyDays-else-if is also false (arm 1) → days stays 90
    const windows = resolveCanonicalBranchMetricWindows({
      startDate: start,
      endDate: undefined,
      now,
    });
    expect(windows.period).toBe(BranchMetricPeriod.NinetyDays);
    expect(windows.current.endAt).toBe(now.toISOString());
  });
});

const IN_WINDOW = "2026-08-01T00:00:00.000Z";

function forwardingInput(
  overrides: Partial<CanonicalBranchListMetricProjectionInput>
): CanonicalBranchListMetricProjectionInput {
  return {
    branches: [
      { id: "a", status: BranchStatus.Open, lastActivityAt: IN_WINDOW },
    ],
    pullRequests: [
      {
        identity: "org/repo#1",
        mergedAt: IN_WINDOW,
        closedAt: IN_WINDOW,
        additions: 30,
        deletions: 10,
      },
    ],
    pullRequestCoverageComplete: true,
    startDate: "2026-07-27T00:00:00.000Z",
    endDate: "2026-08-03T00:00:00.000Z",
    now: new Date("2026-08-03T00:00:00.000Z"),
    locContributions: [
      {
        sourceEventId: "loc-1",
        branchId: "a",
        occurredAt: IN_WINDOW,
        additions: 100,
        deletions: 0,
      },
    ],
    locCompleteBranchIds: ["a"],
    costContributions: [
      {
        sourceEventId: "cost-1",
        branchId: "a",
        sessionId: "session-1",
        occurredAt: IN_WINDOW,
        costUsd: 10,
        qualifyingBranchCount: 1,
      },
    ],
    costCompleteBranchIds: ["a"],
    aiSpendFacts: spendFactsFor([costRow("cost-1", 10)]),
    ...overrides,
  };
}

/** Spend as a producer folds it, for the fixture's own window. */
function spendFactsFor(contributions: BranchMetricCostContribution[]) {
  return costFactsFromContributions(
    contributions,
    branchMetricFactWindows(
      resolveCanonicalBranchMetricWindows({
        startDate: "2026-07-27T00:00:00.000Z",
        endDate: "2026-08-03T00:00:00.000Z",
        now: new Date("2026-08-03T00:00:00.000Z"),
      })
    )
  );
}

function costRow(
  sourceEventId: string,
  costUsd: number
): BranchMetricCostContribution {
  return {
    sourceEventId,
    branchId: "a",
    sessionId: `session-${sourceEventId}`,
    occurredAt: IN_WINDOW,
    costUsd,
    qualifyingBranchCount: 1,
  };
}

describe("projectCanonicalBranchListMetrics — optional evidence forwarding", () => {
  it("publishes complete figures from the base fixture", () => {
    const metrics = projectCanonicalBranchListMetrics(forwardingInput({}));
    expect(metrics.locPerDollar.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 10,
    });
    expect(metrics.aiSpendUsd.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 10,
    });
    expect(metrics.canonicalLocPerDollar?.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
    expect(metrics.penseroPointsPerDollar).toBeUndefined();
  });

  it("forwards cohortCoverageComplete=false", () => {
    const metrics = projectCanonicalBranchListMetrics(
      forwardingInput({ cohortCoverageComplete: false })
    );
    expect(metrics.activeBranches.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });

  it("forwards locCoverageComplete=false", () => {
    const metrics = projectCanonicalBranchListMetrics(
      forwardingInput({ locCoverageComplete: false })
    );
    expect(metrics.locPerDollar.current.state).toBe(
      BranchMetricAvailability.Partial
    );
  });

  it("forwards an in-window locCoverageGap", () => {
    const metrics = projectCanonicalBranchListMetrics(
      forwardingInput({
        locCoverageGaps: [{ sourceEventId: "gap-1", occurredAt: IN_WINDOW }],
      })
    );
    expect(metrics.locPerDollar.current.state).toBe(
      BranchMetricAvailability.Partial
    );
  });

  it("forwards an empty pullRequestCoverageGaps list over a false flag", () => {
    const flagOnly = projectCanonicalBranchListMetrics(
      forwardingInput({ pullRequestCoverageComplete: false })
    );
    const withGaps = projectCanonicalBranchListMetrics(
      forwardingInput({
        pullRequestCoverageComplete: false,
        pullRequestCoverageGaps: [],
      })
    );
    expect(flagOnly.mergeRatePct.current.state).toBe(
      BranchMetricAvailability.Partial
    );
    expect(withGaps.mergeRatePct.current.state).toBe(
      BranchMetricAvailability.Complete
    );
  });

  it("forwards aiSpendFacts as the spend", () => {
    const metrics = projectCanonicalBranchListMetrics(
      forwardingInput({ aiSpendFacts: spendFactsFor([costRow("spend-1", 25)]) })
    );
    expect(metrics.aiSpendUsd.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 25,
    });
  });

  it("forwards an unusable event in aiSpendFacts as a partial spend", () => {
    const metrics = projectCanonicalBranchListMetrics(
      forwardingInput({
        aiSpendFacts: spendFactsFor([
          costRow("spend-1", 25),
          { ...costRow("unpriced", 0), costUsd: null },
        ]),
      })
    );
    expect(metrics.aiSpendUsd.current.state).toBe(
      BranchMetricAvailability.Partial
    );
  });

  it("forwards locPerDollarCostContributions as the ratio denominator", () => {
    const metrics = projectCanonicalBranchListMetrics(
      forwardingInput({
        locPerDollarCostContributions: [costRow("ratio-1", 50)],
      })
    );
    expect(metrics.locPerDollar.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 2,
    });
  });

  it("forwards an empty locPerDollarQualifyingSessionIds list", () => {
    const metrics = projectCanonicalBranchListMetrics(
      forwardingInput({ locPerDollarQualifyingSessionIds: [] })
    );
    expect(metrics.locPerDollar.current.state).toBe(
      BranchMetricAvailability.NoData
    );
  });

  it("forwards locPerDollarCostCoverageComplete=false", () => {
    const metrics = projectCanonicalBranchListMetrics(
      forwardingInput({ locPerDollarCostCoverageComplete: false })
    );
    expect(metrics.locPerDollar.current.state).toBe(
      BranchMetricAvailability.Partial
    );
  });

  it("forwards canonicalEstimatedCostUsd and penseroPoints", () => {
    const metrics = projectCanonicalBranchListMetrics(
      forwardingInput({
        canonicalEstimatedCostUsd: 20,
        penseroPoints: {
          points: 40,
          hasFailedAcquisitionDay: false,
          hasAmbiguousPoints: false,
          hasUnreadablePointValues: false,
        },
      })
    );
    expect(metrics.canonicalLocPerDollar?.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 5,
    });
    expect(metrics.penseroPointsPerDollar?.current.value).toBe(2);
  });
});

describe("projectCanonicalBranchListMetrics — invalid endDate", () => {
  it.each([
    ["string", "not-a-date"],
    ["Date", new Date("invalid")],
  ])(
    "falls back to the start-bounded period for an invalid %s",
    (_label, endDate) => {
      const metrics = projectCanonicalBranchListMetrics(
        forwardingInput({ endDate })
      );
      expect(metrics.period).toBe(BranchMetricPeriod.SevenDays);
      expect(metrics.window.endAt).toBe("2026-08-03T00:00:00.000Z");
    }
  );
});
