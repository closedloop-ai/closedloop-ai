import { BranchBaseBranchSource } from "@repo/api/src/types/artifact";
import { ReviewDecision } from "@repo/api/src/types/branch-checks";
import {
  GitHubFetchTrigger,
  type GitHubReadModelPullRequest,
} from "@repo/api/src/types/github-read-model";
import {
  GitHubCommentThreadKind,
  GitHubLegacyCommentState,
  ThreadStatus,
  type TransactionClient,
  withDb,
} from "@repo/database";
import type {
  GitHubPullRequestIssueComment,
  GitHubPullRequestReview,
  GitHubPullRequestReviewComment,
  StatusCheckRollupCheck,
  StatusCheckRollupResult,
} from "@repo/github";
import { writeExistingBranchPullRequestProjection } from "@/app/branches/github-projection-writer";
import type {
  ExternalGitHubAuthorSource,
  ExternalGitHubUser,
  ResolvedExternalGitHubAuthor,
} from "@/app/comments/external-authors";
import {
  normalizeExternalGitHubAuthor,
  resolveExternalGitHubAuthorInTransaction,
} from "@/app/comments/external-authors";
import { normalizeGitHubDiffSide } from "@/app/comments/github-diff-side";
import {
  softDeleteGitHubCommentProjection,
  upsertGitHubIssueCommentThread,
  upsertGitHubReviewCommentThread,
} from "@/app/comments/github-projection";
import { persistBranchStatusChecksFromRollup } from "@/lib/branch-status-checks";
import {
  gitHubFetchProvenanceData,
  githubAppBackfillFetchProvenance,
  githubAppGraphqlFetchProvenance,
} from "@/lib/github-fetch-provenance";
import { recomputeAndUpdateAggregate } from "@/lib/review-decision-utils";

export type GitHubBackfillRepository = {
  id: string;
  fullName: string;
};

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

export type WriteGitHubBackfillProjectionInput = {
  organizationId: string;
  repository: GitHubBackfillRepository;
  pullRequests: readonly GitHubReadModelPullRequest[];
  pullRequestMetadata?: readonly GitHubBackfillPullRequestMetadata[];
};

const BACKFILL_PROJECTION_TRANSACTION_MAX_WAIT_MS = 5000;
const BACKFILL_PROJECTION_TRANSACTION_TIMEOUT_MS = 30_000;

/**
 * Computes and writes the same existing-branch GitHub projection fields for
 * dry-run and approved historical backfill. New branch artifact creation stays
 * out of this writer because provider data does not carry project ownership.
 */
export const githubBackfillProjectionWriter = {
  diff(input: WriteGitHubBackfillProjectionInput) {
    return withDb((db) => diffGitHubBackfillProjection(db, input));
  },
  write(input: WriteGitHubBackfillProjectionInput) {
    return withDb.tx((tx) => writeGitHubBackfillProjection(tx, input), {
      maxWait: BACKFILL_PROJECTION_TRANSACTION_MAX_WAIT_MS,
      timeout: BACKFILL_PROJECTION_TRANSACTION_TIMEOUT_MS,
    });
  },
};

async function diffGitHubBackfillProjection(
  db: TransactionClient,
  input: WriteGitHubBackfillProjectionInput
): Promise<GitHubBackfillProjectionDiff> {
  const branchNames = collectHeadBranches(input.pullRequests);
  const branches = await db.branchDetail.findMany({
    where: {
      repositoryId: input.repository.id,
      branchName: { in: branchNames },
      artifact: { organizationId: input.organizationId },
    },
    include: { currentPullRequestDetail: true },
  });
  const branchesByName = new Map(
    branches.map((branch) => [branch.branchName, branch])
  );
  const existingPrs = await db.pullRequestDetail.findMany({
    where: {
      repositoryId: input.repository.id,
      number: {
        in: input.pullRequests.map((pullRequest) => pullRequest.number),
      },
      branchArtifact: { organizationId: input.organizationId },
    },
  });
  const prsByNumber = new Map(existingPrs.map((pr) => [pr.number, pr]));
  const metadataByNumber = buildMetadataByNumber(input.pullRequestMetadata);
  const diff = emptyProjectionDiff();

  for (const pullRequest of input.pullRequests) {
    const branch = branchesByName.get(pullRequest.headBranch);
    if (!branch) {
      diff.skippedBranchCount += 1;
      continue;
    }
    const existingPr = prsByNumber.get(pullRequest.number);
    if (!existingPr) {
      diff.pullRequestProjectionChangeCount += 1;
    } else if (pullRequestProjectionWouldChange(existingPr, pullRequest)) {
      diff.pullRequestProjectionChangeCount += 1;
    }
    if (branch.currentPullRequestDetailId !== existingPr?.id) {
      diff.branchProjectionChangeCount += 1;
    }
    if (
      pullRequest.reviewDecision !== null &&
      existingPr?.reviewDecision !== pullRequest.reviewDecision
    ) {
      diff.reviewDecisionProjectionChangeCount += 1;
    }
    if (
      pullRequest.checksStatus !== null &&
      branch.checksStatus !== pullRequest.checksStatus
    ) {
      diff.checkProjectionChangeCount += 1;
    }
    const metadata = metadataByNumber.get(pullRequest.number);
    if (!metadata) {
      continue;
    }
    if (!existingPr) {
      incrementIncomingMetadataBlastRadius(diff, metadata);
      continue;
    }
    await addMetadataDiff(
      db,
      diff,
      {
        organizationId: input.organizationId,
        repositoryId: input.repository.id,
        branchArtifactId: branch.artifactId,
        pullRequestDetailId: existingPr.id,
        pullNumber: pullRequest.number,
        headSha: pullRequest.headSha,
      },
      metadata
    );
  }

  return diff;
}

