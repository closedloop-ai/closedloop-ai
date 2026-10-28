import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import { describe, expect, it } from "vitest";
import {
  type BranchListMetricInput,
  calculateBranchListMetrics,
} from "./branch-list-metrics";
import { buildAdjacentBranchMetricWindows } from "./branch-metric-windows";
import { BranchPublicationLocSource } from "./branch-publication-loc";

const NOW = new Date("2026-08-18T12:00:00.000Z");
const CURRENT = "2026-08-17T12:00:00.000Z";
const PRIOR = "2026-08-08T12:00:00.000Z";

describe("ISS-6543 independent LOC and Session-cost totals", () => {
  it("includes qualifying unpublished Session cost in the denominator", () => {
    const input = baseInput();
    input.locContributions = [
      loc("push-a", "change-a", "branch-a", CURRENT, 100),
    ];
    input.locPerDollarCostContributions = [
      cost("published", "branch-a", "session-published", CURRENT, 20, 1),
      cost(
        "unpublished",
        "branch-unpublished",
        "session-unpublished",
        CURRENT,
        30,
        1
      ),
    ];
    input.locPerDollarQualifyingSessionIds = [
      "session-published",
      "session-unpublished",
    ];

    expect(
      calculate(input, BranchMetricPeriod.SevenDays).locPerDollar.current
    ).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 2,
    });
  });

  it("allocates one shared Session/source event once with its global divisor", () => {
    const input = baseInput();
    input.locContributions = [
      loc("push-a", "change-a", "branch-a", CURRENT, 80),
    ];
    input.locPerDollarCostContributions = [
      cost("shared", "branch-a", "session-shared", CURRENT, 40, 2),
      cost("shared", "branch-b", "session-shared", CURRENT, 40, 2),
      cost("shared", "branch-a", "session-shared", CURRENT, 40, 2),
    ];
    input.locPerDollarQualifyingSessionIds = ["session-shared"];

    expect(
      calculate(input, BranchMetricPeriod.SevenDays).locPerDollar.current
    ).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 2,
    });
  });

  it("allows one shared cost event to span two qualifying branches", () => {
    const input = baseInput();
    input.locContributions = [
      loc("push-a", "change-a", "branch-a", CURRENT, 80),
    ];
    input.locPerDollarCostContributions = [
      cost("shared", "branch-a", "session-shared", CURRENT, 40, 2),
      cost("shared", "branch-b", "session-shared", CURRENT, 40, 2),
    ];
    input.locPerDollarQualifyingSessionIds = ["session-shared"];

    expect(
      calculate(input, BranchMetricPeriod.SevenDays).locPerDollar.current
    ).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 2,
    });
  });

  it("deduplicates overlapping push and merged-PR evidence by change identity", () => {
    const input = baseInput();
    input.locContributions = [
      loc("push", "same-head", "branch-a", CURRENT, 100),
      {
        ...loc("merged-pr", "same-head", "branch-a", CURRENT, 100),
        source: BranchPublicationLocSource.MergedPullRequest,
      },
    ];
    input.locPerDollarCostContributions = [
      cost("cost", "branch-a", "session-a", CURRENT, 20, 1),
    ];
    input.locPerDollarQualifyingSessionIds = ["session-a"];

    expect(
      calculate(input, BranchMetricPeriod.SevenDays).locPerDollar.current
    ).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 5,
    });
  });

  it("keeps finite publication/activity windows separate from All", () => {
    const input = baseInput();
    input.locContributions = [
      loc("current-push", "current-change", "branch-a", CURRENT, 100),
      loc("prior-push", "prior-change", "branch-a", PRIOR, 900),
    ];
    input.locPerDollarCostContributions = [
      cost("current-cost", "branch-a", "session-current", CURRENT, 50, 1),
      cost("prior-cost", "branch-a", "session-prior", PRIOR, 50, 1),
    ];
    input.locPerDollarQualifyingSessionIds = [
      "session-current",
      "session-prior",
    ];

    expect(
      calculate(input, BranchMetricPeriod.SevenDays).locPerDollar.current.value
    ).toBe(2);
    expect(
      calculate(input, BranchMetricPeriod.All).locPerDollar.current.value
    ).toBe(10);
    expect(
      calculate(input, BranchMetricPeriod.SevenDays).locPerDollar.comparison
        ?.deltaPct.state
    ).toBe(BranchMetricAvailability.Complete);
  });

  it("does not let an old timed LOC gap poison a complete current window", () => {
    const input = baseInput();
    input.locContributions = [
      loc("current-push", "current-change", "branch-a", CURRENT, 100),
    ];
    input.locCoverageComplete = false;
    input.locCoverageGaps = [
      { sourceEventId: "old-unknown-loc", occurredAt: PRIOR },
    ];
    input.locPerDollarCostContributions = [
      cost("current-cost", "branch-a", "session-current", CURRENT, 50, 1),
    ];
    input.locPerDollarQualifyingSessionIds = ["session-current"];

    expect(
      calculate(input, BranchMetricPeriod.SevenDays).locPerDollar.current
    ).toEqual({ state: BranchMetricAvailability.Complete, value: 2 });
  });

  it("keeps timestampless all-time publication LOC numeric but incomplete", () => {
    const input = baseInput();
    input.locContributions = [
      loc("undated", "undated-change", "branch-a", null, 100),
    ];
    input.locPerDollarCostContributions = [
      cost("cost", "branch-a", "session-a", CURRENT, 50, 1),
    ];
    input.locPerDollarQualifyingSessionIds = ["session-a"];

    expect(
      calculate(input, BranchMetricPeriod.All).locPerDollar.current
    ).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 2,
      disclosure: BranchMetricDisclosure.LocIncomplete,
    });
  });

  it("reports No data when complete cost evidence has no in-window event", () => {
    const input = baseInput();
    input.locContributions = [
      loc("current-push", "current-change", "branch-a", CURRENT, 100),
    ];
    input.locPerDollarCostContributions = [
      cost("prior-cost", "branch-a", "session-prior", PRIOR, 50, 1),
    ];
    input.locPerDollarQualifyingSessionIds = ["session-prior"];

    expect(
      calculate(input, BranchMetricPeriod.SevenDays).locPerDollar.current
    ).toEqual({
      state: BranchMetricAvailability.NoData,
      value: null,
    });
  });

  it("fails closed when the global Branch divisor is missing", () => {
    const input = baseInput();
    input.locContributions = [
      loc("push-a", "change-a", "branch-a", CURRENT, 100),
    ];
    input.locPerDollarCostContributions = [
      cost("cost", "branch-a", "session-a", CURRENT, 20, null),
    ];
    input.locPerDollarQualifyingSessionIds = ["session-a"];
    input.locPerDollarCostCoverageComplete = false;

    expect(
      calculate(input, BranchMetricPeriod.SevenDays).locPerDollar.current
    ).toEqual({
      state: BranchMetricAvailability.Unavailable,
      value: null,
    });
  });
});

