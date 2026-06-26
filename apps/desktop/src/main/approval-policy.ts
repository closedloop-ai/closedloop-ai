import type { RiskTier } from "../shared/contracts.js";
import type { OperationId } from "./approval-operations.js";

/**
 * Per-operation inherent risk tiers. The risk assigned reflects the
 * highest-risk HTTP method that each approval ID handles.
 */
export const OPERATION_RISK_TIERS: Record<
  OperationId,
  Exclude<RiskTier, "none">
> = {
  health_check: "low",
  repos_config: "medium",
  filesystem: "medium",
  symphony_status: "low",
  symphony_sessions: "medium",
  symphony_logs: "low",
  symphony_chat_history: "medium",
  git_action: "medium",
  git_local_changes: "low",
  git_local_commit_push: "high",
  git_pr: "medium",
  git_branch_worktree: "low",
  symphony_launch: "medium",
  symphony_loop: "medium",
  symphony_loop_kill: "medium",
  symphony_plan_loop: "medium",
  symphony_kill: "medium",
  symphony_chat: "medium",
  symphony_comment_chat: "medium",
  symphony_commit_message: "medium",
  symphony_plan: "medium",
  symphony_judges: "medium",
  terminal_chat: "medium",
  ticket_chat: "medium",
  run_viewer_chat: "medium",
  codex_review: "medium",
  codex_argue: "medium",
  deploy: "high",
  learnings: "medium",
  desktop_security_upgrade: "high",
  binary_paths_settings: "medium",
  update_and_restart: "high",
  browser_key_revoke: "high",
  browser_key_approval_request: "high",
};

/**
 * Operations that always require interactive user approval, regardless of the
 * configured defaultApprovalTier or per-operation auto-approval settings.
 */
export const FORCE_INTERACTIVE_OPERATIONS: ReadonlySet<OperationId> =
  new Set<OperationId>(["update_and_restart", "git_local_commit_push"]);

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
