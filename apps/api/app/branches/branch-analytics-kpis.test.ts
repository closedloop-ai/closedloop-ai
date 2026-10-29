import { BranchKpiState, BranchStatus } from "@repo/api/src/types/branch";
import {
  type BranchListMetricBundle,
  BranchMetricAvailability,
} from "@repo/api/src/types/branch-metrics";
import { GitHubPRState } from "@repo/api/src/types/github";
import { describe, expect, it } from "vitest";
import {
  type BranchAnalyticsMetrics,
  buildBranchAnalytics,
  withCanonicalSpendKpis,
} from "./branch-analytics-kpis";

function metric(
  id: string,
  overrides: Partial<BranchAnalyticsMetrics> = {}
): BranchAnalyticsMetrics {
  return {
    id,
    status: BranchStatus.Open,
    multiPrWarning: false,
    prState: null,
    mergedAt: null,
    additions: null,
    deletions: null,
    prSize: null,
    ...overrides,
  };
}

function cards(spend: number | null, ratio: number | null) {
  const result = (value: number | null) => ({
    current:
      value === null
        ? { state: BranchMetricAvailability.Unavailable, value: null }
        : { state: BranchMetricAvailability.Complete, value },
  });
  return {
    aiSpendUsd: result(spend),
    locPerDollar: result(ratio),
  } as unknown as BranchListMetricBundle;
}

describe("withCanonicalSpendKpis", () => {
  const base = buildBranchAnalytics({ metrics: [metric("branch-1")] });

  it("publishes the cards' own spend and pushed LOC per dollar", () => {
    const analytics = withCanonicalSpendKpis(base, cards(4.25, 13.56));

    expect(analytics.totalSpendUsd).toMatchObject({
      state: BranchKpiState.Available,
      value: 4.25,
    });
    expect(analytics.locPerDollar).toMatchObject({
      state: BranchKpiState.Available,
      value: 13.56,
    });
  });

  it("reports an unavailable card as unavailable, not zero", () => {
    const analytics = withCanonicalSpendKpis(base, cards(null, null));

    expect(analytics.totalSpendUsd).toMatchObject({
      state: BranchKpiState.Unavailable,
      value: null,
    });
    expect(analytics.locPerDollar).toMatchObject({
      state: BranchKpiState.Unavailable,
      value: null,
    });
  });

  it("keeps a measured zero spend unreportable (ISS-4737)", () => {
    const analytics = withCanonicalSpendKpis(base, cards(0, null));

    expect(analytics.totalSpendUsd.state).toBe(BranchKpiState.Unavailable);
  });

  it("leaves the count KPIs the fold produced untouched", () => {
    const folded = buildBranchAnalytics({
      metrics: [metric("a"), metric("b", { status: BranchStatus.Merged })],
    });

    expect(withCanonicalSpendKpis(folded, cards(1, 1)).activeBranchCount).toBe(
      folded.activeBranchCount
    );
  });
});

describe("buildBranchAnalytics — multi-PR ambiguity", () => {
  it("excludes multi-PR rows from selected-PR outcome and size metrics", () => {
    const analytics = buildBranchAnalytics({
      metrics: [
        metric("multi-merged", {
          status: BranchStatus.Merged,
          multiPrWarning: true,
          prState: GitHubPRState.Merged,
          mergedAt: new Date(0),
          additions: 80,
          deletions: 20,
          prSize: 100,
        }),
        metric("single-closed", {
          status: BranchStatus.Closed,
          prState: GitHubPRState.Closed,
        }),
        metric("single-merged", {
          status: BranchStatus.Merged,
          prState: GitHubPRState.Merged,
          mergedAt: new Date(1),
          additions: 20,
          deletions: 10,
          prSize: 30,
        }),
      ],
    });

    expect(analytics.mergeRate).toMatchObject({
      state: BranchKpiState.Available,
      value: 50,
    });
    expect(analytics.mergedCount).toMatchObject({
      state: BranchKpiState.Available,
      value: 1,
    });
    expect(analytics.medianPrSize).toMatchObject({
      state: BranchKpiState.Available,
      value: 30,
    });
  });
});
