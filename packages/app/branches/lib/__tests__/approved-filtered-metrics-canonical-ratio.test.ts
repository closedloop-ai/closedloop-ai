/**
 * @file approved-filtered-metrics-canonical-ratio.test.ts
 * @description ISS-9956 — the locally-filtered fallback must rebind the
 * canonical LOC per $ to the SAME filtered rows as the tiles beside it.
 *
 * `bindCanonicalMetricsToFilteredRows` rebuilds the bundle for a cohort the
 * client narrowed itself, and its `...metrics` spread carries through every
 * field it does not explicitly replace. A newly added ratio therefore arrives
 * holding the producer's WHOLE-cohort figure, and the strip reports the full
 * cohort's efficiency beside tiles describing the filtered subset. That is the
 * defect this file pins; it is the same hazard `approved-filtered-metrics-cost-
 * companion.test.ts` pins one field over.
 *
 * Its own file rather than a case appended to that one, which is scoped to the
 * ISS-7365 cost companion — a different field with a different rebind value.
 */
import {
  type BranchAnalytics,
  BranchViewerScope,
  type BranchRow as WireBranchRow,
} from "@repo/api/src/types/branch";
import {
  type BranchListMetricBundle,
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import { describe, expect, it } from "vitest";
import { bindCanonicalMetricsToFilteredRows } from "../approved-filtered-metrics";
import { DEFAULT_BRANCH_FILTERS } from "../branch-row";
import { unavailableKpi, wireRow } from "./approved-branch-fixtures";

/** The producer's whole-cohort ratio. Distinctive so it cannot match by luck. */
const PRODUCER_COHORT_RATIO = 8123.44;

describe("ISS-9956 filtered fallback rebinds the canonical LOC per $", () => {
  it("does not carry the producer's whole-cohort ratio into the filtered bundle", () => {
    const analytics = canonicalAnalytics();
    analytics.canonicalMetrics = {
      ...analytics.canonicalMetrics,
      canonicalLocPerDollar: {
        current: {
          state: BranchMetricAvailability.Complete,
          value: PRODUCER_COHORT_RATIO,
        },
      },
    } as BranchListMetricBundle;

    const narrowed = narrow(analytics);

    // The whole point: the producer's cohort-wide number must be gone.
    expect(
      narrowed.canonicalMetrics?.canonicalLocPerDollar?.current.value
    ).not.toBe(PRODUCER_COHORT_RATIO);
    // And it must land on the SAME answer as the shipped ratio beside it, which
    // shares its numerator and its cohort-coverage gating. Asserting agreement
    // rather than a constant is what makes this survive a rule change to both.
    expect(narrowed.canonicalMetrics?.canonicalLocPerDollar?.current).toEqual(
      narrowed.canonicalMetrics?.locPerDollar.current
    );
  });

  it("leaves the canonical ratio absent when the producer omitted it", () => {
    // Version skew: the fallback must not invent a ratio a producer never sent,
    // or a tile reports a basis this response never computed.
    const analytics = canonicalAnalytics();

    const narrowed = narrow(analytics);

    expect(narrowed.canonicalMetrics?.canonicalLocPerDollar).toBeUndefined();
    // Positive sibling, so the absence above cannot pass by the whole rebind
    // having failed.
    expect(narrowed.canonicalMetrics?.locPerDollar.current).toBeDefined();
  });
});

function narrow(analytics: BranchAnalytics) {
  const wireRows = [wireRow()];
  return bindCanonicalMetricsToFilteredRows(
    analytics,
    wireRows,
    { ...DEFAULT_BRANCH_FILTERS, owners: ["github:daveth"] },
    { session1: 3.5 },
    [wireRows[0] as WireBranchRow, wireRow({ id: "branch-2" })]
  );
}

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
