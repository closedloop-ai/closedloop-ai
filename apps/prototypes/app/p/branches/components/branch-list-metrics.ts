import { type DateRange, DateRange as DateRangeValue } from "../mock";
import { costCoveredBranchIdsForWindow } from "./branch-list-cost-coverage";
import {
  buildMetricWindows,
  completeMetric,
  exactUniqueIndex,
  hasExactUniqueCoverage,
  isTimestampInWindow,
  isTrustworthyTimestamp,
  isValidDivisor,
  isValidNonnegative,
  metricValue,
  noDataMetric,
  notApplicableMetric,
  partialMetric,
  reconcileByIdentity,
  unavailableMetric,
} from "./branch-list-metric-support";
import {
  type BranchMetricBundle,
  type BranchMetricEvidence,
  type CostContribution,
  CostPhase,
  type LocContribution,
  MetricDisclosure,
  type MetricPresentationState,
  type MetricResult,
  type MetricWindow,
  MetricPresentationState as PresentationState,
  type PullRequestEvidence,
} from "./branch-list-metric-types";

type WindowMetrics = {
  activeBranches: MetricResult;
  locPerDollar: MetricResult;
  medianPrSize: MetricResult;
  aiSpendUsd: MetricResult;
  mergeRatePct: MetricResult;
};

/**
 * Mirrors the production Branch List metric oracle over prototype-local data.
 * The caller supplies the filtered cohort before any table sorting or paging.
 */
export function calculateBranchListMetrics(
  cohortIds: readonly string[],
  evidence: BranchMetricEvidence,
  dateRange: DateRange,
  now: Date
): BranchMetricBundle {
  const windows = buildMetricWindows(dateRange, now);
  const scoped = scopeEvidence(cohortIds, evidence);
  const current = calculateWindowMetrics(
    cohortIds,
    scoped,
    windows.current,
    windows.current.endAt,
    false,
    dateRange
  );
  const prior = windows.prior
    ? calculateWindowMetrics(
        cohortIds,
        scoped,
        windows.prior,
        windows.current.endAt,
        true,
        dateRange
      )
    : null;
  return {
    label: windows.label,
    activeBranches: metricValue(
      current.activeBranches,
      prior?.activeBranches,
      windows.label
    ),
    locPerDollar: metricValue(
      current.locPerDollar,
      prior?.locPerDollar,
      windows.label
    ),
    medianPrSize: metricValue(
      current.medianPrSize,
      prior?.medianPrSize,
      windows.label
    ),
    aiSpendUsd: metricValue(
      current.aiSpendUsd,
      prior?.aiSpendUsd,
      windows.label
    ),
    mergeRatePct: metricValue(
      current.mergeRatePct,
      prior?.mergeRatePct,
      windows.label
    ),
  };
}

/** Parses the prototype-only, non-visible visual-QA state selector. */
export function parseMetricPresentationState(
  value: string | null | undefined
): MetricPresentationState {
  if (value === undefined || value === null || value.length > 64) {
    return PresentationState.Complete;
  }
  const states = Object.values(PresentationState);
  return states.includes(value as MetricPresentationState)
    ? (value as MetricPresentationState)
    : PresentationState.Complete;
}

function calculateWindowMetrics(
  cohortIds: readonly string[],
  evidence: BranchMetricEvidence,
  window: MetricWindow,
  evidenceHorizon: number,
  prior: boolean,
  dateRange: DateRange
): WindowMetrics {
  return {
    activeBranches: calculateActiveBranches(
      cohortIds,
      evidence,
      prior,
      dateRange
    ),
    locPerDollar: calculateLocPerDollar(
      cohortIds,
      evidence,
      window,
      evidenceHorizon
    ),
    medianPrSize: calculateMedianPrSize(
      cohortIds,
      evidence,
      window,
      evidenceHorizon
    ),
    aiSpendUsd: calculateAiSpend(cohortIds, evidence, window, evidenceHorizon),
    mergeRatePct: calculateMergeRate(
      cohortIds,
      evidence,
      window,
      evidenceHorizon
    ),
  };
}

