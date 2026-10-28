import type { CommentSyncProvider } from "@repo/api/src/types/comment-thread-dto";
import type {
  GitHubCommentThreadKind,
  GitHubLegacyCommentState,
  ThreadStatus,
} from "@repo/database";
import type { ExternalGitHubUser } from "@/app/comments/external-authors";
import type { GitHubFetchProvenance } from "@/lib/github-fetch-provenance";
import type { GitHubReviewThreadResolutionAttribution } from "../thread-resolution";
import type { GitHubReviewThreadPosition } from "./github-projection-contract";

export const GitHubExternalEventKind = {
  /** A review thread and the comments the event carries for it. */
  ReviewThreadUpsert: "review_thread_upsert",
  /** One PR conversation (issue) comment, a thread of its own. */
  IssueCommentUpsert: "issue_comment_upsert",
  /** One review's summary body, a thread of its own (decision 6). */
  ReviewSummaryUpsert: "review_summary_upsert",
  CommentDelete: "comment_delete",
  /** Every stored comment of a kind absent from a complete provider list. */
  ListCleanup: "list_cleanup",
  /** A provider-confirmed review-thread resolution or reopening. */
  ThreadStatus: "thread_status",
} as const;
export type GitHubExternalEventKind =
  (typeof GitHubExternalEventKind)[keyof typeof GitHubExternalEventKind];

export type GitHubExternalComment = {
  githubCommentId: string | number;
  githubInReplyToCommentId?: string | number | null;
  htmlUrl: string | null;
  bodyMarkdown: string;
  author: ExternalGitHubUser | null;
  createdAt: Date;
  /**
   * PLN-2122 decision 1: the ordering key, GitHub's `updated_at` for a comment
   * and `submitted_at` for a review summary.
   */
  providerUpdatedAt: Date;
};

type UpsertFields = {
  /**
   * Set for a complete reconcile list: when the list was read. A comment it
   * holds that was deleted before then is revived (decision 2); one deleted
   * after it was read stays deleted. Also set by a review summary's non-blank
   * `edited` delivery: GitHub keeps the review, so a body restored after a
   * blank edit brings the summary back.
   */
  reviveDeletedBefore?: Date;
  /**
   * Set only by the reconcile, complete list or not: when its lists were read.
   * A comment or thread written locally since then was written by something
   * newer than the list, so the list cannot overwrite what the provider key
   * does not order: an equal-key body, or the thread's resolution.
   */
  listedAt?: Date;
  htmlUrl?: string | null;
  legacyState?: GitHubLegacyCommentState | null;
  resolutionStatus?: ThreadStatus | null;
};

export type GitHubReviewThreadUpsertEvent = UpsertFields & {
  kind: typeof GitHubExternalEventKind.ReviewThreadUpsert;
  /**
   * `null` when the source does not know it (a review-comment webhook): it then
   * never clears a stored id, and neither does an omitted `legacyState`.
   */
  reviewThreadId: string | null;
  reviewId: string | null;
  rootCommentId: string | number;
  position: GitHubReviewThreadPosition;
  comments: GitHubExternalComment[];
  /**
   * The event carries a reply, not its thread's root (a webhook delivery), so
   * `reviewId`, `htmlUrl` and `position` are the reply's: they seed a thread
   * that is not stored yet and never rewrite a stored one, which keeps the
   * root's, as the reconcile writes them. Also set on a list event whose
   * thread was written after the list was read.
   */
  threadFieldsFromReply?: boolean;
};

export type GitHubIssueCommentUpsertEvent = UpsertFields & {
  kind: typeof GitHubExternalEventKind.IssueCommentUpsert;
  comment: GitHubExternalComment;
};

export type GitHubReviewSummaryUpsertEvent = UpsertFields & {
  kind: typeof GitHubExternalEventKind.ReviewSummaryUpsert;
  reviewId: string | number;
  comment: GitHubExternalComment;
  /**
   * A `submitted` delivery: the body as first submitted, older than any edit,
   * which keeps the same `submitted_at` key.
   */
  asSubmitted?: true;
};

export type GitHubCommentDeleteEvent = {
  kind: typeof GitHubExternalEventKind.CommentDelete;
  threadKind: GitHubCommentThreadKind;
  githubCommentId: string | number;
  /** The payload's `comment.updated_at`, recorded as the delete's key. */
  providerUpdatedAt: Date | null;
};

export type GitHubListCleanupEvent = {
  kind: typeof GitHubExternalEventKind.ListCleanup;
  threadKind: GitHubCommentThreadKind;
  liveGithubCommentIds: ReadonlySet<string>;
  /** When the list was read: a comment created or edited after it is kept. */
  listedAt: Date;
  /**
   * The most stale comments one application deletes. It reports `Applied`
   * while it deletes anything, so the caller repeats it until `Unchanged`.
   */
  maxComments: number;
};

export type GitHubThreadStatusEvent = {
  kind: typeof GitHubExternalEventKind.ThreadStatus;
  threadExternalId: string;
  resolved: boolean;
  resolvedAt: Date;
  resolvedById?: string | null;
  attribution?: GitHubReviewThreadResolutionAttribution;
};

export type GitHubUpsertEvent =
  | GitHubReviewThreadUpsertEvent
  | GitHubIssueCommentUpsertEvent
  | GitHubReviewSummaryUpsertEvent;

export type GitHubExternalEvent =
  | GitHubUpsertEvent
  | GitHubCommentDeleteEvent
  | GitHubListCleanupEvent
  | GitHubThreadStatusEvent;

export type ApplyExternalInput = {
  /** Only GitHub writes through here at this phase; Liveblocks is P3. */
  provider: typeof CommentSyncProvider.Github;
  organizationId: string;
  branchArtifactId: string;
  pullRequestDetailId: string;
  fetchProvenance?: GitHubFetchProvenance;
  events: readonly GitHubExternalEvent[];
};

export const ApplyExternalOutcome = {
  Applied: "applied",
  /** Nothing differed from what is stored; no write and no signal. */
  Unchanged: "unchanged",
  RejectedOlder: "rejected_older",
  RejectedDeleted: "rejected_deleted",
  RejectedFuture: "rejected_future",
  NotFound: "not_found",
  /** The projection refused the write (scope collision, ambiguity). */
  NoWrite: "no_write",
} as const;
export type ApplyExternalOutcome =
  (typeof ApplyExternalOutcome)[keyof typeof ApplyExternalOutcome];

export type ApplyExternalResult = {
  /** One outcome per input event, in order. */
  outcomes: ApplyExternalOutcome[];
  /** Every thread the call changed, each signalled once. */
  changedThreadIds: string[];
  /** Comments the call's list cleanups deleted; omitted when none. */
  retractedComments?: number;
};
