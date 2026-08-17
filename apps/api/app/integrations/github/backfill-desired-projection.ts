import { ReviewDecision } from "@repo/api/src/types/branch-checks";
import { GitHubLegacyCommentState, ThreadStatus } from "@repo/database";
import type {
  GitHubPullRequestReview,
  GitHubPullRequestReviewComment,
} from "@repo/github";
import { normalizeGitHubDiffSide } from "@/app/comments/github-diff-side";

/**
 * Derives the projection shape a GitHub backfill payload SHOULD produce —
 * review-thread identity and fields, resolved-flag to projection state, and the
 * latest persistable review per author.
 *
 * Split out of `backfill-projection-writer.ts`: both halves of that module read
 * this, the write path to persist the desired shape and the diff counters to
 * compare it against the persisted rows, so it must not depend on either.
 */

export type PersistableGitHubReview = {
  githubReviewId: string;
  authorLogin: string;
  authorAvatarUrl: string | null;
  state: ReviewDecision;
  body: string | null;
  htmlUrl: string;
  submittedAt: Date;
};

export function reviewThreadIdentity(
  comment: GitHubPullRequestReviewComment
): string {
  return (
    comment.review_thread_node_id ??
    String(comment.in_reply_to_id ?? comment.id)
  );
}

export function desiredReviewThreadProjection(
  comment: GitHubPullRequestReviewComment
) {
  return {
    reviewThreadId: comment.review_thread_node_id,
    rootCommentId: String(comment.in_reply_to_id ?? comment.id),
    reviewId: comment.pull_request_review_id
      ? String(comment.pull_request_review_id)
      : null,
    path: comment.path,
    line: comment.line,
    side: normalizeGitHubDiffSide(comment.side),
    startLine: comment.start_line,
    startSide: normalizeGitHubDiffSide(comment.start_side),
    commitSha: comment.commit_id,
    htmlUrl: comment.html_url,
    legacyState: gitHubLegacyStateFromReviewThreadResolved(
      comment.review_thread_is_resolved
    ),
  };
}

export function keepLatestReviewPerAuthor(
  reviews: readonly GitHubPullRequestReview[]
): Map<string, PersistableGitHubReview> {
  const latestByAuthor = new Map<string, PersistableGitHubReview>();
  for (const review of reviews) {
    const persistable = toPersistableReview(review);
    if (!persistable) {
      continue;
    }
    const existing = latestByAuthor.get(persistable.authorLogin);
    if (!existing || persistable.submittedAt > existing.submittedAt) {
      latestByAuthor.set(persistable.authorLogin, persistable);
    }
  }
  return latestByAuthor;
}

function toPersistableReview(
  review: GitHubPullRequestReview
): PersistableGitHubReview | null {
  const state = normalizeReviewDecision(review.state);
  if (!(state && review.submitted_at && review.user?.login)) {
    return null;
  }
  return {
    githubReviewId: String(review.id),
    authorLogin: review.user.login,
    authorAvatarUrl: review.user.avatar_url ?? null,
    state,
    body: review.body,
    htmlUrl: review.html_url,
    submittedAt: new Date(review.submitted_at),
  };
}

function normalizeReviewDecision(value: string): ReviewDecision | null {
  switch (value) {
    case ReviewDecision.Approved:
      return ReviewDecision.Approved;
    case ReviewDecision.ChangesRequested:
      return ReviewDecision.ChangesRequested;
    case ReviewDecision.Commented:
      return ReviewDecision.Commented;
    case ReviewDecision.Dismissed:
      return ReviewDecision.Dismissed;
    default:
      return null;
  }
}

export function gitHubLegacyStateFromReviewThreadResolved(
  isResolved: boolean | null | undefined
): GitHubLegacyCommentState | undefined {
  if (isResolved == null) {
    return undefined;
  }
  return isResolved
    ? GitHubLegacyCommentState.ADDRESSED
    : GitHubLegacyCommentState.PENDING;
}

export function gitHubThreadStatusFromReviewThreadResolved(
  isResolved: boolean | null | undefined
): ThreadStatus | undefined {
  if (isResolved == null) {
    return undefined;
  }
  return isResolved ? ThreadStatus.RESOLVED : ThreadStatus.OPEN;
}
