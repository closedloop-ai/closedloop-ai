import {
  type BranchAnalytics,
  BranchStatus,
  type BranchRow as WireBranchRow,
} from "@repo/api/src/types/branch";
import {
  type BranchListMetricBundle,
  type BranchListMetricValue,
  BranchMetricAvailability,
  type BranchMetricCoverage,
  BranchMetricDisclosure,
  type BranchMetricResult,
} from "@repo/api/src/types/branch-metrics";
import { reportableSpendUsd } from "@repo/lib/branches/spend-kpi";
import type { BranchFilters } from "./branch-row";

/** Whether an approved non-date facet is currently narrowing the List. */
export function hasApprovedBranchFilters(filters: BranchFilters): boolean {
  return (
    filters.names.length > 0 ||
    filters.owners.length > 0 ||
    filters.collaborators.length > 0 ||
    filters.statuses.length > 0 ||
    filters.pullRequests.length > 0 ||
    filters.lastActiveRanges.length > 0 ||
    filters.repos.length > 0 ||
    filters.tags.length > 0 ||
    filters.priorities.length > 0 ||
    filters.locMin !== undefined ||
    filters.locMax !== undefined ||
    Boolean(filters.search?.trim())
  );
}

/**
 * Compatibility fallback for a filtered cohort when the additive exact-cohort
 * producer is absent, stale, or cannot accept the cohort size. Current active
 * count and deduplicated windowed spend are defensible from List data;
 * event-history metrics fail closed to Unavailable unless `partialCohort`
 * carries a producer answer for a strict subset of the requested identities.
 *
 * Exactly two outcomes, and the caller depends on being able to tell them apart
 * by identity: the `analytics` argument returned UNCHANGED when this fallback
 * declined to apply, or a fresh bundle whose comparisons it blanked.
 */
export function bindCanonicalMetricsToFilteredRows(
  analytics: BranchAnalytics,
  rows: readonly WireBranchRow[],
  filters: BranchFilters,
  sessionCostUsd?: Readonly<Record<string, number>>,
  unfilteredRows: readonly WireBranchRow[] = rows,
  partialCohort?: PartialCohortMetrics
): BranchAnalytics {
  const metrics = analytics.canonicalMetrics;
  if (!(metrics && hasApprovedBranchFilters(filters))) {
    return analytics;
  }
  // The facet removed no loaded row, so every figure the producer sent already
  // describes exactly these rows. A partial cohort in THIS state is not handled
  // here — see `bindApprovedBranchCohortAnalyticsOverFilteredRowsWithPartialCohort`,
  // which republishes the three cohort-sourced metrics without disturbing the
  // rest.
  // Keeping this path a pure no-op is what lets the caller read "the fallback
  // replaced the producer's comparisons" off object identity.
  if (sameRowCohort(rows, unfilteredRows)) {
    return analytics;
  }
  const noData = unavailableForEmpty(rows);
  const activeCurrent = noData ?? filteredActiveBranches(rows);
  const spendCurrent = noData ?? filteredSpend(rows, sessionCostUsd);
  return {
    ...analytics,
    canonicalMetrics: {
      ...metrics,
      cohortSize: rows.length,
      activeBranches: replaceCurrent(metrics.activeBranches, activeCurrent),
      aiSpendUsd: replaceCurrent(metrics.aiSpendUsd, spendCurrent),
      // ISS-8968: these have no row-provable form, so before this change
      // they always failed closed. When the producer MEASURED a value over the
      // subset it matched, that figure is real, so publish it as Partial with a
      // disclosure rather than discarding a knowable number. A verdict is not a
      // measurement and does not survive — see `cohortPartial`. Absent a partial
      // answer the old fail-closed behaviour is unchanged, and the empty-rows
      // guard still wins first, as it does for every sibling above.
      locPerDollar: replaceCurrent(
        metrics.locPerDollar,
        noData ??
          cohortPartial(partialCohort, (bundle) => bundle.locPerDollar) ??
          unavailableMetric(rows)
      ),
      // ISS-9956, the same hazard as the two ratios above: the spread carries
      // the producer's UNFILTERED canonical ratio through, so the gated tile
      // would report the whole cohort while every sibling beside it reports the
      // filtered one. Its numerator is the same publication LOC `locPerDollar`
      // divides and has no row-provable form either, so it follows that field
      // rather than a stricter bar its producer never applied. Kept absent when
      // the producer omitted it, so a version-skewed response is not given a
      // companion it never sent.
      ...(metrics.canonicalLocPerDollar
        ? {
            canonicalLocPerDollar: replaceCurrent(
              metrics.canonicalLocPerDollar,
              noData ??
                cohortPartial(
                  partialCohort,
                  (bundle) => bundle.canonicalLocPerDollar
                ) ??
                unavailableMetric(rows)
            ),
          }
        : {}),
      medianPrSize: replaceCurrent(
        metrics.medianPrSize,
        noData ??
          cohortPartial(partialCohort, (bundle) => bundle.medianPrSize) ??
          unavailableMetric(rows)
      ),
      mergeRatePct: replaceCurrent(
        metrics.mergeRatePct,
        noData ??
          cohortPartial(partialCohort, (bundle) => bundle.mergeRatePct) ??
          unavailableMetric(rows)
      ),
      // ISS-9957/ISS-9958, the same hazard as every companion around it: the
      // spread carries the producer's UNFILTERED pushed-LOC total and its ratio
      // through, so the two canonical cards would report the whole cohort while
      // the four beside them report the filtered rows — two populations on one
      // row. Neither has a row-provable form (a Branch row carries no push LOC),
      // so absent a producer answer for the matched subset they fail closed
      // exactly as `locPerDollar` and `mergeRatePct` do. Kept absent when the
      // producer omitted them, so a version-skewed response is not handed a
      // companion it never sent.
      ...(metrics.totalLocPushed
        ? {
            totalLocPushed: replaceCurrent(
              metrics.totalLocPushed,
              noData ??
                cohortPartial(
                  partialCohort,
                  (bundle) => bundle.totalLocPushed
                ) ??
                unavailableMetric(rows)
            ),
          }
        : {}),
      ...(metrics.pushedLocPerDollar
        ? {
            pushedLocPerDollar: replaceCurrent(
              metrics.pushedLocPerDollar,
              noData ??
                cohortPartial(
                  partialCohort,
                  (bundle) => bundle.pushedLocPerDollar
                ) ??
                unavailableMetric(rows)
            ),
          }
        : {}),
      // The spread above would otherwise carry the producer's UNFILTERED
      // range-scoped companion through untouched, so a gated tile would report
      // the whole cohort while the four beside it report the filtered one.
      ...(metrics.windowScoped
        ? {
            windowScoped: {
              activeBranches: replaceCurrent(
                metrics.windowScoped.activeBranches,
                activeCurrent
              ),
              aiSpendUsd: replaceCurrent(
                metrics.windowScoped.aiSpendUsd,
                spendCurrent
              ),
            },
          }
        : {}),
    },
  };
}

