import {
  type BranchViewComment,
  CommentKind,
  parseNumericGithubCommentId,
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

/**
 * Branch View issue-comment reply routes accept a numeric GitHub comment id
 * (`z.number().int().positive()`). Not every comment row carries a numeric
 * `githubCommentId` — review comments and synthetic rows use non-numeric ids —
 * so `Number(comment.githubCommentId)` can yield `NaN`. Callers must guard
 * before firing a reply mutation. Returns the parsed positive integer, or
 * null when the id is missing or non-numeric. Delegates to the shared
 * `parseNumericGithubCommentId` guard so the client and the server-side
 * branch-view conversation service stay in lockstep.
 */
export function getReplyTargetGithubCommentId(
  comment: BranchViewComment
): number | null {
  return parseNumericGithubCommentId(comment.githubCommentId);
}
