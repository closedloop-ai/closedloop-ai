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
  type bindCanonicalMetricsToFilteredRows,
  hasApprovedBranchFilters,
  type PartialCohortMetrics,
  republishPartialCohortMetrics,
  sameRowCohort,
} from "./approved-filtered-metrics";
import type { BranchFilters } from "./branch-row";
import { recomputeCanonicalMetricsOverFilteredRows } from "./filtered-cohort-recompute";

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
 * Anything short of that falls through: a STRICT SUBSET is
 * {@link selectPartialBranchCohortMetrics}' to describe, and a response naming
 * an identity nobody requested stays unavailable through the local fallback,
 * because it answers for some other cohort rather than a smaller one.
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
 * Accept a producer answer that covers a SUBSET of the requested identities.
 *
 * ISS-8968: the producer narrows the request twice — to authorized candidates,
 * then to those that projected an analytics row — and computes its metrics over
 * exactly what survived. That answer is correct for its own population, so
 * discarding it blanks three cards over a cohort we can describe precisely.
 *
 * {@link selectExactBranchCohortMetrics} cannot draw this line: a SMALLER cohort
 * and a WRONG one both fail its equality test. This does draw it — every matched
 * identity must be one we asked for, and at least one must remain. An identity we
 * never requested means the answer describes some other cohort, which stays
 * rejected; a strictly smaller set means the answer is ours, minus branches the
 * producer declined, and the caller publishes it as Partial with its coverage.
 */
export function selectPartialBranchCohortMetrics(
  request: BranchAnalyticsCohortRequest | null,
  response: BranchAnalyticsCohortResponse | null | undefined
): PartialCohortMetrics | null {
  if (!(request && response)) {
    return null;
  }
  const requestedIds = new Set(request.branchIds);
  const matchedIds = new Set(response.matchedBranchIds);
  // Duplicates make both counts unreliable, so neither set can be compared.
  // `cohortSize === matchedBranchIds.length` is already enforced by the response
  // schema, so it needs no second check here.
  if (
    requestedIds.size !== request.branchIds.length ||
    matchedIds.size !== response.matchedBranchIds.length ||
    matchedIds.size === 0 ||
    matchedIds.size >= requestedIds.size
  ) {
    return null;
  }
  for (const branchId of matchedIds) {
    if (!requestedIds.has(branchId)) {
      return null;
    }
  }
  return {
    coverage: { included: matchedIds.size, total: requestedIds.size },
    metrics: response.canonicalMetrics,
  };
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
  /**
   * `true` when the LOCAL fallback authored these figures rather than the
   * producer — so every absence in them is this client's own derivation falling
   * short, never a statement about the data behind it.
   *
   * marisolashgrove, ISS-12638: the Branches strip's connect ask may not be keyed
   * on an availability bucket, because the fallback writes `Unavailable` for
   * reasons GitHub cannot fix — a cohort whose merged branches are all multi-PR
   * (`filtered-cohort-recompute.ts`), and the event-history cards it has no
   * row-provable form for (`approved-filtered-metrics.ts`). A host that offers
   * the ask on those sends a reader to a connect that leaves the card exactly
   * as it found it.
   *
   * Separate from {@link comparisonSuppressedByFilter}, which answers a
   * different question — whether the FILTER is the reason a comparison is
   * missing — and is `false` for the recompute binder by design.
   */
  metricsDerivedLocally: boolean;
};

