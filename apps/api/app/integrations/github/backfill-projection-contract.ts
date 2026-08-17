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
  repositoryId: string;
  branchArtifactId: string;
  pullRequestDetailId: string;
  pullNumber: number;
  headSha: string | null;
};