async function writeGitHubBackfillProjection(
  tx: TransactionClient,
  input: WriteGitHubBackfillProjectionInput
): Promise<GitHubBackfillProjectionDiff> {
  const diff = emptyProjectionDiff();
  const metadataByNumber = buildMetadataByNumber(input.pullRequestMetadata);
  for (const pullRequest of input.pullRequests) {
    const branch = await tx.branchDetail.findFirst({
      where: {
        repositoryId: input.repository.id,
        branchName: pullRequest.headBranch,
        artifact: { organizationId: input.organizationId },
      },
      include: { currentPullRequestDetail: true },
    });
    if (!branch) {
      diff.skippedBranchCount += 1;
      continue;
    }
    const existing = await tx.pullRequestDetail.findUnique({
      where: {
        repositoryId_number: {
          repositoryId: input.repository.id,
          number: pullRequest.number,
        },
      },
    });
    incrementWriteDiff(diff, branch, existing, pullRequest);

    const prDetail = await writeExistingBranchPullRequestProjection(
      tx,
      {
        branchArtifactId: branch.artifactId,
        pullRequestDetailId: existing?.id ?? null,
        currentHeadSha: branch.headSha,
      },
      {
        organizationId: input.organizationId,
        repositoryId: input.repository.id,
        githubId: pullRequest.githubId,
        number: pullRequest.number,
        title: pullRequest.title,
        htmlUrl: pullRequest.htmlUrl,
        headBranch: pullRequest.headBranch,
        baseBranch: pullRequest.baseBranch,
        headSha: pullRequest.headSha,
        prState: pullRequest.state,
        isDraft: pullRequest.isDraft,
        additions: pullRequest.additions,
        deletions: pullRequest.deletions,
        changedFiles: pullRequest.changedFiles,
        checksStatus: pullRequest.checksStatus ?? undefined,
        reviewDecision: pullRequest.reviewDecision,
        closedAt: parseNullableDate(pullRequest.closedAt),
        mergedAt: parseNullableDate(pullRequest.mergedAt),
        mergeCommitSha: pullRequest.mergeCommitSha,
        fetchProvenance: githubAppBackfillFetchProvenance(),
      }
    );

    if (branch.currentPullRequestDetailId !== prDetail.id) {
      diff.branchProjectionChangeCount += 1;
    }
    await tx.branchDetail.update({
      where: { artifactId: branch.artifactId },
      data: {
        baseBranch: pullRequest.baseBranch || branch.baseBranch,
        baseBranchSource: pullRequest.baseBranch
          ? BranchBaseBranchSource.PullRequestBase
          : branch.baseBranchSource,
        headShaObservedAt: parseNullableDate(pullRequest.updatedAt),
        lastActivityAt: parseNullableDate(pullRequest.updatedAt),
      },
    });
    await writePullRequestMetadata(
      tx,
      {
        organizationId: input.organizationId,
        repositoryId: input.repository.id,
        branchArtifactId: branch.artifactId,
        pullRequestDetailId: prDetail.id,
        pullNumber: pullRequest.number,
        headSha: pullRequest.headSha,
      },
      metadataByNumber.get(pullRequest.number),
      diff
    );
  }
  return diff;
}

async function writePullRequestMetadata(
  tx: TransactionClient,
  scope: GitHubBackfillProjectionScope,
  metadata: GitHubBackfillPullRequestMetadata | undefined,
  diff: GitHubBackfillProjectionDiff
): Promise<void> {
  if (!metadata) {
    return;
  }
  await addMetadataDiff(tx, diff, scope, metadata);
  await writeUnifiedGitHubComments(tx, scope, metadata);
  await writeBackfillReviews(tx, scope.pullRequestDetailId, metadata.reviews);
  await writeStatusChecks(tx, scope, metadata.statusCheckRollup);
}