function bindCohortAnalytics(
  {
    analytics,
    filteredRows,
    unfilteredRows,
    filters,
    sessionCostUsd,
    request,
    response,
  }: ApprovedBranchCohortAnalyticsInput,
  partialCohort: PartialCohortMetrics | undefined,
  fallbackBinder: FilteredCohortFallback
): ApprovedBranchCohortAnalytics {
  if (!analytics) {
    return {
      analytics: undefined,
      comparisonSuppressedByFilter: false,
      metricsDerivedLocally: false,
    };
  }
  const cohortMetrics = selectExactBranchCohortMetrics(request, response);
  if (cohortMetrics) {
    return {
      analytics: { ...analytics, canonicalMetrics: cohortMetrics },
      comparisonSuppressedByFilter: false,
      metricsDerivedLocally: false,
    };
  }
  // ISS-8968 (review, davetho): an active facet can leave the loaded row IDs
  // unchanged while the producer still answers for a strict SUBSET of them.
  // Only the three cohort-sourced metrics have a narrower population to report
  // here — the rows did not narrow, so the producer's spend, active count,
  // window-scoped block and every comparison still describe exactly these rows.
  // Handled BEFORE the fallback because that fallback is all-or-nothing: taking
  // it would blank a spend figure the reader was using and caption every card
  // with a filter that removed nothing, which is the FEA-4241 failure mode.
  if (
    partialCohort &&
    analytics.canonicalMetrics &&
    hasApprovedBranchFilters(filters) &&
    sameRowCohort(filteredRows, unfilteredRows)
  ) {
    return {
      analytics: {
        ...analytics,
        canonicalMetrics: republishPartialCohortMetrics(
          analytics.canonicalMetrics,
          partialCohort
        ),
      },
      // The filter narrowed nothing, so it suppressed nothing.
      comparisonSuppressedByFilter: false,
      // The producer answered for a strict subset of these rows; the figures
      // republished here are its own.
      metricsDerivedLocally: false,
    };
  }
  // Once an exact cohort was requested, whole-list Session costs cannot prove
  // filtered-cohort spend. Other locally derivable metrics remain truthful.
  const fallbackSessionCostUsd =
    request && !fallbackBinder.sessionCostAfterRequest
      ? undefined
      : sessionCostUsd;
  const fallback = fallbackBinder.bind(
    analytics,
    filteredRows,
    filters,
    fallbackSessionCostUsd,
    unfilteredRows,
    partialCohort
  );
  return {
    analytics: fallback,
    // Identity is a SOUND signal here and only here: `bindCanonicalMetricsToFilteredRows`
    // returns its `analytics` argument unchanged on the one path where it
    // declined to apply, and a fresh bundle on the one path where it did. The
    // defect was reading that signal one layer up, where a second producer path
    // also mints a new object.
    comparisonSuppressedByFilter:
      fallbackBinder.blamesFilter && fallback !== analytics,
    // Same identity signal, read for the other question: the binder returns its
    // argument unchanged on the one path where it declined to apply.
    metricsDerivedLocally: fallback !== analytics,
  };
}

function uniqueSortedBranchIds(rows: readonly WireBranchRow[]): string[] {
  return [...new Set(rows.map((row) => row.id))].sort();
}

/**
 * ISS-9967: the binders every host uses, and since ISS-10734 the only two that
 * exist. Same exact-cohort precedence as one another; they differ only in
 * whether a partial cohort may answer, which the host picks by swapping a whole
 * binder rather than passing a flag down.
 *
 * The open side of the `branches-partial-cohort-metrics` flag is a separate
 * entry point, not a boolean parameter, so the flag picks between two whole
 * shapes at its read site: a helper taking `partialCohortEnabled` would make the
 * flag steer a derivation from inside, which is the shape
 * `scripts/lint/rules/no-threaded-feature-flag.ts` exists to stop.
 */
export function bindApprovedBranchCohortAnalyticsOverFilteredRows(
  input: ApprovedBranchCohortAnalyticsInput
): ApprovedBranchCohortAnalytics {
  return bindCohortAnalytics(input, undefined, RECOMPUTE_FALLBACK);
}

export function bindApprovedBranchCohortAnalyticsOverFilteredRowsWithPartialCohort(
  input: ApprovedBranchCohortAnalyticsInput
): ApprovedBranchCohortAnalytics {
  return bindCohortAnalytics(
    input,
    selectPartialBranchCohortMetrics(input.request, input.response) ??
      undefined,
    RECOMPUTE_FALLBACK
  );
}

/**
 * The fallback binder for a filtered cohort the exact producer did not answer,
 * as one whole shape: which function derives the figures, whether the
 * whole-list session cost map may feed it once a cohort was requested, and
 * whether its absences are the filter's to explain.
 *
 * ISS-10734 retired the fail-closed configuration, so {@link RECOMPUTE_FALLBACK}
 * is the only instance. The knobs stay declared rather than inlined because
 * `blamesFilter: false` is what the whole
 * `ApprovedBranchCohortAnalytics.comparisonSuppressedByFilter` chain — down to
 * the caption in `branch-list-comparison-copy.ts` — now hangs on, and collapsing
 * it here is a decision about that user-facing copy rather than about this type.
 */
type FilteredCohortFallback = {
  bind: typeof bindCanonicalMetricsToFilteredRows;
  /**
   * Whether the whole-list session cost map still feeds the fallback once an
   * exact cohort was requested. The recompute rule keeps it: the map is keyed by
   * session and narrowed to the sessions the rows on screen reference, which IS
   * the filtered cohort's spend.
   */
  sessionCostAfterRequest: boolean;
  /**
   * Whether an applied fallback is reported as `comparisonSuppressedByFilter`.
   * The recompute binder computes the cards over the cohort on screen — nothing
   * about them is a filter refusal, and its comparisons are absent for the same
   * reason any prior-window figure is, so the generic no-comparison copy is the
   * truthful one (ISS-9967 AC-3).
   */
  blamesFilter: boolean;
};

/** ISS-9967: recompute every row-derivable card over the filtered rows. */
const RECOMPUTE_FALLBACK: FilteredCohortFallback = {
  bind: recomputeCanonicalMetricsOverFilteredRows,
  sessionCostAfterRequest: true,
  blamesFilter: false,
};