export function replaceCurrent(
  metric: BranchListMetricValue,
  current: BranchMetricResult<number>
): BranchListMetricValue {
  // ISS-10363: the series is deliberately NOT carried over. It was folded over
  // the producer's cohort, and this path has just replaced the figure with a
  // different cohort's answer — so keeping the line would draw one population
  // under another's number. This client has no per-bucket evidence to re-fold,
  // so the honest result is no series, which renders as no mark.
  return {
    current,
    ...(metric.comparison
      ? {
          comparison: {
            label: metric.comparison.label,
            priorWindow: metric.comparison.priorWindow,
            deltaPct: {
              state: BranchMetricAvailability.Unavailable,
              value: null,
            } as const,
          },
        }
      : {}),
  };
}

export function unavailableForEmpty(
  rows: readonly WireBranchRow[]
): BranchMetricResult<number> | null {
  return rows.length === 0
    ? { state: BranchMetricAvailability.NoData, value: null }
    : null;
}

function unavailableMetric(
  rows: readonly WireBranchRow[]
): BranchMetricResult<number> {
  return (
    unavailableForEmpty(rows) ?? {
      state: BranchMetricAvailability.Unavailable,
      value: null,
    }
  );
}

export function filteredSpend(
  rows: readonly WireBranchRow[],
  sessionCostUsd?: Readonly<Record<string, number>>
): BranchMetricResult<number> {
  if (!sessionCostUsd) {
    return { state: BranchMetricAvailability.Unavailable, value: null };
  }
  const selectedSessionIds = new Set<string>();
  for (const row of rows) {
    for (const sessionId of new Set(row.sessionIds)) {
      selectedSessionIds.add(sessionId);
    }
  }
  if (selectedSessionIds.size === 0) {
    return { state: BranchMetricAvailability.Unavailable, value: null };
  }
  let total = 0;
  let included = 0;
  for (const sessionId of selectedSessionIds) {
    if (Object.hasOwn(sessionCostUsd, sessionId)) {
      total += sessionCostUsd[sessionId] ?? 0;
      included += 1;
    }
  }
  if (included === 0) {
    return { state: BranchMetricAvailability.Unavailable, value: null };
  }
  // ISS-4737's null-on-zero rule, via the SHARED `reportableSpendUsd` kernel
  // rather than a fourth hand-maintained copy. Its doc comment names the three
  // producers of this ONE card (api `branch-analytics-kpis`, desktop
  // `branch-analytics-projection`, client `filtered-branch-analytics`); the
  // approved List cohort binder is the fourth and was keying availability on
  // "did ANY priced session contribute", so a filtered subset whose priced
  // sessions summed to exactly $0 rendered `$0` — asserting "this cost nothing"
  // where the truth is "we have no spend figure for this set". `NoData` (not
  // `Unavailable`) because the cohort IS priced, matching the empty-cohort arm
  // above and rendering the card's "No data" state instead of an "—" dash.
  const reportable = reportableSpendUsd(total);
  if (reportable === null) {
    return { state: BranchMetricAvailability.NoData, value: null };
  }
  if (included === selectedSessionIds.size) {
    return { state: BranchMetricAvailability.Complete, value: reportable };
  }
  return {
    state: BranchMetricAvailability.Partial,
    value: reportable,
    coverage: { included, total: selectedSessionIds.size },
    disclosure: BranchMetricDisclosure.CostIncomplete,
  };
}