async function writeUnifiedGitHubComments(
  tx: TransactionClient,
  scope: GitHubBackfillProjectionScope,
  metadata: GitHubBackfillPullRequestMetadata
): Promise<void> {
  const authorCache = new Map<string, ResolvedExternalGitHubAuthor>();
  const resolveAuthor = (
    author: ExternalGitHubUser | null,
    source: ExternalGitHubAuthorSource
  ) =>
    resolveBackfillAuthor(
      tx,
      scope.organizationId,
      author,
      source,
      authorCache
    );

  for (const comment of metadata.issueComments) {
    const author = await resolveAuthor(comment.user, {
      sourceKind: "issue_comment",
      githubObjectId: String(comment.id),
      repositoryId: scope.repositoryId,
      pullNumber: scope.pullNumber,
    });
    await upsertGitHubIssueCommentThread(tx, {
      organizationId: scope.organizationId,
      branchArtifactId: scope.branchArtifactId,
      pullRequestDetailId: scope.pullRequestDetailId,
      htmlUrl: comment.html_url,
      legacyState: GitHubLegacyCommentState.PENDING,
      lastSyncedAt: new Date(),
      fetchProvenance: githubAppBackfillFetchProvenance(),
      comment: {
        githubCommentId: comment.id,
        githubHtmlUrl: comment.html_url,
        githubUpdatedAt: new Date(comment.updated_at),
        bodyMarkdown: comment.body,
        createdAt: new Date(comment.created_at),
        author: {
          userId: author.user.id,
          externalAuthorId: author.externalAuthor.id,
        },
      },
    });
  }

  for (const comment of metadata.reviewComments) {
    const author = await resolveAuthor(comment.user, {
      sourceKind: "review_comment",
      githubObjectId: String(comment.id),
      repositoryId: scope.repositoryId,
      pullNumber: scope.pullNumber,
    });
    await upsertGitHubReviewCommentThread(tx, {
      organizationId: scope.organizationId,
      branchArtifactId: scope.branchArtifactId,
      pullRequestDetailId: scope.pullRequestDetailId,
      reviewThreadId: comment.review_thread_node_id,
      reviewId: comment.pull_request_review_id
        ? String(comment.pull_request_review_id)
        : null,
      rootCommentId: comment.in_reply_to_id ?? comment.id,
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
      resolutionStatus: gitHubThreadStatusFromReviewThreadResolved(
        comment.review_thread_is_resolved
      ),
      lastSyncedAt: new Date(),
      fetchProvenance: githubAppBackfillFetchProvenance(),
      comments: [
        {
          githubCommentId: comment.id,
          githubInReplyToCommentId: comment.in_reply_to_id,
          githubHtmlUrl: comment.html_url,
          githubUpdatedAt: new Date(comment.updated_at),
          bodyMarkdown: comment.body,
          createdAt: new Date(comment.created_at),
          author: {
            userId: author.user.id,
            externalAuthorId: author.externalAuthor.id,
          },
        },
      ],
    });
  }

  if (metadata.issueCommentsComplete) {
    await softDeleteGitHubCommentProjection(tx, {
      organizationId: scope.organizationId,
      branchArtifactId: scope.branchArtifactId,
      pullRequestDetailId: scope.pullRequestDetailId,
      threadKind: GitHubCommentThreadKind.ISSUE_COMMENT,
      liveGithubCommentIds: new Set(
        metadata.issueComments.map((comment) => String(comment.id))
      ),
      deletedAt: new Date(),
      fetchProvenance: githubAppBackfillFetchProvenance(),
    });
  }
  if (metadata.reviewCommentsComplete) {
    await softDeleteGitHubCommentProjection(tx, {
      organizationId: scope.organizationId,
      branchArtifactId: scope.branchArtifactId,
      pullRequestDetailId: scope.pullRequestDetailId,
      threadKind: GitHubCommentThreadKind.REVIEW_THREAD,
      liveGithubCommentIds: new Set(
        metadata.reviewComments.map((comment) => String(comment.id))
      ),
      deletedAt: new Date(),
      fetchProvenance: githubAppBackfillFetchProvenance(),
    });
  }
}

async function resolveBackfillAuthor(
  tx: TransactionClient,
  organizationId: string,
  author: ExternalGitHubUser | null,
  source: ExternalGitHubAuthorSource,
  cache: Map<string, ResolvedExternalGitHubAuthor>
): Promise<ResolvedExternalGitHubAuthor> {
  const identity = normalizeExternalGitHubAuthor(author, source);
  if (!identity.isGhost) {
    const cached = cache.get(identity.providerUserId);
    if (cached) {
      return cached;
    }
  }
  const resolved = await resolveExternalGitHubAuthorInTransaction(tx, {
    organizationId,
    author,
    source,
  });
  if (!identity.isGhost) {
    cache.set(identity.providerUserId, resolved);
  }
  return resolved;
}

