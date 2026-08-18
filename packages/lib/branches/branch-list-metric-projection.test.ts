import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricPeriod,
  BranchMetricTerminalStatus,
} from "@repo/api/src/types/branch-metrics";
import { describe, expect, it } from "vitest";
import {
  branchMetricPeriodForRange,
  projectCanonicalBranchListMetrics,
} from "./branch-list-metric-projection";

describe("canonical Branch list metric projection", () => {
  it("uses the full cohort and event-time windows for current metrics", () => {
    const metrics = projectCanonicalBranchListMetrics({
      branches: [
        {
          id: "current",
          status: BranchStatus.Open,
          lastActivityAt: "2026-08-01T00:00:00.000Z",
        },
        {
          id: "prior",
          status: BranchStatus.Open,
          lastActivityAt: "2026-07-24T00:00:00.000Z",
        },
      ],
      pullRequests: [
        {
          identity: "org/repo#1",
          mergedAt: "2026-08-01T00:00:00.000Z",
          closedAt: "2026-08-01T00:00:00.000Z",
          isDraft: false,
          additions: 30,
          deletions: 10,
        },
      ],
      pullRequestCoverageComplete: true,
      startDate: "2026-07-27T00:00:00.000Z",
      endDate: "2026-08-03T00:00:00.000Z",
      now: new Date("2026-08-03T00:00:00.000Z"),
    });

    expect(metrics.period).toBe(BranchMetricPeriod.SevenDays);
    expect(metrics.cohortSize).toBe(2);
    expect(metrics.activeBranches.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 2,
    });
    expect(metrics.activeBranches.comparison?.deltaPct.state).toBe(
      BranchMetricAvailability.Unavailable
    );
    expect(metrics.medianPrSize.current.value).toBe(40);
    expect(metrics.aiSpendUsd.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });

  it("recognizes only exact adjacent-window durations", () => {
    expect(
      branchMetricPeriodForRange(
        "2026-07-04T00:00:00.000Z",
        "2026-08-03T00:00:00.000Z"
      )
    ).toBe(BranchMetricPeriod.ThirtyDays);
    expect(
      branchMetricPeriodForRange(
        "2026-07-01T00:00:00.000Z",
        "2026-08-03T00:00:00.000Z"
      )
    ).toBe(BranchMetricPeriod.All);
    expect(
      branchMetricPeriodForRange(
        "2026-07-27T00:04:00.000Z",
        "2026-08-03T00:00:00.000Z"
      )
    ).toBe(BranchMetricPeriod.All);
  });

  it("pins a start-only rolling range without request-latency drift", () => {
    const metrics = projectCanonicalBranchListMetrics({
      branches: [],
      pullRequests: [],
      pullRequestCoverageComplete: true,
      startDate: "2026-07-27T00:00:00.000Z",
      now: new Date("2026-08-03T00:00:01.000Z"),
    });
    expect(metrics.period).toBe(BranchMetricPeriod.SevenDays);
    expect(metrics.window).toEqual({
      startAt: "2026-07-27T00:00:00.000Z",
      endAt: "2026-08-03T00:00:00.000Z",
    });
  });

  it("classifies inclusive UTC-day and start-only UTC-day windows", () => {
    const inclusiveMetrics = projectCanonicalBranchListMetrics({
      branches: [],
      pullRequests: [],
      pullRequestCoverageComplete: true,
      startDate: "2026-07-28T00:00:00.000Z",
      endDate: "2026-08-03T23:59:59.999Z",
      now: new Date("2026-08-03T12:00:00.000Z"),
    });
    const startOnlyMetrics = projectCanonicalBranchListMetrics({
      branches: [],
      pullRequests: [],
      pullRequestCoverageComplete: true,
      startDate: "2026-07-28T00:00:00.000Z",
      now: new Date("2026-08-03T12:00:00.000Z"),
    });

    expect(inclusiveMetrics.period).toBe(BranchMetricPeriod.SevenDays);
    expect(inclusiveMetrics.label).toBe(
      BranchMetricComparisonLabel.WeekOverWeek
    );
    expect(inclusiveMetrics.window).toEqual({
      startAt: "2026-07-28T00:00:00.000Z",
      endAt: "2026-08-04T00:00:00.000Z",
    });
    expect(startOnlyMetrics.period).toBe(BranchMetricPeriod.SevenDays);
    expect(startOnlyMetrics.label).toBe(
      BranchMetricComparisonLabel.WeekOverWeek
    );
    expect(startOnlyMetrics.window).toEqual({
      startAt: "2026-07-28T00:00:00.000Z",
      endAt: "2026-08-04T00:00:00.000Z",
    });
  });

  it("does not count an unknown future status as active", () => {
    const unknownBranch = JSON.parse(
      '{"id":"future","status":"future_status","lastActivityAt":null}'
    );
    const metrics = projectCanonicalBranchListMetrics({
      branches: [unknownBranch],
      pullRequests: [],
      pullRequestCoverageComplete: true,
      now: new Date("2026-08-03T00:00:00.000Z"),
    });
    expect(metrics.activeBranches.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });

  it("treats the canonical canceled status as terminal", () => {
    const metrics = projectCanonicalBranchListMetrics({
      branches: [
        {
          id: "canceled",
          status: BranchMetricTerminalStatus.Canceled,
          lastActivityAt: null,
        },
      ],
      pullRequests: [],
      pullRequestCoverageComplete: true,
      now: new Date("2026-08-03T00:00:00.000Z"),
    });
    expect(metrics.activeBranches.current.value).toBe(0);
  });

  it("fails closed when a current row is projected at a historical boundary", () => {
    const metrics = projectCanonicalBranchListMetrics({
      branches: [
        {
          id: "historical",
          status: BranchStatus.Open,
          lastActivityAt: "2026-07-01T00:00:00.000Z",
        },
      ],
      pullRequests: [],
      pullRequestCoverageComplete: true,
      startDate: "2026-06-24T00:00:00.000Z",
      endDate: "2026-07-01T00:00:00.000Z",
      now: new Date("2026-08-03T00:00:00.000Z"),
    });

    expect(metrics.activeBranches.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });
});
