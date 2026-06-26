import {
  type BranchViewComment,
  CommentKind,
} from "@repo/api/src/types/branch-view";

/**
 * Branch View review threads are the only conversations that can be
 * resolved or unresolved through the GitHub review-thread mutations.
 * Issue and conversation comments don't expose a thread-state toggle.
 */
export function isResolvableReviewComment(comment: BranchViewComment): boolean {
  return (
    comment.kind === CommentKind.ReviewComment && comment.resolvable === true
  );
}

/**
 * Whether a Branch View comment counts as resolved for filter UI + the
 * PR feed source. Mirrors the source's `applyFilter` logic so the
 * filter-control badge counts and the rendered list cannot drift.
 */
export function isResolvedComment(comment: BranchViewComment): boolean {
  return comment.resolved === true;
}

/**
 * Branch View review-mutation routes accept the local comment id over
 * the raw GitHub id when both are present. Shared across the diff view,
 * the PR comment card, the thread footer, and the legacy inline section
 * so the action target never drifts.
 */
export function getReviewThreadActionId(comment: BranchViewComment): string {
  return comment.commentId ?? comment.id;
}