async function writeBackfillReviews(
  tx: TransactionClient,
  pullRequestDetailId: string,
  reviews: readonly GitHubPullRequestReview[]
): Promise<void> {
  const latestByAuthor = keepLatestReviewPerAuthor(reviews);
  if (latestByAuthor.size === 0) {
    return;
  }
  for (const review of latestByAuthor.values()) {
    const fetchProvenance = gitHubFetchProvenanceData(
      githubAppBackfillFetchProvenance()
    );
    await tx.gitHubPRReview.upsert({
      where: {
        pullRequestId_authorLogin: {
          pullRequestId: pullRequestDetailId,
          authorLogin: review.authorLogin,
        },
      },
      create: {
        pullRequestId: pullRequestDetailId,
        githubReviewId: review.githubReviewId,
        authorLogin: review.authorLogin,
        authorAvatarUrl: review.authorAvatarUrl,
        state: review.state,
        body: review.body,
        htmlUrl: review.htmlUrl,
        submittedAt: review.submittedAt,
        ...fetchProvenance,
      },
      update: {
        githubReviewId: review.githubReviewId,
        state: review.state,
        body: review.body,
        htmlUrl: review.htmlUrl,
        submittedAt: review.submittedAt,
        ...fetchProvenance,
      },
    });
  }
  await recomputeAndUpdateAggregate(tx, pullRequestDetailId);
}

async function writeStatusChecks(
  tx: TransactionClient,
  scope: GitHubBackfillProjectionScope,
  rollup: StatusCheckRollupResult | null
): Promise<void> {
  if (!(scope.headSha && rollup)) {
    return;
  }
  await persistBranchStatusChecksFromRollup(tx, {
    branchArtifactId: scope.branchArtifactId,
    organizationId: scope.organizationId,
    headSha: scope.headSha,
    rollup,
    fetchProvenance: githubAppGraphqlFetchProvenance({
      trigger: GitHubFetchTrigger.Backfill,
    }),
  });
}

function incrementWriteDiff(
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

function buildMetadataByNumber(
  metadata: readonly GitHubBackfillPullRequestMetadata[] | undefined
): Map<number, GitHubBackfillPullRequestMetadata> {
  return new Map((metadata ?? []).map((entry) => [entry.number, entry]));
}

async function addMetadataDiff(
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

function incrementIncomingMetadataBlastRadius(
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

function reviewThreadIdentity(comment: GitHubPullRequestReviewComment): string {
  return (
    comment.review_thread_node_id ??
    String(comment.in_reply_to_id ?? comment.id)
  );
}

function desiredReviewThreadProjection(
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

function keepLatestReviewPerAuthor(
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

function gitHubLegacyStateFromReviewThreadResolved(
  isResolved: boolean | null | undefined
): GitHubLegacyCommentState | undefined {
  if (isResolved == null) {
    return undefined;
  }
  return isResolved
    ? GitHubLegacyCommentState.ADDRESSED
    : GitHubLegacyCommentState.PENDING;
}

function gitHubThreadStatusFromReviewThreadResolved(
  isResolved: boolean | null | undefined
): ThreadStatus | undefined {
  if (isResolved == null) {
    return undefined;
  }
  return isResolved ? ThreadStatus.RESOLVED : ThreadStatus.OPEN;
}

function collectHeadBranches(
  pullRequests: readonly GitHubReadModelPullRequest[]
): string[] {
  return [
    ...new Set(
      pullRequests
        .map((pullRequest) => pullRequest.headBranch)
        .filter((branchName) => branchName.length > 0)
    ),
  ];
}

function pullRequestProjectionWouldChange(
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
    datesDiffer(existing.closedAt, incoming.closedAt) ||
    datesDiffer(existing.mergedAt, incoming.mergedAt) ||
    existing.mergeCommitSha !== incoming.mergeCommitSha
  );
}

function datesDiffer(left: Date | null, right: string | null): boolean {
  return (left?.toISOString() ?? null) !== normalizeDateString(right);
}

function parseNullableDate(value: string | null): Date | null {
  return value ? new Date(value) : null;
}

function normalizeDateString(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function emptyProjectionDiff(): GitHubBackfillProjectionDiff {
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

type GitHubBackfillProjectionScope = {
  organizationId: string;
  repositoryId: string;
  branchArtifactId: string;
  pullRequestDetailId: string;
  pullNumber: number;
  headSha: string | null;
};

type PersistableGitHubReview = {
  githubReviewId: string;
  authorLogin: string;
  authorAvatarUrl: string | null;
  state: ReviewDecision;
  body: string | null;
  htmlUrl: string;
  submittedAt: Date;
};
