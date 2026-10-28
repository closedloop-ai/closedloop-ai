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

/**
 * Review comments grouped by thread, each thread oldest first by creation then
 * id, so a reply follows the comment it answers. A thread is keyed by its root
 * comment (a reply's `in_reply_to_id`), which every comment carries, rather
 * than by the GraphQL thread id, which a comment whose metadata read was
 * capped lacks.
 */
export function groupReviewThreads(
  comments: readonly GitHubPullRequestReviewComment[]
): GitHubPullRequestReviewComment[][] {
  const threads = new Map<string, GitHubPullRequestReviewComment[]>();
  for (const comment of comments) {
    const identity = String(comment.in_reply_to_id ?? comment.id);
    const thread = threads.get(identity);
    if (thread) {
      thread.push(comment);
    } else {
      threads.set(identity, [comment]);
    }
  }
  return [...threads.values()].map((thread) =>
    [...thread].sort(compareReviewComments)
  );
}

/**
 * The comment a thread's position, URL, review and resolution are taken from:
 * the one GitHub anchors the thread to, else the oldest.
 */
export function reviewThreadRoot(
  thread: readonly GitHubPullRequestReviewComment[]
): GitHubPullRequestReviewComment {
  const root =
    thread.find((comment) => comment.in_reply_to_id === null) ?? thread[0];
  if (!root) {
    throw new Error("A review thread has at least one comment");
  }
  return root;
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
    originalLine: comment.original_line,
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

function compareReviewComments(
  left: GitHubPullRequestReviewComment,
  right: GitHubPullRequestReviewComment
): number {
  const byCreated =
    Date.parse(left.created_at) - Date.parse(right.created_at) || 0;
  return byCreated === 0 ? left.id - right.id : byCreated;
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