function calculateActiveBranches(
  cohortIds: readonly string[],
  evidence: BranchMetricEvidence,
  prior: boolean,
  dateRange: DateRange
): MetricResult {
  if (cohortIds.length === 0) {
    return noDataMetric();
  }
  const cohort = new Set(cohortIds);
  const scopedSnapshots = evidence.statusSnapshots.filter((snapshot) =>
    cohort.has(snapshot.branchId)
  );
  const snapshots = reconcileByIdentity(
    scopedSnapshots,
    (snapshot) => snapshot.branchId
  );
  if (
    cohort.size !== cohortIds.length ||
    snapshots.conflicted ||
    snapshots.values.length !== scopedSnapshots.length
  ) {
    return unavailableMetric();
  }
  let value = 0;
  for (const snapshot of snapshots.values) {
    const active = prior
      ? priorActiveForRange(snapshot.priorActiveByRange, dateRange)
      : snapshot.currentActive;
    if (active === null) {
      return unavailableMetric();
    }
    if (active) {
      value += 1;
    }
  }
  return snapshots.values.length === cohortIds.length
    ? completeMetric(value)
    : partialMetric(value, MetricDisclosure.DefaultIncomplete);
}

function priorActiveForRange(
  priorActiveByRange: BranchMetricEvidence["statusSnapshots"][number]["priorActiveByRange"],
  dateRange: DateRange
): boolean | null {
  if (dateRange === DateRangeValue.All) {
    return null;
  }
  return priorActiveByRange[dateRange];
}

function calculateLocPerDollar(
  cohortIds: readonly string[],
  evidence: BranchMetricEvidence,
  window: MetricWindow,
  evidenceHorizon: number
): MetricResult {
  if (cohortIds.length === 0) {
    return noDataMetric();
  }
  const snapshots = exactUniqueIndex(
    evidence.statusSnapshots,
    (snapshot) => snapshot.branchId,
    cohortIds
  );
  if (snapshots === null) {
    return unavailableMetric();
  }
  const branchIds = [...snapshots.keys()];
  const loc = reconcileByIdentity(evidence.locContributions, (item) =>
    evidenceIdentity(item.sourceEventId, item.branchId)
  );
  const costs = reconcileByIdentity(evidence.costContributions, (item) =>
    evidenceIdentity(item.sourceEventId, item.branchId)
  );
  const locInvalid =
    loc.conflicted ||
    evidence.locContributions.some((item) =>
      invalidLocContribution(item, window, evidenceHorizon)
    );
  const costInvalid =
    costs.conflicted ||
    evidence.costContributions.some((item) =>
      invalidCostContribution(item, evidenceHorizon)
    );
  const locByBranch = sumLocByBranch(loc.values, window);
  const costByBranch = sumCostByBranch(costs.values, window);
  const locCoverageComplete = hasExactUniqueCoverage(
    branchIds,
    evidence.locCompleteBranchIds
  );
  const costCoveredIds = costCoveredBranchIdsForWindow(
    branchIds,
    evidence,
    window,
    evidenceHorizon
  );
  const costCoverageComplete = hasExactUniqueCoverage(
    branchIds,
    costCoveredIds
  );
  const locCovered = new Set(evidence.locCompleteBranchIds);
  const costCovered = new Set(costCoveredIds);
  const pairs = branchIds.flatMap((branchId) => {
    const branchLoc = locByBranch.get(branchId);
    if (
      branchLoc === undefined ||
      !locCovered.has(branchId) ||
      !costCovered.has(branchId)
    ) {
      return [];
    }
    return [{ loc: branchLoc, cost: costByBranch.get(branchId) ?? 0 }];
  });
  const completeCoverage =
    locCoverageComplete && costCoverageComplete && !locInvalid && !costInvalid;
  if (pairs.length === 0) {
    return window.startAt === null && completeCoverage
      ? notApplicableMetric()
      : unavailableMetric();
  }
  const totalCost = pairs.reduce((sum, pair) => sum + pair.cost, 0);
  if (totalCost <= 0) {
    return completeCoverage ? notApplicableMetric() : unavailableMetric();
  }
  const totalLoc = pairs.reduce((sum, pair) => sum + pair.loc, 0);
  const value = totalLoc / totalCost;
  return completeCoverage
    ? completeMetric(value)
    : partialMetric(value, MetricDisclosure.LocIncomplete);
}