function calculate(input: BranchListMetricInput, period: BranchMetricPeriod) {
  return calculateBranchListMetrics(
    input,
    buildAdjacentBranchMetricWindows(period, NOW)
  );
}

function baseInput(): BranchListMetricInput {
  return {
    cohortSize: 1,
    cohortCoverageComplete: true,
    lastActiveEvents: [{ sourceEventId: "activity", occurredAt: CURRENT }],
    lastActiveCoverageComplete: true,
    statusSnapshots: [
      { branchId: "branch-a", currentActive: true, priorActive: true },
    ],
    locContributions: [],
    locCoverageComplete: true,
    locCompleteBranchIds: ["branch-a"],
    pullRequests: [],
    pullRequestCoverageComplete: true,
    costContributions: [],
    costCompleteBranchIds: ["branch-a"],
    locPerDollarCostContributions: [],
    locPerDollarQualifyingSessionIds: [],
    locPerDollarCostCoverageComplete: true,
  };
}

function loc(
  sourceEventId: string,
  changeIdentity: string,
  branchId: string,
  occurredAt: string | null,
  lines: number
) {
  return {
    sourceEventId,
    changeIdentity,
    branchId,
    occurredAt,
    additions: lines,
    deletions: 0,
    source: BranchPublicationLocSource.SuccessfulPush,
  };
}

function cost(
  sourceEventId: string,
  branchId: string,
  sessionId: string,
  occurredAt: string,
  costUsd: number,
  qualifyingBranchCount: number | null
) {
  return {
    sourceEventId,
    branchId,
    sessionId,
    occurredAt,
    costUsd,
    qualifyingBranchCount,
  };
}
