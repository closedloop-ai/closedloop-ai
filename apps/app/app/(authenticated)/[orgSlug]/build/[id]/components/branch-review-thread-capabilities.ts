import {
  type BranchViewComment,
  CommentKind,
} from "@repo/api/src/types/branch-view";

/**
 * Returns whether Branch View may render a resolve action for a provider-backed
 * review thread using only API-projected capability fields.
 */
export function canResolveBranchViewReviewThread(
  comment: BranchViewComment
): boolean {
  return (
    comment.kind === CommentKind.ReviewComment &&
    comment.resolvable === true &&
    comment.resolved !== true &&
    comment.canResolve === true
  );
}

/**
 * Returns whether Branch View may render an unresolve action for a provider-backed
 * review thread using only API-projected capability fields.
 */
export function canUnresolveBranchViewReviewThread(
  comment: BranchViewComment
): boolean {
  return (
    comment.kind === CommentKind.ReviewComment &&
    comment.resolvable === true &&
    comment.resolved === true &&
    comment.canUnresolve === true
  );
}
