/**
 * The shapes the GitHub projection writer works in: the narrowed client it
 * accepts, its write and soft-delete inputs, and the result it hands back.
 */

import type {
  GitHubCommentThreadKind,
  GitHubDiffSide,
  GitHubLegacyCommentState,
  ThreadStatus,
  TransactionClient,
} from "@repo/database";
import type { GitHubFetchProvenance } from "@/lib/github-fetch-provenance";

export type GitHubProjectionDb = Pick<
  TransactionClient,
  | "comment"
  | "commentThread"
  | "gitHubCommentProjection"
  | "gitHubCommentThreadProjection"
>;

export type GitHubProjectionAuthorInput = {
  userId: string;
  /**
   * FEA-1195 provider-author identity for the exact GitHub actor that authored
   * this comment. Generic Comment rows keep the resolved platform user id;
   * GitHub projection rows persist this id so branch-view display never has to
   * guess among multiple provider identities mapped to the same user.
   */
  externalAuthorId?: string | null;
};

export type GitHubProjectionCommentInput = {
  githubCommentId: string | number;
  githubInReplyToCommentId?: string | number | null;
  githubHtmlUrl?: string | null;
  githubUpdatedAt?: Date | null;
  bodyMarkdown: string;
  author: GitHubProjectionAuthorInput;
  createdAt: Date;
};

export type BaseGitHubThreadProjectionInput = {
  organizationId: string;
  branchArtifactId: string;
  pullRequestDetailId: string;
  htmlUrl?: string | null;
  legacyState?: GitHubLegacyCommentState | null;
  /**
   * Explicit authoritative resolution state from a source that owns review
   * thread resolution. `legacyState` is only a provider label/compat field.
   */
  resolutionStatus?: ThreadStatus | null;
  /**
   * When `resolutionStatus` was read from the provider, for a list read that
   * carries no ordering key: it is written only to a thread no write has
   * touched since.
   */
  resolutionReadAt?: Date;
  resolvable?: boolean;
  lastSyncedAt?: Date | null;
  fetchProvenance?: GitHubFetchProvenance;
  /**
   * PLN-2122 decision 2: set only for a complete reconcile list that still
   * holds the comment, the one write allowed to clear a soft-deleted thread's
   * or comment's deletion. Every other write refuses a deleted row.
   */
  revive?: boolean;
};

export type GitHubReviewThreadPosition = {
  path?: string | null;
  line?: number | null;
  originalLine?: number | null;
  side?: GitHubDiffSide | null;
  startLine?: number | null;
  startSide?: GitHubDiffSide | null;
  commitSha?: string | null;
};

export type UpsertGitHubIssueCommentThreadInput =
  BaseGitHubThreadProjectionInput & {
    comment: GitHubProjectionCommentInput;
  };

export type UpsertGitHubReviewCommentThreadInput =
  BaseGitHubThreadProjectionInput &
    GitHubReviewThreadPosition & {
      reviewThreadId?: string | null;
      reviewId?: string | null;
      rootCommentId: string | number;
      comments: GitHubProjectionCommentInput[];
      /** `reviewId`, `htmlUrl` and the position seed a new projection only. */
      threadFieldsFromReply?: boolean;
    };

/** PLN-2122 decision 6: one review's summary body, keyed by the review id. */
export type UpsertGitHubReviewSummaryThreadInput =
  BaseGitHubThreadProjectionInput & {
    reviewId: string | number;
    comment: GitHubProjectionCommentInput;
  };

export type UpsertGitHubThreadInput = Omit<
  UpsertGitHubReviewCommentThreadInput,
  "rootCommentId"
> & { threadKind: GitHubCommentThreadKind; rootCommentId: string };

export type SoftDeleteGitHubCommentProjectionInput = {
  organizationId: string;
  branchArtifactId: string;
  pullRequestDetailId: string;
  threadKind: GitHubCommentThreadKind;
  liveGithubCommentIds: ReadonlySet<string | number>;
  /** When the list was read; a comment GitHub created or edited after it is kept. */
  listedAt: Date;
  /** The most stale comments one call deletes. */
  maxComments: number;
  deletedAt: Date;
  fetchProvenance?: GitHubFetchProvenance;
};

export type SoftDeleteScopedGitHubCommentProjectionInput = {
  organizationId: string;
  branchArtifactId: string;
  pullRequestDetailId: string;
  githubCommentId: string | number;
  deletedAt: Date;
  fetchProvenance?: GitHubFetchProvenance;
};

export type SoftDeleteGitHubCommentByRemoteIdInput =
  SoftDeleteScopedGitHubCommentProjectionInput & {
    threadKind: GitHubCommentThreadKind;
  };

/** The rows a soft-delete touched, for the caller that signals and syncs them. */
export type SoftDeletedGitHubCommentRows = {
  commentIds: string[];
  threadIds: string[];
  deletedThreadCount: number;
};

export type UpsertGitHubProjectionResult = {
  threadId: string;
  commentIds: string[];
  /** The thread this call created, with the revision its row was written at. */
  createdThread?: { id: string; revision: number };
};