export function filteredActiveBranches(
  rows: readonly WireBranchRow[]
): BranchMetricResult<number> {
  let active = 0;
  for (const row of rows) {
    const classification = classifyActive(row.status);
    if (classification === null) {
      return { state: BranchMetricAvailability.Unavailable, value: null };
    }
    if (classification) {
      active += 1;
    }
  }
  return { state: BranchMetricAvailability.Complete, value: active };
}

function classifyActive(status: BranchStatus): boolean | null {
  switch (status) {
    case BranchStatus.Merged:
    case BranchStatus.Closed:
      return false;
    case BranchStatus.Open:
    case BranchStatus.Review:
    case BranchStatus.Draft:
    case BranchStatus.Blocked:
      return true;
    default:
      return null;
  }
}

/** Whether the active filters left the loaded row identities unchanged. */
export function sameRowCohort(
  rows: readonly WireBranchRow[],
  unfilteredRows: readonly WireBranchRow[]
): boolean {
  if (rows.length !== unfilteredRows.length) {
    return false;
  }
  const rowIds = new Set(rows.map((row) => row.id));
  return unfilteredRows.every((row) => rowIds.has(row.id));
}

/** A producer answer covering part of the requested cohort, plus its coverage. */
export type PartialCohortMetrics = {
  metrics: BranchListMetricBundle;
  coverage: BranchMetricCoverage;
};

/**
 * Republish one producer value from a partially-covered cohort.
 *
 * Only a value the producer actually measured survives, and it is always
 * disclosed. `Complete` becomes `Partial` carrying the COHORT's coverage and
 * the disclosure naming that cause. Already-`Partial` keeps the producer's own
 * coverage — it describes ITS evidence (a median over 1 of 2 matched pull
 * requests) and restamping it with 2-of-3 branches would claim coverage the
 * metric never had (review, whitlockk) — but takes the disclosure that names BOTH
 * narrowings, because the star alone does not carry a cause and the producer's
 * sentence alone would let the reader believe every branch was measured.
 *
 * Every verdict state returns undefined, INCLUDING `NotApplicable` and `NoData`,
 * and what that means is the CALLER's to decide — the two differ because their
 * populations do. `bindCanonicalMetricsToFilteredRows` fails closed to its
 * unavailable, because there the rows genuinely narrowed and it has no figure
 * for the selection. `republishPartialCohortMetrics` keeps the producer's value
 * untouched, because there the rows did NOT narrow, so the whole-list figure
 * already describes exactly the selection on screen. Those two are claims
 * about a population, and the producer made them about the subset it matched,
 * not about the selection on screen: "no decided PRs" over 2 of 3 branches does
 * not establish that the third has none. The result type gives them neither
 * `coverage` nor `disclosure`, so there is no way to publish one qualified —
 * it would render as a bare "N/A" asserting the whole selection. Unavailable is
 * the honest answer and the one the pre-ISS-8968 code gave.
 *
 * That is deliberately ASYMMETRIC with `selectExactBranchCohortMetrics`, which
 * passes both verdicts through untouched: there the producer answered for
 * exactly the requested identities, so its population claim is the selection's.
 */
