import type { GitHubReadModelPullRequest } from "@repo/api/src/types/github-read-model";
import {
  GitHubCommentThreadKind,
  type TransactionClient,
} from "@repo/database";
import type {
  GitHubPullRequestIssueComment,
  GitHubPullRequestReview,
  GitHubPullRequestReviewComment,
  StatusCheckRollupCheck,
  StatusCheckRollupResult,
} from "@repo/github";
import {
  desiredReviewThreadProjection,
  keepLatestReviewPerAuthor,
  type PersistableGitHubReview,
  reviewThreadIdentity,
} from "./backfill-desired-projection";
import type {
  GitHubBackfillProjectionDiff,
  GitHubBackfillProjectionScope,
  GitHubBackfillPullRequestMetadata,
} from "./backfill-projection-contract";

/**
 * Counts how many rows a GitHub backfill WOULD change — the read-only half an
 * operator reads before authorizing the write.
 *
 * Split out of `backfill-projection-writer.ts`, which now owns only the write
 * path and calls in here for its counts. Nothing in this module writes: every
 * function either reads persisted rows to compare them against the incoming
 * payload, or tallies the incoming payload itself.
 */

export function emptyProjectionDiff(): GitHubBackfillProjectionDiff {
  return {
    branchProjectionChangeCount: 0,
    pullRequestProjectionChangeCount: 0,
    reviewDecisionProjectionChangeCount: 0,
    checkProjectionChangeCount: 0,
    issueCommentProjectionChangeCount: 0,
    reviewCommentProjectionChangeCount: 0,
    reviewThreadProjectionChangeCount: 0,
    reviewProjectionChangeCount: 0,
    statusCheckProjectionChangeCount: 0,
    skippedBranchCount: 0,
  };
}

export function incrementWriteDiff(
  diff: GitHubBackfillProjectionDiff,
  branch: { checksStatus: string },
  existing: Parameters<typeof pullRequestProjectionWouldChange>[0] | null,
  pullRequest: GitHubReadModelPullRequest
): void {
  if (!existing || pullRequestProjectionWouldChange(existing, pullRequest)) {
    diff.pullRequestProjectionChangeCount += 1;
  }
  if (
    pullRequest.reviewDecision !== null &&
    existing?.reviewDecision !== pullRequest.reviewDecision
  ) {
    diff.reviewDecisionProjectionChangeCount += 1;
  }
  if (
    pullRequest.checksStatus !== null &&
    branch.checksStatus !== pullRequest.checksStatus
  ) {
    diff.checkProjectionChangeCount += 1;
  }
}

export async function addMetadataDiff(
  tx: TransactionClient,
  diff: GitHubBackfillProjectionDiff,
  scope: GitHubBackfillProjectionScope,
  metadata: GitHubBackfillPullRequestMetadata | undefined
): Promise<void> {
  if (!metadata) {
    return;
  }
  const [
    issueCommentProjectionChangeCount,
    reviewCommentProjectionChangeCount,
    reviewThreadProjectionChangeCount,
    reviewProjectionChangeCount,
    statusCheckProjectionChangeCount,
  ] = await Promise.all([
    countCommentProjectionChanges(
      tx,
      scope,
      GitHubCommentThreadKind.ISSUE_COMMENT,
      metadata.issueComments,
      metadata.issueCommentsComplete
    ),
    countCommentProjectionChanges(
      tx,
      scope,
      GitHubCommentThreadKind.REVIEW_THREAD,
      metadata.reviewComments,
      metadata.reviewCommentsComplete
    ),
    countReviewThreadProjectionChanges(tx, scope, metadata.reviewComments),
    countReviewProjectionChanges(tx, scope, metadata.reviews),
    countStatusCheckProjectionChanges(tx, scope, metadata.statusCheckRollup),
  ]);
  diff.issueCommentProjectionChangeCount += issueCommentProjectionChangeCount;
  diff.reviewCommentProjectionChangeCount += reviewCommentProjectionChangeCount;
  diff.reviewThreadProjectionChangeCount += reviewThreadProjectionChangeCount;
  diff.reviewProjectionChangeCount += reviewProjectionChangeCount;
  diff.statusCheckProjectionChangeCount += statusCheckProjectionChangeCount;
}

