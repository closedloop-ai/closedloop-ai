import type { RiskTier } from "../../shared/contracts.js";
import type { OperationId } from "./approval-operations.js";

/**
 * Per-operation inherent risk tiers. The risk assigned reflects the
 * highest-risk HTTP method that each approval ID handles.
 */
export const OPERATION_RISK_TIERS: Record<
  OperationId,
  Exclude<RiskTier, "none">
> = {
  repos_config: "medium",
  filesystem: "medium",
  git_action: "medium",
  git_local_changes: "low",
  git_local_commit_push: "high",
  git_pr: "medium",
  git_branch_worktree: "low",
  desktop_security_upgrade: "high",
  binary_paths_settings: "medium",
  github_resync_nudge: "low",
  // A member-dispatched pack install runs a vetted installer that modifies the
  // node's environment, so it is high-risk.
  member_pack_install: "high",
};

/**
 * Operations that always require interactive user approval, regardless of the
 * configured defaultApprovalTier or per-operation auto-approval settings.
 */
export const FORCE_INTERACTIVE_OPERATIONS: ReadonlySet<OperationId> =
  new Set<OperationId>(["git_local_commit_push"]);

/** Converts a RiskTier to a numeric value for threshold comparison. */
export function riskTierOrder(tier: RiskTier): number {
  switch (tier) {
    case "none":
      return 0;
    case "low":
      return 1;
    case "medium":
      return 2;
    case "high":
      return 3;
  }
}

/**
 * Returns true if the operation should be auto-approved based on the
 * configured policy threshold. Unknown operations default to "high" risk.
 */
export function shouldAutoApprove(
  operationId: string,
  configuredTier: RiskTier,
  forceApproval: boolean
): boolean {
  if (forceApproval) {
    return false;
  }
  const operationRisk =
    (OPERATION_RISK_TIERS as Record<string, Exclude<RiskTier, "none">>)[
      operationId
    ] ?? "high";
  return riskTierOrder(operationRisk) <= riskTierOrder(configuredTier);
}

export function shouldHonorAlwaysAllowRule(
  operationId: string,
  forceInteractiveOperations: ReadonlySet<string>
): boolean {
  return !forceInteractiveOperations.has(operationId);
}