function cohortPartial(
  partialCohort: PartialCohortMetrics | undefined,
  select: (bundle: BranchListMetricBundle) => BranchListMetricValue | undefined
): BranchMetricResult<number> | undefined {
  if (!partialCohort) {
    return undefined;
  }
  // An OPTIONAL field the producer may not carry: a cohort response predating
  // it selects undefined, which is "no answer for this metric", not an absent
  // producer. Each caller's own fallback then applies.
  const selected = select(partialCohort.metrics);
  if (!selected) {
    return undefined;
  }
  const current = selected.current;
  if (current.state === BranchMetricAvailability.Partial) {
    return {
      ...current,
      disclosure: BranchMetricDisclosure.BranchesAndEvidenceIncomplete,
    };
  }
  if (current.state !== BranchMetricAvailability.Complete) {
    return undefined;
  }
  return {
    coverage: partialCohort.coverage,
    disclosure: BranchMetricDisclosure.BranchesIncomplete,
    state: BranchMetricAvailability.Partial,
    value: current.value,
  };
}

/**
 * Republish ONLY the three cohort-sourced metrics over a partially-covered
 * cohort, leaving the rest of the producer's bundle exactly as it arrived.
 *
 * For the case where an active facet removed no loaded row and the producer
 * still answered for a strict subset. The three event-history metrics have a
 * narrower population to report, and nothing else does: `cohortSize`,
 * `activeBranches`, `aiSpendUsd`, its reconciled companion and the window-scoped
 * block all describe the same rows they always did, so re-deriving them here
 * would blank a spend figure the reader was using to buy a star on three others.
 * A REPUBLISHED metric loses its own delta — its current value now covers a
 * smaller population than the prior window, so the comparison is not the
 * producer's to keep. A metric the cohort declined keeps everything, delta
 * included: its value never changed, so its comparison is still valid. Every
 * other card's comparison survives either way.
 */
export function republishPartialCohortMetrics(
  metrics: BranchListMetricBundle,
  partialCohort: PartialCohortMetrics
): BranchListMetricBundle {
  return {
    ...metrics,
    locPerDollar: republishOne(
      metrics.locPerDollar,
      partialCohort,
      (bundle) => bundle.locPerDollar
    ),
    medianPrSize: republishOne(
      metrics.medianPrSize,
      partialCohort,
      (bundle) => bundle.medianPrSize
    ),
    mergeRatePct: republishOne(
      metrics.mergeRatePct,
      partialCohort,
      (bundle) => bundle.mergeRatePct
    ),
    // Same family as the three above: one publication-LOC derivation, one
    // cohort-coverage gate. Omitting them left the two canonical cards
    // reporting the WHOLE list beside three fields reporting the matched
    // subset. Conditional so a producer that predates the fields is not handed
    // one.
    //
    // ISS-10636: `canonicalLocPerDollar` is the THIRD of that family and was
    // still missing. It went unnoticed because the LOC per $ card only reads it
    // with the total-estimated-cost gate open; gate closed the card read
    // `locPerDollar`, which IS republished above. Retiring the gate makes the
    // card read this field for every user, so on the same-rows partial path it
    // reported the WHOLE LIST beside two rowmates reporting the matched subset
    // — the exact defect the note above says was closed for the other two.
    ...(metrics.canonicalLocPerDollar
      ? {
          canonicalLocPerDollar: republishOne(
            metrics.canonicalLocPerDollar,
            partialCohort,
            (bundle) => bundle.canonicalLocPerDollar
          ),
        }
      : {}),
    ...(metrics.totalLocPushed
      ? {
          totalLocPushed: republishOne(
            metrics.totalLocPushed,
            partialCohort,
            (bundle) => bundle.totalLocPushed
          ),
        }
      : {}),
    ...(metrics.pushedLocPerDollar
      ? {
          pushedLocPerDollar: republishOne(
            metrics.pushedLocPerDollar,
            partialCohort,
            (bundle) => bundle.pushedLocPerDollar
          ),
        }
      : {}),
  };
}

/**
 * One metric on the same-rows path: the cohort's answer when it measured one,
 * otherwise the producer's value UNTOUCHED — object and comparison included.
 *
 * Routing the decline through `replaceCurrent` would keep the value and blank
 * its `deltaPct`, which is the same "blank a comparison the filter did not
 * narrow" defect this whole path exists to avoid, one metric wide instead of
 * five. Untouched has to mean untouched.
 */
function republishOne(
  metric: BranchListMetricValue,
  partialCohort: PartialCohortMetrics,
  select: (bundle: BranchListMetricBundle) => BranchListMetricValue | undefined
): BranchListMetricValue {
  const republished = cohortPartial(partialCohort, select);
  return republished ? replaceCurrent(metric, republished) : metric;
}