export function incrementIncomingMetadataBlastRadius(
  diff: GitHubBackfillProjectionDiff,
  metadata: GitHubBackfillPullRequestMetadata
): void {
  diff.issueCommentProjectionChangeCount += metadata.issueComments.length;
  diff.reviewCommentProjectionChangeCount += metadata.reviewComments.length;
  diff.reviewThreadProjectionChangeCount += countReviewThreads(
    metadata.reviewComments
  );
  diff.reviewProjectionChangeCount += countPersistableReviews(metadata.reviews);
  diff.statusCheckProjectionChangeCount += countIncomingStatusCheckRows(
    metadata.statusCheckRollup
  );
}

async function countCommentProjectionChanges(
  tx: TransactionClient,
  scope: GitHubBackfillProjectionScope,
  threadKind: GitHubCommentThreadKind,
  comments: readonly (
    | GitHubPullRequestIssueComment
    | GitHubPullRequestReviewComment
  )[],
  commentsComplete: boolean
): Promise<number> {
  const remoteIds = comments.map((comment) => String(comment.id));
  if (remoteIds.length === 0 && !commentsComplete) {
    return 0;
  }
  const existingRows =
    remoteIds.length === 0
      ? []
      : await tx.gitHubCommentProjection.findMany({
          where: {
            githubCommentId: { in: remoteIds },
            threadProjection: {
              branchArtifactId: scope.branchArtifactId,
              pullRequestDetailId: scope.pullRequestDetailId,
              threadKind,
            },
          },
          select: {
            githubCommentId: true,
            githubHtmlUrl: true,
            githubUpdatedAt: true,
            githubDeletedAt: true,
          },
        });
  const existingByRemoteId = new Map(
    existingRows.map((row) => [row.githubCommentId, row])
  );
  let changes = 0;
  for (const comment of comments) {
    const existing = existingByRemoteId.get(String(comment.id));
    if (!existing || existing.githubDeletedAt !== null) {
      changes += 1;
      continue;
    }
    if (
      existing.githubHtmlUrl !== comment.html_url ||
      datesDiffer(existing.githubUpdatedAt, comment.updated_at)
    ) {
      changes += 1;
    }
  }
  if (!commentsComplete) {
    return changes;
  }
  return (
    changes +
    (await countStaleCommentProjections(tx, scope, threadKind, remoteIds))
  );
}

async function countStaleCommentProjections(
  tx: TransactionClient,
  scope: GitHubBackfillProjectionScope,
  threadKind: GitHubCommentThreadKind,
  liveGithubCommentIds: readonly string[]
): Promise<number> {
  const staleRows = await tx.gitHubCommentProjection.findMany({
    where: {
      githubCommentId:
        liveGithubCommentIds.length > 0
          ? { notIn: [...liveGithubCommentIds], not: null }
          : { not: null },
      githubDeletedAt: null,
      threadProjection: {
        branchArtifactId: scope.branchArtifactId,
        pullRequestDetailId: scope.pullRequestDetailId,
        threadKind,
      },
      comment: { deletedAt: null },
    },
    select: { commentId: true },
  });
  return staleRows.length;
}