function calculateMedianPrSize(
  cohortIds: readonly string[],
  evidence: BranchMetricEvidence,
  window: MetricWindow,
  evidenceHorizon: number
): MetricResult {
  if (cohortIds.length === 0) {
    return noDataMetric();
  }
  const prs = reconcileByIdentity(
    evidence.pullRequests,
    (item) => item.identity
  );
  const invalidEvidence =
    prs.conflicted ||
    evidence.pullRequests.some((item) =>
      invalidPullRequest(item, evidenceHorizon)
    );
  const merged = prs.values.filter((item) =>
    isTimestampInWindow(item.mergedAt, window)
  );
  if (merged.length === 0) {
    return evidence.pullRequestCoverageComplete && !invalidEvidence
      ? noDataMetric()
      : unavailableMetric();
  }
  const sizes = merged.flatMap((item) =>
    isValidNonnegative(item.additions) && isValidNonnegative(item.deletions)
      ? [item.additions + item.deletions]
      : []
  );
  if (sizes.length === 0) {
    return unavailableMetric();
  }
  sizes.sort((left, right) => left - right);
  const middle = Math.floor(sizes.length / 2);
  const value =
    sizes.length % 2 === 0
      ? ((sizes[middle - 1] ?? 0) + (sizes[middle] ?? 0)) / 2
      : (sizes[middle] ?? 0);
  return evidence.pullRequestCoverageComplete &&
    !invalidEvidence &&
    sizes.length === merged.length
    ? completeMetric(value)
    : partialMetric(value, MetricDisclosure.PrIncomplete);
}

function calculateAiSpend(
  cohortIds: readonly string[],
  evidence: BranchMetricEvidence,
  window: MetricWindow,
  evidenceHorizon: number
): MetricResult {
  if (cohortIds.length === 0) {
    return noDataMetric();
  }
  const costs = reconcileByIdentity(evidence.costContributions, (item) =>
    evidenceIdentity(item.sourceEventId, item.branchId)
  );
  const invalidEvidence =
    costs.conflicted ||
    evidence.costContributions.some((item) =>
      invalidCostContribution(item, evidenceHorizon)
    );
  const contributions = costs.values.filter((item) =>
    isTimestampInWindow(item.occurredAt, window)
  );
  let total = 0;
  let included = 0;
  for (const item of contributions) {
    if (!invalidCostContribution(item, evidenceHorizon)) {
      total +=
        (item.costUsd as number) / (item.qualifyingBranchCount as number);
      included += 1;
    }
  }
  const completeCoverage =
    hasExactUniqueCoverage(
      cohortIds,
      costCoveredBranchIdsForWindow(
        cohortIds,
        evidence,
        window,
        evidenceHorizon
      )
    ) &&
    !invalidEvidence &&
    included === contributions.length;
  if (included === 0) {
    return completeCoverage ? completeMetric(0) : unavailableMetric();
  }
  return completeCoverage
    ? completeMetric(total)
    : partialMetric(total, MetricDisclosure.CostIncomplete);
}

function calculateMergeRate(
  cohortIds: readonly string[],
  evidence: BranchMetricEvidence,
  window: MetricWindow,
  evidenceHorizon: number
): MetricResult {
  if (cohortIds.length === 0) {
    return noDataMetric();
  }
  const prs = reconcileByIdentity(
    evidence.pullRequests,
    (item) => item.identity
  );
  const invalidEvidence =
    prs.conflicted ||
    evidence.pullRequests.some((item) =>
      invalidPullRequest(item, evidenceHorizon)
    );
  const merged = prs.values.filter((item) =>
    isTimestampInWindow(item.mergedAt, window)
  );
  const closed = prs.values.filter(
    (item) =>
      item.mergedAt === null &&
      !item.isDraft &&
      isTimestampInWindow(item.closedAt, window)
  );
  const decided = merged.length + closed.length;
  if (decided === 0) {
    return evidence.pullRequestCoverageComplete && !invalidEvidence
      ? notApplicableMetric()
      : unavailableMetric();
  }
  const value = (merged.length / decided) * 100;
  return evidence.pullRequestCoverageComplete && !invalidEvidence
    ? completeMetric(value)
    : partialMetric(value, MetricDisclosure.DefaultIncomplete);
}

