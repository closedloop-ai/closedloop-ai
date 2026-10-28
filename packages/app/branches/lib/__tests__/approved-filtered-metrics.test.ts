import {
  type BranchAnalytics,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import {
  type BranchListMetricBundle,
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import { describe, expect, it } from "vitest";
import {
  bindCanonicalMetricsToFilteredRows,
  hasApprovedBranchFilters,
} from "../approved-filtered-metrics";
import { DEFAULT_BRANCH_FILTERS } from "../branch-row";
import { unavailableKpi, wireRow } from "./approved-branch-fixtures";

describe("hasApprovedBranchFilters", () => {
  it("returns false when every facet is empty", () => {
    expect(hasApprovedBranchFilters(DEFAULT_BRANCH_FILTERS)).toBe(false);
  });

  it("returns true when names is set", () => {
    expect(
      hasApprovedBranchFilters({
        ...DEFAULT_BRANCH_FILTERS,
        names: ["feature/x"],
      })
    ).toBe(true);
  });

  it("returns true when owners is set", () => {
    expect(
      hasApprovedBranchFilters({
        ...DEFAULT_BRANCH_FILTERS,
        owners: ["github:daveth"],
      })
    ).toBe(true);
  });

  it("returns true when collaborators is set", () => {
    expect(
      hasApprovedBranchFilters({
        ...DEFAULT_BRANCH_FILTERS,
        collaborators: ["github:kerensa"],
      })
    ).toBe(true);
  });

  it("returns true when statuses is set", () => {
    expect(
      hasApprovedBranchFilters({
        ...DEFAULT_BRANCH_FILTERS,
        statuses: ["open"],
      })
    ).toBe(true);
  });

  it("returns true when pullRequests is set", () => {
    expect(
      hasApprovedBranchFilters({
        ...DEFAULT_BRANCH_FILTERS,
        pullRequests: ["linked"],
      })
    ).toBe(true);
  });

  it("returns true when lastActiveRanges is set", () => {
    expect(
      hasApprovedBranchFilters({
        ...DEFAULT_BRANCH_FILTERS,
        lastActiveRanges: ["within_last_hour"],
      })
    ).toBe(true);
  });

  it("returns true when repos is set", () => {
    expect(
      hasApprovedBranchFilters({
        ...DEFAULT_BRANCH_FILTERS,
        repos: ["closedloop-ai/closedloop-ai"],
      })
    ).toBe(true);
  });

  it("returns true when tags is set", () => {
    expect(
      hasApprovedBranchFilters({
        ...DEFAULT_BRANCH_FILTERS,
        tags: ["tag-ui"],
      })
    ).toBe(true);
  });

  it("returns true when locMin is defined, including an explicit 0", () => {
    expect(
      hasApprovedBranchFilters({ ...DEFAULT_BRANCH_FILTERS, locMin: 0 })
    ).toBe(true);
  });

  it("returns true when locMax is defined", () => {
    expect(
      hasApprovedBranchFilters({ ...DEFAULT_BRANCH_FILTERS, locMax: 500 })
    ).toBe(true);
  });

  it("returns true when multiple facets are set together", () => {
    expect(
      hasApprovedBranchFilters({
        ...DEFAULT_BRANCH_FILTERS,
        owners: ["github:daveth"],
        statuses: ["open"],
        locMax: 500,
      })
    ).toBe(true);
  });

  it("ignores the legacy sessionPresence facet, which approved List controls never expose", () => {
    expect(
      hasApprovedBranchFilters({
        ...DEFAULT_BRANCH_FILTERS,
        sessionPresence: ["active"],
      })
    ).toBe(false);
  });
});

describe("bindCanonicalMetricsToFilteredRows", () => {
  it("returns the analytics object unchanged when there are no canonical metrics", () => {
    const analytics: BranchAnalytics = {
      ...canonicalAnalytics(),
      canonicalMetrics: undefined,
    };
    const selected = wireRow();

    const result = bindCanonicalMetricsToFilteredRows(
      analytics,
      [selected],
      { ...DEFAULT_BRANCH_FILTERS, owners: ["github:daveth"] },
      { session1: 3.5 },
      [selected, wireRow({ id: "branch-2" })]
    );

    expect(result).toBe(analytics);
  });

  it("returns the analytics object unchanged when no approved filter is active", () => {
    const analytics = canonicalAnalytics();
    const selected = wireRow();

    const result = bindCanonicalMetricsToFilteredRows(
      analytics,
      [selected],
      DEFAULT_BRANCH_FILTERS,
      { session1: 3.5 },
      [selected, wireRow({ id: "branch-2" })]
    );

    expect(result).toBe(analytics);
  });

  it("returns the analytics object unchanged when the filtered rows match the unfiltered cohort", () => {
    const analytics = canonicalAnalytics();
    const rows = [wireRow(), wireRow({ id: "branch-2" })];

    const result = bindCanonicalMetricsToFilteredRows(
      analytics,
      rows,
      { ...DEFAULT_BRANCH_FILTERS, owners: ["github:daveth"] },
      { session1: 3.5 },
      rows
    );

    expect(result).toBe(analytics);
  });

  it("replaces activeBranches and aiSpendUsd current values, and cohortSize, for a filtered cohort", () => {
    const analytics = canonicalAnalytics();
    const selected = wireRow();

    const narrowed = bindCanonicalMetricsToFilteredRows(
      analytics,
      [selected],
      { ...DEFAULT_BRANCH_FILTERS, owners: ["github:daveth"] },
      { session1: 3.5 },
      [selected, wireRow({ id: "branch-2" })]
    );

    expect(narrowed).not.toBe(analytics);
    expect(narrowed.canonicalMetrics?.cohortSize).toBe(1);
    expect(narrowed.canonicalMetrics?.activeBranches.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 1,
    });
    expect(narrowed.canonicalMetrics?.aiSpendUsd.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 3.5,
    });
    // Event-history metrics have no locally-derivable fallback and fail closed,
    // distinct from the two metrics List data can defensibly answer.
    expect(narrowed.canonicalMetrics?.locPerDollar.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
    expect(narrowed.canonicalMetrics?.medianPrSize.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
    expect(narrowed.canonicalMetrics?.mergeRatePct.current.state).toBe(
      BranchMetricAvailability.Unavailable
    );
  });

  it("resets a metric's comparison delta to Unavailable while preserving its label and priorWindow", () => {
    const analytics = canonicalAnalytics();
    const priorWindow = {
      startAt: "2026-06-06T00:00:00.000Z",
      endAt: "2026-07-06T00:00:00.000Z",
    };
    analytics.canonicalMetrics = {
      ...(analytics.canonicalMetrics as BranchListMetricBundle),
      activeBranches: {
        current: { state: BranchMetricAvailability.Complete, value: 2 },
        comparison: {
          label: BranchMetricComparisonLabel.MonthOverMonth,
          priorWindow,
          deltaPct: { state: BranchMetricAvailability.Complete, value: 12 },
        },
      },
    };
    const selected = wireRow();

    const narrowed = bindCanonicalMetricsToFilteredRows(
      analytics,
      [selected],
      { ...DEFAULT_BRANCH_FILTERS, owners: ["github:daveth"] },
      { session1: 3.5 },
      [selected, wireRow({ id: "branch-2" })]
    );

    expect(narrowed.canonicalMetrics?.activeBranches.comparison).toEqual({
      label: BranchMetricComparisonLabel.MonthOverMonth,
      priorWindow,
      deltaPct: { state: BranchMetricAvailability.Unavailable, value: null },
    });
  });

  it("collapses every current metric to NoData, not a fabricated zero, for an empty filtered cohort", () => {
    const analytics = canonicalAnalytics();
    const unfilteredRows = [wireRow(), wireRow({ id: "branch-2" })];

    const narrowed = bindCanonicalMetricsToFilteredRows(
      analytics,
      [],
      { ...DEFAULT_BRANCH_FILTERS, owners: ["github:nobody"] },
      {},
      unfilteredRows
    );

    expect(narrowed.canonicalMetrics?.cohortSize).toBe(0);
    const noData = { state: BranchMetricAvailability.NoData, value: null };
    expect(narrowed.canonicalMetrics?.activeBranches.current).toEqual(noData);
    expect(narrowed.canonicalMetrics?.aiSpendUsd.current).toEqual(noData);
    expect(narrowed.canonicalMetrics?.locPerDollar.current).toEqual(noData);
    expect(narrowed.canonicalMetrics?.medianPrSize.current).toEqual(noData);
    expect(narrowed.canonicalMetrics?.mergeRatePct.current).toEqual(noData);
  });
});

function canonicalAnalytics(): BranchAnalytics {
  const metric = {
    current: { state: BranchMetricAvailability.Complete, value: 1 } as const,
  };
  const canonicalMetrics: BranchListMetricBundle = {
    period: BranchMetricPeriod.ThirtyDays,
    label: BranchMetricComparisonLabel.MonthOverMonth,
    window: {
      startAt: "2026-07-06T00:00:00.000Z",
      endAt: "2026-08-05T00:00:00.000Z",
    },
    cohortSize: 1,
    lastActiveAt: {
      state: BranchMetricAvailability.Complete,
      value: "2026-08-05T12:00:00.000Z",
    },
    activeBranches: metric,
    locPerDollar: metric,
    medianPrSize: metric,
    aiSpendUsd: metric,
    mergeRatePct: metric,
  };
  return {
    viewerScope: BranchViewerScope.Self,
    canonicalMetrics,
    medianPrSize: unavailableKpi(),
    mergeRate: unavailableKpi(),
    medianTimeToMergeMs: unavailableKpi(),
    activePrCount: unavailableKpi(),
    mergedCount: unavailableKpi(),
    leadTimeForChangeMs: unavailableKpi(),
    locPerDollar: unavailableKpi(),
    totalSpendUsd: unavailableKpi(),
    activeBranchCount: unavailableKpi(),
    buildVsReworkSplit: {
      buildPct: null,
      reworkPct: null,
      state: "unavailable",
    },
  };
}