async function countReviewThreadProjectionChanges(
  tx: TransactionClient,
  scope: GitHubBackfillProjectionScope,
  reviewComments: readonly GitHubPullRequestReviewComment[]
): Promise<number> {
  const desiredByIdentity = new Map<
    string,
    ReturnType<typeof desiredReviewThreadProjection>
  >();
  for (const comment of reviewComments) {
    desiredByIdentity.set(
      reviewThreadIdentity(comment),
      desiredReviewThreadProjection(comment)
    );
  }
  if (desiredByIdentity.size === 0) {
    return 0;
  }
  const desiredValues = [...desiredByIdentity.values()];
  const reviewThreadIds = desiredValues
    .map((entry) => entry.reviewThreadId)
    .filter((value): value is string => value !== null);
  const rootCommentIds = desiredValues.map((entry) => entry.rootCommentId);
  const existingRows = await tx.gitHubCommentThreadProjection.findMany({
    where: {
      branchArtifactId: scope.branchArtifactId,
      pullRequestDetailId: scope.pullRequestDetailId,
      threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
      OR: [
        ...(reviewThreadIds.length > 0
          ? [{ reviewThreadId: { in: reviewThreadIds } }]
          : []),
        { rootCommentId: { in: rootCommentIds } },
      ],
    },
    select: {
      reviewThreadId: true,
      rootCommentId: true,
      reviewId: true,
      path: true,
      line: true,
      side: true,
      startLine: true,
      startSide: true,
      commitSha: true,
      htmlUrl: true,
      legacyState: true,
      deletedAt: true,
    },
  });
  const existingByIdentity = new Map<string, (typeof existingRows)[number]>();
  for (const row of existingRows) {
    existingByIdentity.set(row.reviewThreadId ?? row.rootCommentId ?? "", row);
  }
  let changes = 0;
  for (const [identity, desired] of desiredByIdentity) {
    const existing = existingByIdentity.get(identity);
    if (!existing || existing.deletedAt !== null) {
      changes += 1;
      continue;
    }
    if (reviewThreadProjectionWouldChange(existing, desired)) {
      changes += 1;
    }
  }
  return changes;
}

async function countReviewProjectionChanges(
  tx: TransactionClient,
  scope: GitHubBackfillProjectionScope,
  reviews: readonly GitHubPullRequestReview[]
): Promise<number> {
  const latestByAuthor = keepLatestReviewPerAuthor(reviews);
  if (latestByAuthor.size === 0) {
    return 0;
  }
  const existingRows = await tx.gitHubPRReview.findMany({
    where: {
      pullRequestId: scope.pullRequestDetailId,
      authorLogin: { in: [...latestByAuthor.keys()] },
    },
    select: {
      authorLogin: true,
      githubReviewId: true,
      authorAvatarUrl: true,
      state: true,
      body: true,
      htmlUrl: true,
      submittedAt: true,
    },
  });
  const existingByAuthor = new Map(
    existingRows.map((row) => [row.authorLogin, row])
  );
  let changes = 0;
  for (const review of latestByAuthor.values()) {
    const existing = existingByAuthor.get(review.authorLogin);
    if (!existing || reviewProjectionWouldChange(existing, review)) {
      changes += 1;
    }
  }
  return changes;
}

async function countStatusCheckProjectionChanges(
  tx: TransactionClient,
  scope: GitHubBackfillProjectionScope,
  rollup: StatusCheckRollupResult | null
): Promise<number> {
  if (!(scope.headSha && rollup)) {
    return 0;
  }
  if (!rollup.ok) {
    return 1;
  }
  const liveProviderKeys = new Set(rollup.checks.map((check) => check.id));
  const existingRows = await tx.branchStatusCheck.findMany({
    where: {
      branchArtifactId: scope.branchArtifactId,
      headSha: scope.headSha,
    },
    select: {
      providerKey: true,
      kind: true,
      providerNodeId: true,
      name: true,
      status: true,
      conclusion: true,
      targetUrl: true,
      position: true,
    },
  });
  const existingByProviderKey = new Map(
    existingRows.map((row) => [row.providerKey, row])
  );
  let changes = 0;
  for (const check of rollup.checks) {
    const existing = existingByProviderKey.get(check.id);
    if (!existing || statusCheckWouldChange(existing, check)) {
      changes += 1;
    }
  }
  for (const existing of existingRows) {
    if (!liveProviderKeys.has(existing.providerKey)) {
      changes += 1;
    }
  }
  return changes;
}

function countReviewThreads(
  reviewComments: readonly GitHubPullRequestReviewComment[]
): number {
  return new Set(reviewComments.map(reviewThreadIdentity)).size;
}

function countPersistableReviews(
  reviews: readonly GitHubPullRequestReview[]
): number {
  return keepLatestReviewPerAuthor(reviews).size;
}

