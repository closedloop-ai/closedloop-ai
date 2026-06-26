"use client";

import {
  BranchViewCommentActionRecovery,
  type BranchViewCommentActionResult,
  BranchViewCommentActionResultCode,
} from "@repo/api/src/types/branch-view";
import { toast } from "@repo/design-system/components/ui/sonner";

const GITHUB_PROJECTION_FAILURE_DEFAULT_DESCRIPTION =
  "Use the header refresh to update PR status and comments from GitHub.";

const GITHUB_PROJECTION_FAILURE_DESCRIPTION_BY_RECOVERY = {
  [BranchViewCommentActionRecovery.BranchViewSync]:
    GITHUB_PROJECTION_FAILURE_DEFAULT_DESCRIPTION,
  [BranchViewCommentActionRecovery.DirectReprojection]:
    GITHUB_PROJECTION_FAILURE_DEFAULT_DESCRIPTION,
} as const satisfies Partial<Record<BranchViewCommentActionRecovery, string>>;

function isGithubProjectionFailureResult(
  result: BranchViewCommentActionResult
): result is Extract<BranchViewCommentActionResult, { success: false }> {
  return (
    !result.success &&
    result.code === BranchViewCommentActionResultCode.GithubProjectionFailed
  );
}

function getGithubProjectionFailureDescription(
  result: Extract<BranchViewCommentActionResult, { success: false }>
): string {
  return result.recovery
    ? (GITHUB_PROJECTION_FAILURE_DESCRIPTION_BY_RECOVERY[result.recovery] ??
        GITHUB_PROJECTION_FAILURE_DEFAULT_DESCRIPTION)
    : GITHUB_PROJECTION_FAILURE_DEFAULT_DESCRIPTION;
}

/**
 * Surface recoverable GitHub-write/local-projection splits consistently across
 * Branch View comment actions while query invalidation owns the follow-up read.
 */
export function handleBranchViewCommentActionResult(
  result: BranchViewCommentActionResult
): void {
  if (!isGithubProjectionFailureResult(result)) {
    return;
  }

  toast.warning("Comment saved on GitHub, but this view could not update yet", {
    description: getGithubProjectionFailureDescription(result),
  });
}
