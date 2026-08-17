import {
  type BranchAnalytics,
  BranchStatus,
  type BranchRow as WireBranchRow,
} from "@repo/api/src/types/branch";
import {
  type BranchListMetricValue,
  BranchMetricAvailability,
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
    filters.locMin !== undefined ||
    filters.locMax !== undefined
  );
}

/**
 * Compatibility fallback for a filtered cohort when the additive exact-cohort
 * producer is absent, stale, or cannot accept the cohort size. Current active
 * count and deduplicated windowed spend are defensible from List data;
 * event-history metrics fail closed to Unavailable.
 */
export function bindCanonicalMetricsToFilteredRows(
  analytics: BranchAnalytics,
  rows: readonly WireBranchRow[],
  filters: BranchFilters,
  sessionCostUsd?: Readonly<Record<string, number>>,
  unfilteredRows: readonly WireBranchRow[] = rows
): BranchAnalytics {
  const metrics = analytics.canonicalMetrics;
  if (
    !(
      metrics &&
      hasApprovedBranchFilters(filters) &&
      !sameRowCohort(rows, unfilteredRows)
    )
  ) {
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
      locPerDollar: replaceCurrent(
        metrics.locPerDollar,
        unavailableMetric(rows)
      ),
      medianPrSize: replaceCurrent(
        metrics.medianPrSize,
        unavailableMetric(rows)
      ),
      mergeRatePct: replaceCurrent(
        metrics.mergeRatePct,
        unavailableMetric(rows)
      ),
    },
  };
}

function replaceCurrent(
  metric: BranchListMetricValue,
  current: BranchMetricResult<number>
): BranchListMetricValue {
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

function unavailableForEmpty(
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

function filteredSpend(
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

function filteredActiveBranches(
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

function sameRowCohort(
  rows: readonly WireBranchRow[],
  unfilteredRows: readonly WireBranchRow[]
): boolean {
  if (rows.length !== unfilteredRows.length) {
    return false;
  }
  const rowIds = new Set(rows.map((row) => row.id));
  return unfilteredRows.every((row) => rowIds.has(row.id));
}
