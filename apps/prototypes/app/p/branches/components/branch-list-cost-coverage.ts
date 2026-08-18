import {
  isTimestampInWindow,
  isTrustworthyTimestamp,
} from "./branch-list-metric-support";
import type {
  BranchMetricEvidence,
  IncompleteCostContribution,
  MetricWindow,
} from "./branch-list-metric-types";

/**
 * Resolves Branches whose Session cost evidence is complete for one metric
 * window. An unavailable Session outside the window does not taint it, while
 * missing source coverage and untrustworthy timestamps still fail closed.
 */
export function costCoveredBranchIdsForWindow(
  branchIds: readonly string[],
  evidence: BranchMetricEvidence,
  window: MetricWindow,
  evidenceHorizon: number
): string[] {
  const branchesWithSessionEvidence = new Set([
    ...evidence.costCompleteBranchIds,
    ...evidence.costIncompleteContributions.map(({ branchId }) => branchId),
  ]);
  const incompleteInWindow = new Set(
    evidence.costIncompleteContributions
      .filter((item) =>
        incompleteCostAffectsWindow(item, window, evidenceHorizon)
      )
      .map(({ branchId }) => branchId)
  );
  return branchIds.filter(
    (branchId) =>
      branchesWithSessionEvidence.has(branchId) &&
      !incompleteInWindow.has(branchId)
  );
}

function incompleteCostAffectsWindow(
  item: IncompleteCostContribution,
  window: MetricWindow,
  evidenceHorizon: number
): boolean {
  return (
    !isTrustworthyTimestamp(item.occurredAt, evidenceHorizon) ||
    isTimestampInWindow(item.occurredAt, window)
  );
}
