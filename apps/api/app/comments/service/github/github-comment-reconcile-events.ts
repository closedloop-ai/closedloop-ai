import { GitHubCommentThreadKind } from "@repo/database";
import type {
  GitHubPullRequestIssueComment,
  GitHubPullRequestReviewComment,
} from "@repo/github";
import type { GitHubPullRequestReviewWithAuthor } from "@repo/github/pull-request-comment-lists";
import {
  gitHubLegacyStateFromReviewThreadResolved,
  gitHubThreadStatusFromReviewThreadResolved,
  groupReviewThreads,
  reviewThreadRoot,
} from "@/app/integrations/github/backfill-desired-projection";
import {
  GitHubExternalEventKind,
  type GitHubIssueCommentUpsertEvent,
  type GitHubListCleanupEvent,
  type GitHubReviewSummaryUpsertEvent,
  type GitHubReviewThreadUpsertEvent,
  type GitHubUpsertEvent,
} from "./apply-external-events";
import {
  gitHubExternalComment,
  gitHubExternalReviewComment,
  gitHubReviewThreadPosition,
} from "./github-external-comment";

/**
 * Plan Step 5 item 4 bounds each `applyExternal` call to stay inside the 5s
 * interactive-transaction limit. The work is per comment, so the bound is too:
 * 50 single-comment threads applied in 0.8s (insert) and 0.9s (edit) against a
 * local Postgres, while 50 threads of 10 comments took 4.1s, too close to the
 * limit to ship as a per-thread bound (ISS-11212 resolve). A cleanup deletes
 * at most this many comments per call, two updates each, under the same bound.
 */
export const RECONCILE_COMMENTS_PER_APPLY = 50;

/** One provider list as the reconcile applies it: every row, and whether it is all of them. */
export type ReconcileList<T> = {
  items: readonly T[];
  complete: boolean;
  /** Set when the list is incomplete because its pages shifted mid-read. */
  shifted?: true;
  /** Set when the provider failed the list: empty and incomplete. */
  failed?: true;
};

export type ReconcileLists = {
  issueComments: ReconcileList<GitHubPullRequestIssueComment>;
  reviewComments: ReconcileList<GitHubPullRequestReviewComment>;
  reviews: ReconcileList<GitHubPullRequestReviewWithAuthor>;
  /** When the lists were read, taken before the first provider request. */
  listedAt: Date;
};

/**
 * Every thread the lists describe, one upsert event per thread, each carrying
 * when the lists were read. A complete list revives a comment it still holds
 * that was deleted before the list was read (decision 2); an incomplete one
 * never does.
 */
export function reconcileUpsertEvents(
  lists: ReconcileLists
): GitHubUpsertEvent[] {
  const revive = (list: ReconcileList<unknown>) =>
    list.complete ? lists.listedAt : undefined;
  const events: GitHubUpsertEvent[] = [
    ...lists.issueComments.items.map((comment) =>
      issueCommentEvent(comment, revive(lists.issueComments))
    ),
    ...reviewThreadEvents(
      lists.reviewComments.items,
      revive(lists.reviewComments)
    ),
    ...lists.reviews.items.flatMap((review) =>
      reviewSummaryEvents(review, revive(lists.reviews))
    ),
  ];
  return events.map((event) => ({ ...event, listedAt: lists.listedAt }));
}

/**
 * Plan Step 5 item 5: a cleanup for each complete list, deleting every stored
 * comment of its kind the list no longer holds, at most
 * `RECONCILE_COMMENTS_PER_APPLY` per call. An incomplete list gets none.
 */
export function reconcileCleanupEvents(
  lists: ReconcileLists
): GitHubListCleanupEvent[] {
  const cleanups: GitHubListCleanupEvent[] = [];
  if (lists.issueComments.complete) {
    cleanups.push(
      cleanupEvent(
        GitHubCommentThreadKind.ISSUE_COMMENT,
        lists.issueComments.items.map((comment) => comment.id),
        lists.listedAt
      )
    );
  }
  if (lists.reviewComments.complete) {
    cleanups.push(
      cleanupEvent(
        GitHubCommentThreadKind.REVIEW_THREAD,
        lists.reviewComments.items.map((comment) => comment.id),
        lists.listedAt
      )
    );
  }
  if (lists.reviews.complete) {
    cleanups.push(
      cleanupEvent(
        GitHubCommentThreadKind.REVIEW_SUMMARY,
        lists.reviews.items
          .filter((review) => isStoredReviewSummary(review))
          .map((review) => review.id),
        lists.listedAt
      )
    );
  }
  return cleanups;
}

/**
 * Upsert events packed into `applyExternal` calls of at most `budget`
 * comments. A thread with more comments than that is split into consecutive
 * events of the same thread: a thread upsert writes only the comments it
 * carries, so its parts land the same rows as the whole would.
 */
