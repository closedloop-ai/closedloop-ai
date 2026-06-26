"use client";

import type { BranchViewComment } from "@repo/api/src/types/branch-view";
import { CommentThreadActionFooter } from "@repo/design-system/components/ui/comment-thread-action-footer";
import { CheckCheck } from "lucide-react";
import {
  type BranchViewContextValue,
  useBranchViewContext,
} from "../branch-view-context";
import { getReviewThreadActionId } from "../comment-resolution";
import { handleBranchViewCommentActionResult } from "../components/branch-comment-action-result";
import {
  canResolveBranchViewReviewThread,
  canUnresolveBranchViewReviewThread,
} from "../components/branch-review-thread-capabilities";

type ResolveThreadFooterAction = {
  label: "Resolve Conversation" | "Unresolve Conversation";
  isPending: boolean;
  onClick: () => void;
};

/**
 * Single-button thread footer that drives the dedicated review-thread
 * resolve/unresolve mutations. Rendered only for resolvable review
 * comments — non-resolvable threads omit the entire footer.
 */
export function PrCommentThreadFooter({
  root,
}: Readonly<{ root: BranchViewComment }>) {
  const { mutations } = useBranchViewContext();
  const action = resolveThreadFooterAction(root, mutations);

  if (action === null) {
    return null;
  }

  return (
    <CommentThreadActionFooter
      icon={<CheckCheck className="mr-1.5 h-3.5 w-3.5" />}
      isPending={action.isPending}
      label={action.label}
      onClick={action.onClick}
    />
  );
}

function resolveThreadFooterAction(
  root: BranchViewComment,
  mutations: BranchViewContextValue["mutations"]
): ResolveThreadFooterAction | null {
  if (canResolveBranchViewReviewThread(root)) {
    return {
      label: "Resolve Conversation",
      isPending:
        mutations.resolveThread.isPending &&
        mutations.resolveThread.variables === getReviewThreadActionId(root),
      onClick: () =>
        mutations.resolveThread.mutate(getReviewThreadActionId(root), {
          onSuccess: handleBranchViewCommentActionResult,
        }),
    };
  }
  if (canUnresolveBranchViewReviewThread(root)) {
    return {
      label: "Unresolve Conversation",
      isPending:
        mutations.unresolveThread.isPending &&
        mutations.unresolveThread.variables === getReviewThreadActionId(root),
      onClick: () =>
        mutations.unresolveThread.mutate(getReviewThreadActionId(root), {
          onSuccess: handleBranchViewCommentActionResult,
        }),
    };
  }
  return null;
}