function countIncomingStatusCheckRows(
  rollup: StatusCheckRollupResult | null
): number {
  if (!rollup) {
    return 0;
  }
  return rollup.ok ? rollup.checks.length : 1;
}

function reviewThreadProjectionWouldChange(
  existing: {
    reviewThreadId: string | null;
    rootCommentId: string | null;
    reviewId: string | null;
    path: string | null;
    line: number | null;
    side: string | null;
    startLine: number | null;
    startSide: string | null;
    commitSha: string | null;
    htmlUrl: string | null;
    legacyState: string | null;
  },
  desired: ReturnType<typeof desiredReviewThreadProjection>
): boolean {
  return (
    existing.reviewThreadId !== desired.reviewThreadId ||
    existing.rootCommentId !== desired.rootCommentId ||
    existing.reviewId !== desired.reviewId ||
    existing.path !== desired.path ||
    existing.line !== desired.line ||
    existing.side !== desired.side ||
    existing.startLine !== desired.startLine ||
    existing.startSide !== desired.startSide ||
    existing.commitSha !== desired.commitSha ||
    existing.htmlUrl !== desired.htmlUrl ||
    (desired.legacyState !== undefined &&
      existing.legacyState !== desired.legacyState)
  );
}

function reviewProjectionWouldChange(
  existing: {
    githubReviewId: string;
    authorAvatarUrl: string | null;
    state: string;
    body: string | null;
    htmlUrl: string;
    submittedAt: Date;
  },
  desired: PersistableGitHubReview
): boolean {
  return (
    existing.githubReviewId !== desired.githubReviewId ||
    existing.authorAvatarUrl !== desired.authorAvatarUrl ||
    existing.state !== desired.state ||
    existing.body !== desired.body ||
    existing.htmlUrl !== desired.htmlUrl ||
    existing.submittedAt.toISOString() !== desired.submittedAt.toISOString()
  );
}

function statusCheckWouldChange(
  existing: {
    kind: string;
    providerNodeId: string | null;
    name: string;
    status: string | null;
    conclusion: string | null;
    targetUrl: string | null;
    position: number;
  },
  desired: StatusCheckRollupCheck
): boolean {
  return (
    existing.kind !== desired.kind ||
    existing.providerNodeId !== desired.providerNodeId ||
    existing.name !== desired.name ||
    existing.status !== desired.status ||
    existing.conclusion !== desired.conclusion ||
    existing.targetUrl !== desired.targetUrl ||
    existing.position !== desired.position
  );
}

export function pullRequestProjectionWouldChange(
  existing: {
    // FEA-2732: nullable for desktop-produced PRs with no GitHub node id yet.
    githubId: string | null;
    title: string | null;
    htmlUrl: string | null;
    prState: string;
    isDraft: boolean;
    reviewDecision: string | null;
    additions: number | null;
    deletions: number | null;
    changedFiles: number | null;
    // FEA-3552: persisted GitHub PR createdAt — drift here re-projects a row that
    // predates the column so it back-fills the rail's opened-dot anchor.
    githubCreatedAt: Date | null;
    closedAt: Date | null;
    mergedAt: Date | null;
    mergeCommitSha: string | null;
  },
  incoming: GitHubReadModelPullRequest
): boolean {
  return (
    existing.githubId !== incoming.githubId ||
    existing.title !== incoming.title ||
    existing.htmlUrl !== incoming.htmlUrl ||
    existing.prState !== incoming.state ||
    existing.isDraft !== incoming.isDraft ||
    existing.reviewDecision !== incoming.reviewDecision ||
    existing.additions !== incoming.additions ||
    existing.deletions !== incoming.deletions ||
    existing.changedFiles !== incoming.changedFiles ||
    datesDiffer(existing.githubCreatedAt, incoming.openedAt) ||
    datesDiffer(existing.closedAt, incoming.closedAt) ||
    datesDiffer(existing.mergedAt, incoming.mergedAt) ||
    existing.mergeCommitSha !== incoming.mergeCommitSha
  );
}

function datesDiffer(left: Date | null, right: string | null): boolean {
  return (left?.toISOString() ?? null) !== normalizeDateString(right);
}

function normalizeDateString(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}