export function chunkReconcileEvents(
  events: readonly GitHubUpsertEvent[],
  budget: number = RECONCILE_COMMENTS_PER_APPLY
): GitHubUpsertEvent[][] {
  const chunks: GitHubUpsertEvent[][] = [];
  let chunk: GitHubUpsertEvent[] = [];
  let comments = 0;
  for (const event of events.flatMap((e) => splitThread(e, budget))) {
    const size = eventCommentCount(event);
    if (chunk.length > 0 && comments + size > budget) {
      chunks.push(chunk);
      chunk = [];
      comments = 0;
    }
    chunk.push(event);
    comments += size;
  }
  if (chunk.length > 0) {
    chunks.push(chunk);
  }
  return chunks;
}

function splitThread(
  event: GitHubUpsertEvent,
  budget: number
): GitHubUpsertEvent[] {
  if (
    event.kind !== GitHubExternalEventKind.ReviewThreadUpsert ||
    event.comments.length <= budget
  ) {
    return [event];
  }
  const parts: GitHubUpsertEvent[] = [];
  for (let start = 0; start < event.comments.length; start += budget) {
    parts.push({
      ...event,
      comments: event.comments.slice(start, start + budget),
    });
  }
  return parts;
}

function eventCommentCount(event: GitHubUpsertEvent): number {
  return event.kind === GitHubExternalEventKind.ReviewThreadUpsert
    ? event.comments.length
    : 1;
}

function issueCommentEvent(
  comment: GitHubPullRequestIssueComment,
  reviveDeletedBefore: Date | undefined
): GitHubIssueCommentUpsertEvent {
  return {
    kind: GitHubExternalEventKind.IssueCommentUpsert,
    ...(reviveDeletedBefore ? { reviveDeletedBefore } : {}),
    htmlUrl: comment.html_url,
    comment: gitHubExternalComment(comment),
  };
}

/**
 * One event per review thread, its comments oldest first. The thread's
 * position is its root comment's ({@link reviewThreadRoot}), as the backfill's
 * projection diff counts them; its GraphQL id and resolution come from the
 * root, else from any comment of the thread whose metadata was read.
 */
function reviewThreadEvents(
  comments: readonly GitHubPullRequestReviewComment[],
  reviveDeletedBefore: Date | undefined
): GitHubReviewThreadUpsertEvent[] {
  return groupReviewThreads(comments).map((ordered) => {
    const root = reviewThreadRoot(ordered);
    const metadata = root.review_thread_node_id
      ? root
      : (ordered.find((comment) => comment.review_thread_node_id) ?? root);
    return {
      kind: GitHubExternalEventKind.ReviewThreadUpsert,
      ...(reviveDeletedBefore ? { reviveDeletedBefore } : {}),
      reviewThreadId: metadata.review_thread_node_id,
      reviewId: root.pull_request_review_id
        ? String(root.pull_request_review_id)
        : null,
      rootCommentId: root.in_reply_to_id ?? root.id,
      position: gitHubReviewThreadPosition(root),
      htmlUrl: root.html_url,
      legacyState: gitHubLegacyStateFromReviewThreadResolved(
        metadata.review_thread_is_resolved
      ),
      resolutionStatus: gitHubThreadStatusFromReviewThreadResolved(
        metadata.review_thread_is_resolved
      ),
      comments: ordered.map(gitHubExternalReviewComment),
    };
  });
}

/** Decision 6: a review with a blank body stores no summary. */
function reviewSummaryEvents(
  review: GitHubPullRequestReviewWithAuthor,
  reviveDeletedBefore: Date | undefined
): GitHubReviewSummaryUpsertEvent[] {
  if (!(isStoredReviewSummary(review) && review.submitted_at)) {
    return [];
  }
  const submittedAt = new Date(review.submitted_at);
  return [
    {
      kind: GitHubExternalEventKind.ReviewSummaryUpsert,
      ...(reviveDeletedBefore ? { reviveDeletedBefore } : {}),
      reviewId: review.id,
      htmlUrl: review.html_url,
      comment: {
        githubCommentId: review.id,
        htmlUrl: review.html_url,
        bodyMarkdown: review.body ?? "",
        author: review.author,
        createdAt: submittedAt,
        providerUpdatedAt: submittedAt,
      },
    },
  ];
}

function isStoredReviewSummary(
  review: GitHubPullRequestReviewWithAuthor
): boolean {
  return Boolean(review.body?.trim() && review.submitted_at);
}

function cleanupEvent(
  threadKind: GitHubCommentThreadKind,
  ids: readonly number[],
  listedAt: Date
): GitHubListCleanupEvent {
  return {
    kind: GitHubExternalEventKind.ListCleanup,
    threadKind,
    liveGithubCommentIds: new Set(ids.map(String)),
    listedAt,
    maxComments: RECONCILE_COMMENTS_PER_APPLY,
  };
}