function scopeEvidence(
  cohortIds: readonly string[],
  evidence: BranchMetricEvidence
): BranchMetricEvidence {
  const ids = new Set(cohortIds);
  return {
    statusSnapshots: evidence.statusSnapshots.filter((item) =>
      ids.has(item.branchId)
    ),
    locContributions: evidence.locContributions.filter((item) =>
      ids.has(item.branchId)
    ),
    locCompleteBranchIds: evidence.locCompleteBranchIds.filter((id) =>
      ids.has(id)
    ),
    costContributions: evidence.costContributions.filter((item) =>
      ids.has(item.branchId)
    ),
    costIncompleteContributions: evidence.costIncompleteContributions.filter(
      (item) => ids.has(item.branchId)
    ),
    costCompleteBranchIds: evidence.costCompleteBranchIds.filter((id) =>
      ids.has(id)
    ),
    pullRequests: evidence.pullRequests.filter((item) =>
      ids.has(item.branchId)
    ),
    pullRequestCoverageComplete: evidence.pullRequestCoverageComplete,
  };
}

function sumLocByBranch(
  contributions: readonly LocContribution[],
  window: MetricWindow
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const item of contributions) {
    if (
      locEvidenceFallsInWindow(item.occurredAt, window) &&
      isValidNonnegative(item.additions) &&
      isValidNonnegative(item.deletions)
    ) {
      totals.set(
        item.branchId,
        (totals.get(item.branchId) ?? 0) + item.additions + item.deletions
      );
    }
  }
  return totals;
}

function sumCostByBranch(
  contributions: readonly CostContribution[],
  window: MetricWindow
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const item of contributions) {
    if (
      isTimestampInWindow(item.occurredAt, window) &&
      !invalidCostContribution(item, window.endAt)
    ) {
      totals.set(
        item.branchId,
        (totals.get(item.branchId) ?? 0) +
          (item.costUsd as number) / (item.qualifyingBranchCount as number)
      );
    }
  }
  return totals;
}

function invalidLocContribution(
  item: LocContribution,
  window: MetricWindow,
  evidenceHorizon: number
): boolean {
  return !(
    item.sourceEventId &&
    item.branchId &&
    isLocContributionTimestampValid(item.occurredAt, window, evidenceHorizon) &&
    isValidNonnegative(item.additions) &&
    isValidNonnegative(item.deletions)
  );
}

function locEvidenceFallsInWindow(
  occurredAt: string | null,
  window: MetricWindow
): boolean {
  return occurredAt === null
    ? window.startAt === null
    : isTimestampInWindow(occurredAt, window);
}

function isLocContributionTimestampValid(
  occurredAt: string | null,
  window: MetricWindow,
  evidenceHorizon: number
): boolean {
  return occurredAt === null
    ? window.startAt === null
    : isTrustworthyTimestamp(occurredAt, evidenceHorizon);
}

function invalidCostContribution(
  item: CostContribution,
  evidenceHorizon: number
): boolean {
  return !(
    item.sourceEventId &&
    item.branchId &&
    item.sessionId &&
    isTrustworthyTimestamp(item.occurredAt, evidenceHorizon) &&
    Object.values(CostPhase).includes(item.phase as CostPhase) &&
    isValidNonnegative(item.costUsd) &&
    isValidDivisor(item.qualifyingBranchCount)
  );
}

function invalidPullRequest(
  item: PullRequestEvidence,
  evidenceHorizon: number
): boolean {
  const mergedInvalid =
    item.mergedAt !== null &&
    !isTrustworthyTimestamp(item.mergedAt, evidenceHorizon);
  const closedInvalid =
    item.closedAt !== null &&
    !isTrustworthyTimestamp(item.closedAt, evidenceHorizon);
  return !(item.identity && item.branchId) || mergedInvalid || closedInvalid;
}

function evidenceIdentity(sourceEventId: string, branchId: string): string {
  return sourceEventId && branchId ? `${sourceEventId}\0${branchId}` : "";
}
