/**
 * The shapes the GitHub-backfill projection lane passes between its modules —
 * what a pass would change (`GitHubBackfillProjectionDiff`), which rows one
 * pull request's metadata covers (`GitHubBackfillProjectionScope`), and the
 * provider payload both halves read (`GitHubBackfillPullRequestMetadata`).
 *
 * A leaf on purpose. `backfill-projection-writer.ts` owns the write path and
 * `backfill-projection-diff-counter.ts` owns the dry-run counting, and both
 * need these types; declaring them in the writer would make the counter it
 * was extracted from import back into its own composition root.
 */

import type {
  GitHubPullRequestIssueComment,
  GitHubPullRequestReview,
  GitHubPullRequestReviewComment,
  StatusCheckRollupResult,
} from "@repo/github";

export type GitHubBackfillProjectionDiff = {
  branchProjectionChangeCount: number;
  pullRequestProjectionChangeCount: number;
  lifecycleAtomProjectionChangeCount: number;
  branchLastActivityProjectionChangeCount: number;
  reviewDecisionProjectionChangeCount: number;
  checkProjectionChangeCount: number;
  issueCommentProjectionChangeCount: number;
  reviewCommentProjectionChangeCount: number;
  reviewThreadProjectionChangeCount: number;
  reviewProjectionChangeCount: number;
  statusCheckProjectionChangeCount: number;
  skippedBranchCount: number;
};

export type GitHubBackfillPullRequestMetadata = {
  number: number;
  issueComments: readonly GitHubPullRequestIssueComment[];
  issueCommentsComplete: boolean;
  reviewComments: readonly GitHubPullRequestReviewComment[];
  reviewCommentsComplete: boolean;
  reviews: readonly GitHubPullRequestReview[];
  statusCheckRollup: StatusCheckRollupResult | null;
};

export type GitHubBackfillProjectionScope = {
  organizationId: string;
  /**
   * Null on the repo-less (observation) lane, where rows are identified by
   * `repositoryFullName` instead — see `trackedRepositorySelector`. Carried
   * only as author-resolution context here; nothing in this scope is a
   * repository predicate.
   */
  repositoryId: string | null;
  branchArtifactId: string;
  pullRequestDetailId: string;
  pullNumber: number;
  headSha: string | null;
};
