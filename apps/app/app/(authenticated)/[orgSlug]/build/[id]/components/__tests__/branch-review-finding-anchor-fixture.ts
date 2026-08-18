import {
  type BranchViewComment,
  CommentKind,
  GitHubDiffSide,
  PRReviewCommentState,
  PrCommentAuthorKind,
} from "@repo/api/src/types/branch-view";

/**
 * Test-only fixture shared by branch-review-findings.test.ts and
 * branch-review-findings-diff-context.test.ts, so both files exercise the
 * same realistic BranchViewComment shape instead of diverging fixtures.
 */
export const COMMITTED_FILES = [{ path: "src/app.tsx", previousPath: null }];

export function comment(
  overrides: Partial<BranchViewComment> = {}
): BranchViewComment {
  return {
    author: "closedloop-ai[bot]",
    authorAvatar: null,
    authorKind: PrCommentAuthorKind.Bot,
    body: "**[P2]** Avoid stale state\n\n> **Suggestion:** Use the latest cache.",
    createdAt: "2026-05-21T12:00:00.000Z",
    githubCommentId: "123",
    htmlUrl: "https://github.com/acme/repo/pull/1#discussion_r123",
    id: "123",
    inReplyToId: null,
    kind: CommentKind.ReviewComment,
    line: 2,
    path: "src/app.tsx",
    reviewId: "review-1",
    side: GitHubDiffSide.Right,
    state: PRReviewCommentState.Pending,
    ...overrides,
  };
}
