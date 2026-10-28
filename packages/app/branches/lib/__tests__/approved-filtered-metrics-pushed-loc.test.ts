/**
 * @file approved-filtered-metrics-pushed-loc.test.ts
 * @description ISS-9957/ISS-9958 — the filtered-cohort binder must rebind the
 * pushed-LOC total and its ratio, not carry the producer's UNFILTERED values
 * through its `...metrics` spread.
 *
 * THE DEFECT THIS PINS. Both folds in `approved-filtered-metrics.ts` rebind
 * every rendered bundle field explicitly and spread the rest. A newly added
 * optional field therefore rides the spread through untouched, so with a facet
 * applied the two canonical cards would report the WHOLE cohort while Active
 * branches, Median PR size and Merge rate beside them report the matched
 * subset — two populations on one row. The file's own comments already name
 * this hazard for three sibling companions; these cases make it fail instead.
 *
 * The expected values are literals chosen to be impossible to confuse: the
 * producer's unfiltered figures are 5000 and 20, so a regression that carries
 * them through shows up as those exact numbers rather than as an absence.
 */
import {
  type BranchAnalytics,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import {
  type BranchListMetricBundle,
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricDisclosure,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import { describe, expect, it } from "vitest";
import {
  bindCanonicalMetricsToFilteredRows,
  republishPartialCohortMetrics,
} from "../approved-filtered-metrics";
import { DEFAULT_BRANCH_FILTERS } from "../branch-row";
import { unavailableKpi, wireRow } from "./approved-branch-fixtures";

/** The producer's whole-list pushed-LOC total. Must never reach a filtered row. */
const UNFILTERED_PUSHED_LOC = 5000;
/** The producer's whole-list ratio. Same rule. */
const UNFILTERED_RATIO = 20;
/** What a partially-covered cohort actually measured for the matched subset. */
const COHORT_PUSHED_LOC = 900;

function complete(value: number) {
  return {
    current: { state: BranchMetricAvailability.Complete, value },
  } as const;
}

function bundleWithPushedFields(
  overrides: Partial<BranchListMetricBundle> = {}
): BranchListMetricBundle {
  const metric = complete(1);
  return {
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
    totalLocPushed: complete(UNFILTERED_PUSHED_LOC),
    pushedLocPerDollar: complete(UNFILTERED_RATIO),
    ...overrides,
  };
}

function analyticsWithPushedFields(): BranchAnalytics {
  return {
    viewerScope: BranchViewerScope.Self,
    canonicalMetrics: bundleWithPushedFields(),
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

/** A facet that removed a loaded row, which is what arms the fallback. */
function bindToOneOfTwoRows(analytics: BranchAnalytics) {
  const selected = wireRow();
  return bindCanonicalMetricsToFilteredRows(
    analytics,
    [selected],
    { ...DEFAULT_BRANCH_FILTERS, owners: ["github:daveth"] },
    { session1: 3.5 },
    [selected, wireRow({ id: "branch-2" })]
  );
}

describe("the filtered-cohort binder rebinds the pushed-LOC fields", () => {
  it("does not carry the producer's whole-list total onto a filtered row", () => {
    const narrowed = bindToOneOfTwoRows(analyticsWithPushedFields());

    // One deepEqual, so a surviving `value: 5000` beside any state fails — a
    // state-only check would pass on a Partial that still carried the number.
    expect(narrowed.canonicalMetrics?.totalLocPushed?.current).toEqual({
      state: BranchMetricAvailability.Unavailable,
      value: null,
    });
  });

  it("does not carry the producer's whole-list ratio onto a filtered row", () => {
    const narrowed = bindToOneOfTwoRows(analyticsWithPushedFields());

    expect(narrowed.canonicalMetrics?.pushedLocPerDollar?.current).toEqual({
      state: BranchMetricAvailability.Unavailable,
      value: null,
    });
  });

  /**
   * The sibling that proves the binder actually ran. Without it the two cases
   * above would pass on any code path that returned the analytics untouched —
   * including a future short-circuit — and would say nothing about the spread.
   */
  it("rebinds the row-provable fields in the same call", () => {
    const narrowed = bindToOneOfTwoRows(analyticsWithPushedFields());

    expect(narrowed.canonicalMetrics?.cohortSize).toBe(1);
    expect(narrowed.canonicalMetrics?.activeBranches.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 1,
    });
  });

  /**
   * A producer predating the fields must not be handed companions it never
   * sent — the binder adds them conditionally, so an older bundle stays absent
   * rather than gaining an Unavailable field the consumer would then render.
   */
  it("leaves the fields absent when the producer omitted them", () => {
    const analytics = analyticsWithPushedFields();
    const bundle = bundleWithPushedFields();
    // DELETED, not set to `undefined`: an older producer omits the key
    // entirely, and a key present with an undefined value is a different
    // object that the spread would still copy — so assigning undefined here
    // would test a shape no producer can send.
    Reflect.deleteProperty(bundle, "totalLocPushed");
    Reflect.deleteProperty(bundle, "pushedLocPerDollar");
    analytics.canonicalMetrics = bundle;

    const narrowed = bindToOneOfTwoRows(analytics);

    expect(narrowed.canonicalMetrics).not.toHaveProperty("totalLocPushed");
    expect(narrowed.canonicalMetrics).not.toHaveProperty("pushedLocPerDollar");
  });
});

describe("the partial-cohort republisher rebinds the pushed-LOC fields", () => {
  it("publishes the cohort's measured total, not the producer's", () => {
    const republished = republishPartialCohortMetrics(
      bundleWithPushedFields(),
      {
        metrics: bundleWithPushedFields({
          totalLocPushed: complete(COHORT_PUSHED_LOC),
        }),
        coverage: { included: 2, total: 3 },
      }
    );

    // The cohort measured 900 over 2 of 3 branches, so the figure is real and
    // survives — disclosed as Partial rather than discarded, and never the
    // producer's 5000.
    expect(republished.totalLocPushed?.current).toEqual({
      state: BranchMetricAvailability.Partial,
      value: COHORT_PUSHED_LOC,
      coverage: { included: 2, total: 3 },
      disclosure: BranchMetricDisclosure.BranchesIncomplete,
    });
  });
});
