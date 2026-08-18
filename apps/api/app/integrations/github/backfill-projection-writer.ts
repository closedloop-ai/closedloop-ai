import { BranchBaseBranchSource } from "@repo/api/src/types/artifact";
import {
  GitHubFetchTrigger,
  type GitHubReadModelPullRequest,
} from "@repo/api/src/types/github-read-model";
import {
  GitHubCommentThreadKind,
  GitHubLegacyCommentState,
  type TransactionClient,
  withDb,
} from "@repo/database";
import type {
  GitHubPullRequestReview,
  StatusCheckRollupResult,
} from "@repo/github";
import { writeExistingBranchPullRequestProjection } from "@/app/branches/github-projection-writer";
import { pullRequestHeadRepositoryObservation } from "@/app/branches/pull-request-head-authority";
import { createExternalGitHubAuthorResolutionCache } from "@/app/comments/external-author-resolution-cache";
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
import {
  gitHubLegacyStateFromReviewThreadResolved,
  gitHubThreadStatusFromReviewThreadResolved,
  keepLatestReviewPerAuthor,
} from "./backfill-desired-projection";
import type {
  GitHubBackfillProjectionDiff,
  GitHubBackfillProjectionScope,
  GitHubBackfillPullRequestMetadata,
} from "./backfill-projection-contract";
import {
  addMetadataDiff,
  emptyProjectionDiff,
  incrementIncomingMetadataBlastRadius,
  incrementWriteDiff,
  pullRequestProjectionWouldChange,
} from "./backfill-projection-diff-counter";
import { persistLatestGitHubPRReview } from "./pr-review-projection";

export type GitHubBackfillRepository = {
  id: string;
  fullName: string;
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
 * Computes the existing-branch projection for dry-run or approved backfill;
 * provider data never creates branch artifacts here.
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
        headRepositoryObservation:
          pullRequestHeadRepositoryObservation(pullRequest),
        githubCreatedAt: parseNullableDate(pullRequest.openedAt),
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
      },
      select: { artifactId: true },
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
  const resolveAuthor = createExternalGitHubAuthorResolutionCache(
    tx,
    scope.organizationId
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
    await persistLatestGitHubPRReview(tx, {
      pullRequestId: pullRequestDetailId,
      githubReviewId: review.githubReviewId,
      authorLogin: review.authorLogin,
      authorAvatarUrl: review.authorAvatarUrl,
      state: review.state,
      body: review.body,
      htmlUrl: review.htmlUrl,
      submittedAt: review.submittedAt,
      ...fetchProvenance,
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

function buildMetadataByNumber(
  metadata: readonly GitHubBackfillPullRequestMetadata[] | undefined
): Map<number, GitHubBackfillPullRequestMetadata> {
  return new Map((metadata ?? []).map((entry) => [entry.number, entry]));
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

function parseNullableDate(value: string | null): Date | null {
  return value ? new Date(value) : null;
}
