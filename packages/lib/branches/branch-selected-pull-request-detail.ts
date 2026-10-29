import type { BranchPageDetail } from "@repo/api/src/types/branch";
import {
  type BranchSelectedPullRequestDetailResponse,
  mergeBranchPullRequestDetail as mergeBranchPullRequestFields,
} from "@repo/api/src/types/branch-selected-pull-request-detail";
import { calculateBranchSelectedCycleMetrics } from "./branch-detail-outcomes";

/** Lifetime metrics and selected-cycle attribution use the same cached evidence. */
export function mergeBranchPullRequestDetail(
  branch: BranchPageDetail,
  selection: BranchSelectedPullRequestDetailResponse
): BranchPageDetail {
  const detail = mergeBranchPullRequestFields(branch, selection);
  const metrics =
    branch.canonicalMetrics ?? branch.canonicalProjection?.detail?.metrics;
  if (!metrics || selection.canonicalMetricCycle === undefined) {
    return detail;
  }
  const selectedMetrics = {
    ...metrics,
    ...calculateBranchSelectedCycleMetrics(
      branch.phaseAttribution,
      selection.canonicalMetricCycle
    ),
  };
  detail.canonicalMetrics = selectedMetrics;
  if (detail.canonicalProjection?.detail) {
    detail.canonicalProjection = {
      ...detail.canonicalProjection,
      detail: {
        ...detail.canonicalProjection.detail,
        metrics: selectedMetrics,
      },
    };
  }
  return detail;
}
