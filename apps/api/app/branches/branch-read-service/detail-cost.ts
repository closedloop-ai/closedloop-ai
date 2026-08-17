import type { BranchPageDetail } from "@repo/api/src/types/branch";
import {
  attachSessionEvenSplitCosts,
  type BranchSessionCostUsage,
  evenSplitBranchCost,
  rawBranchCost,
} from "../branch-cost-attribution";

/**
 * Attach raw compatibility cost and canonical attributed cost to a cloud detail.
 *
 * The top-level fields and canonical list projection are written from the same
 * values, while every session retains its raw cost plus the divisor and its own
 * even-split share. This keeps detail, list, and timeline calculations aligned
 * without changing the legacy meaning of `estimatedCostUsd`.
 */
export function attachCanonicalCloudDetailCost(
  detail: BranchPageDetail,
  usage: BranchSessionCostUsage,
  branchCounts: Map<string, number>
): void {
  const replicatedUsd = rawBranchCost(usage);
  const attributedUsd = evenSplitBranchCost(usage, branchCounts);

  detail.estimatedCostUsd = replicatedUsd;
  detail.attributedCostUsd = attributedUsd;
  for (const session of detail.sessions) {
    session.branchCount = branchCounts.get(session.sessionId) ?? 1;
  }
  attachSessionEvenSplitCosts(detail, branchCounts);

  const cost = detail.canonicalProjection?.list.cost;
  if (cost) {
    cost.replicatedUsd = replicatedUsd;
    cost.attributedUsd = attributedUsd;
  }
}

/** Keep the canonical projection aligned after later detail finalization. */
export function synchronizeCanonicalCloudDetailCost(
  detail: BranchPageDetail
): void {
  const cost = detail.canonicalProjection?.list.cost;
  if (!cost) {
    return;
  }
  cost.replicatedUsd = detail.estimatedCostUsd;
  cost.attributedUsd = detail.attributedCostUsd;
}
