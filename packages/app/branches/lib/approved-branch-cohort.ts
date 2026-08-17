import type {
  BranchAnalytics,
  BranchRow as WireBranchRow,
} from "@repo/api/src/types/branch";
import type {
  BranchAnalyticsCohortRequest,
  BranchAnalyticsCohortResponse,
} from "@repo/api/src/types/branch-analytics-cohort";
import type { BranchListMetricBundle } from "@repo/api/src/types/branch-metrics";
import type { DateRange } from "../../shared/lib/format-utils";
import {
  bindCanonicalMetricsToFilteredRows,
  hasApprovedBranchFilters,
} from "./approved-filtered-metrics";
import type { BranchFilters } from "./branch-row";

type ApprovedBranchCohortRequestInput = {
  filteredRows: readonly WireBranchRow[];
  unfilteredRows: readonly WireBranchRow[];
  filters: BranchFilters;
  dateRange: DateRange;
  startDate: string | undefined;
  endDate: string | undefined;
};

type ApprovedBranchCohortAnalyticsInput = {
  analytics: BranchAnalytics | undefined;
  filteredRows: readonly WireBranchRow[];
  unfilteredRows: readonly WireBranchRow[];
  filters: BranchFilters;
  sessionCostUsd?: Readonly<Record<string, number>>;
  request: BranchAnalyticsCohortRequest | null;
  response: BranchAnalyticsCohortResponse | null | undefined;
};

/**
 * Build the exact canonical cohort request for the approved filtered List.
 * Empty, unchanged, or invalid-window cohorts stay on the truthful fallback.
 */
export function buildApprovedBranchCohortRequest({
  filteredRows,
  filters,
  dateRange,
  startDate,
  endDate,
}: ApprovedBranchCohortRequestInput): BranchAnalyticsCohortRequest | null {
  if (!hasApprovedBranchFilters(filters)) {
    return null;
  }
  const branchIds = uniqueSortedBranchIds(filteredRows);
  if (branchIds.length === 0) {
    return null;
  }
  if (dateRange === "all") {
    return { branchIds };
  }
  const startAt = startDate ? Date.parse(startDate) : Number.NaN;
  const endAt = endDate ? Date.parse(endDate) : Number.NaN;
  if (
    !(Number.isFinite(startAt) && Number.isFinite(endAt)) ||
    endAt < startAt
  ) {
    return null;
  }
  return {
    branchIds,
    startDate: new Date(startAt).toISOString(),
    endDate: new Date(endAt).toISOString(),
  };
}

/**
 * Accept producer metrics only when they cover every requested identity once.
 * A stale or version-skewed producer intersection otherwise stays unavailable
 * through the existing local fallback instead of describing a smaller cohort.
 */
export function selectExactBranchCohortMetrics(
  request: BranchAnalyticsCohortRequest | null,
  response: BranchAnalyticsCohortResponse | null | undefined
): BranchListMetricBundle | null {
  if (!(request && response)) {
    return null;
  }
  const requestedIds = new Set(request.branchIds);
  const matchedIds = new Set(response.matchedBranchIds);
  if (
    requestedIds.size !== request.branchIds.length ||
    matchedIds.size !== response.matchedBranchIds.length ||
    requestedIds.size !== matchedIds.size ||
    response.canonicalMetrics.cohortSize !== requestedIds.size
  ) {
    return null;
  }
  for (const branchId of requestedIds) {
    if (!matchedIds.has(branchId)) {
      return null;
    }
  }
  return response.canonicalMetrics;
}

/**
 * What the approved cards got, and WHY a comparison may be missing from it.
 *
 * ISS-5714 (review thread): both shells used to derive "a filter is why" from
 * `bound !== analytics`, and that is true on the exact-cohort path too, because
 * this producer returns a NEW OBJECT there as well. So a card whose `deltaPct`
 * came back `Unavailable`/`NotApplicable` from the PRODUCER — because a window
 * is genuinely missing data — was captioned "Comparisons aren't available while
 * filters are applied", blaming the facet for a data gap the facet did not
 * cause. That is the FEA-4241 failure mode (a reason that makes the user's own
 * data look like the problem) reintroduced by an identity check.
 *
 * The flag therefore reports the one thing the caption actually asserts: the
 * local fallback replaced the producer's comparisons. It is computed HERE,
 * beside the only two code paths that can set it, so no caller has to re-derive
 * it from object identity again.
 */
export type ApprovedBranchCohortAnalytics = {
  analytics: BranchAnalytics | undefined;
  /**
   * `true` only when {@link bindCanonicalMetricsToFilteredRows} actually
   * recomputed this bundle over the filtered rows and blanked its deltas. An
   * exact producer response is `false`: those metrics ARE the filtered cohort's,
   * so any gap left in them is the producer's reason to explain, not the filter's.
   */
  comparisonSuppressedByFilter: boolean;
};

/** Prefer an exact producer response and otherwise apply the honest fallback. */
export function bindApprovedBranchCohortAnalytics({
  analytics,
  filteredRows,
  unfilteredRows,
  filters,
  sessionCostUsd,
  request,
  response,
}: ApprovedBranchCohortAnalyticsInput): ApprovedBranchCohortAnalytics {
  if (!analytics) {
    return { analytics: undefined, comparisonSuppressedByFilter: false };
  }
  const cohortMetrics = selectExactBranchCohortMetrics(request, response);
  if (cohortMetrics) {
    return {
      analytics: { ...analytics, canonicalMetrics: cohortMetrics },
      comparisonSuppressedByFilter: false,
    };
  }
  // Once an exact cohort was requested, whole-list Session costs cannot prove
  // filtered-cohort spend. Other locally derivable metrics remain truthful.
  const fallbackSessionCostUsd = request ? undefined : sessionCostUsd;
  const fallback = bindCanonicalMetricsToFilteredRows(
    analytics,
    filteredRows,
    filters,
    fallbackSessionCostUsd,
    unfilteredRows
  );
  return {
    analytics: fallback,
    // Identity is a SOUND signal here and only here: `bindCanonicalMetricsToFilteredRows`
    // returns its `analytics` argument unchanged on the one path where it
    // declined to apply, and a fresh bundle on the one path where it did. The
    // defect was reading that signal one layer up, where a second producer path
    // also mints a new object.
    comparisonSuppressedByFilter: fallback !== analytics,
  };
}

function uniqueSortedBranchIds(rows: readonly WireBranchRow[]): string[] {
  return [...new Set(rows.map((row) => row.id))].sort();
}
