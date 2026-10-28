import { BranchBaseBranchSource } from "@repo/api/src/types/artifact";
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import {
  type GitHubFetchCredentialType,
  GitHubFetchTrigger,
  type GitHubReadModelPullRequest,
} from "@repo/api/src/types/github-read-model";
import { type TransactionClient, withDb } from "@repo/database";
import type {
  GitHubPullRequestReview,
  StatusCheckRollupResult,
} from "@repo/github";
import type { BranchActivityAtomBatchRecord } from "@/app/branches/branch-activity-evidence-batch";
import { seedBranchOwners } from "@/app/branches/branch-owner-seed/branch-owner-seed";
import { writeExistingBranchPullRequestProjection } from "@/app/branches/github-projection-writer";
import { pullRequestHeadRepositoryObservation } from "@/app/branches/pull-request-head-authority";
import {
  buildPullRequestLifecycleActivityRecords,
  persistPullRequestLifecycleActivityRecordsInTransaction,
} from "@/app/branches/pull-request-lifecycle-activity";
import { pullRequestProviderLockHolderTxOptions } from "@/app/branches/pull-request-provider-lock";
import { persistBranchStatusChecksFromRollup } from "@/lib/branch-status-checks";
import {
  backfillFetchProvenance,
  type GitHubFetchProvenance,
  gitHubFetchProvenanceData,
  graphqlFetchProvenance,
} from "@/lib/github-fetch-provenance";
import { recomputeAndUpdateAggregate } from "@/lib/review-decision-utils";
import { keepLatestReviewPerAuthor } from "./backfill-desired-projection";
import {
  type LifecycleBranch,
  type LifecyclePullRequest,
  predictBackfillLifecycleProjectionDiff,
} from "./backfill-lifecycle-projection-diff";
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
} from "./backfill-projection-diff-counter";
import { parseNullableDate } from "./backfill-projection-helpers";
import {
  type BackfillProjectionReadScope,
  backfillPullRequestSelect,
  backfillRepositorySelector,
  loadBackfillBranchesByName,
  openBackfillProjectionReads,
} from "./backfill-projection-reads";
import { persistLatestGitHubPRReview } from "./pr-review-projection";

export type GitHubBackfillRepository = {
  /**
   * `GitHubInstallationRepository.id`, or null on the repo-less (observation)
   * lane. Never an observation row's id: that is a different table's UUID, and
   * this column is the installation-repo surrogate.
   */
  id: string | null;
  /** Provider casing; every predicate built from it normalizes first. */
  fullName: string;
};

/** Which credential actually fetched the payload being projected. */
export type GitHubBackfillCredential = {
  type: GitHubFetchCredentialType;
  /** Whose grant drew it on the pool lane; null on the installation lane. */
  ownerId: string | null;
};

export type GitHubBackfillProjectionInput = {
  organizationId: string;
  repository: GitHubBackfillRepository;
  pullRequests: readonly GitHubReadModelPullRequest[];
  pullRequestMetadata?: readonly GitHubBackfillPullRequestMetadata[];
};

/**
 * The write path additionally requires the credential, because every row it
 * persists is stamped with the lane that fetched it. The dry-run diff has no
 * such field to fill, which is why it takes the narrower input.
 */
export type WriteGitHubBackfillProjectionInput =
  GitHubBackfillProjectionInput & {
    credential: GitHubBackfillCredential;
    /** Told each pull request the write projected, for its comment reconcile. */
    onPullRequestProjected?: (pullRequest: {
      number: number;
      pullRequestDetailId: string;
    }) => void;
  };

/**
 * Computes the existing-branch projection for dry-run or approved backfill;
 * provider data never creates branch artifacts here.
 */
export const githubBackfillProjectionWriter = {
  diff(input: GitHubBackfillProjectionInput) {
    return withDb((db) => diffGitHubBackfillProjection(db, input));
  },
  write(input: WriteGitHubBackfillProjectionInput) {
    // ISS-7130: this lane reaches the same PR-provider advisory lock through
    // `writeExistingBranchPullRequestProjection`, so it reads its bounds from
    // that lock's owner rather than restating them. The HOLDER bounds, not the
    // waiter ones: a backfill keeps the lock for a whole multi-PR batch, and
    // the waiter margin is only real while the long-batch lanes stay off it.
    // Same 30s ceiling this lane already carried, now named once.
    return withDb.tx(
      (tx) => writeGitHubBackfillProjection(tx, input),
      pullRequestProviderLockHolderTxOptions
    );
  },
};

async function diffGitHubBackfillProjection(
  db: TransactionClient,
  input: GitHubBackfillProjectionInput
): Promise<GitHubBackfillProjectionDiff> {
  const scope = backfillProjectionReadScope(input);
  const branchesByName = await loadBackfillBranchesByName(
    db,
    scope,
    input.pullRequests
  );
  // Stays here, not in the reads module beside its batched branch twin: a
  // set-shaped `pullRequestDetail` read in `apps/api` must declare a sanctioned
  // population, and this lane's allowlisted exemption is pinned to THIS file.
  const existingPrs = await db.pullRequestDetail.findMany({
    where: {
      ...backfillRepositorySelector(input.repository),
      number: {
        in: input.pullRequests.map((pullRequest) => pullRequest.number),
      },
      branchArtifact: { organizationId: input.organizationId },
    },
    // The write path's own select, imported rather than restated: this read and
    // `findExistingPullRequestDetail` feed the same comparisons, so a column
    // here that the write path lacks makes the preview disagree with the write
    // it is previewing.
    select: backfillPullRequestSelect,
  });
  const prsByNumber = new Map(existingPrs.map((pr) => [pr.number, pr]));
  const metadataByNumber = buildMetadataByNumber(input.pullRequestMetadata);
  const diff = emptyProjectionDiff();
  // Accumulated inside the loop and predicted after it, exactly as the write
  // path does (#6038 review). Predicting up here against the FULL branch and PR
  // lists counted lifecycle atoms for repo-less PRs the loop below skips — the
  // write collects nothing for them, so the dry run promised a blast radius the
  // approval could not cash.
  const lifecycleBranches: LifecycleBranch[] = [];
  const lifecycleExistingPullRequests: LifecyclePullRequest[] = [];

  for (const pullRequest of input.pullRequests) {
    const branch = branchesByName.get(pullRequest.headBranch);
    if (!branch) {
      diff.skippedBranchCount += 1;
      continue;
    }
    const existingPr = prsByNumber.get(pullRequest.number);
    // Mirrors the write path's repo-less skip. Predicting a create the write
    // will never make is what turns a dry run into a promise the approval
    // cannot keep.
    if (!(existingPr || input.repository.id)) {
      diff.skippedBranchCount += 1;
      continue;
    }
    lifecycleBranches.push(branch);
    if (existingPr) {
      lifecycleExistingPullRequests.push(existingPr);
    }
    // The same three comparisons the write path makes, from the one owner: a
    // dry run that counted them differently would be a preview of a write that
    // does not happen.
    incrementWriteDiff(diff, branch, existingPr ?? null, pullRequest);
    if (branch.currentPullRequestDetailId !== existingPr?.id) {
      diff.branchProjectionChangeCount += 1;
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

  const lifecycleDiff = await predictBackfillLifecycleProjectionDiff(db, {
    organizationId: input.organizationId,
    pullRequests: input.pullRequests,
    branches: lifecycleBranches,
    existingPullRequests: lifecycleExistingPullRequests,
  });
  Object.assign(diff, lifecycleDiff);

  return diff;
}

async function writeGitHubBackfillProjection(
  tx: TransactionClient,
  input: WriteGitHubBackfillProjectionInput
): Promise<GitHubBackfillProjectionDiff> {
  const diff = emptyProjectionDiff();
  const provenance = backfillWriteProvenance(input.credential);
  const metadataByNumber = buildMetadataByNumber(input.pullRequestMetadata);
  const lifecycleRecords: BranchActivityAtomBatchRecord[] = [];
  const lifecycleBranches: LifecycleBranch[] = [];
  const lifecycleExistingPullRequests: LifecyclePullRequest[] = [];
  const reads = await openBackfillProjectionReads(
    tx,
    backfillProjectionReadScope(input),
    input.pullRequests
  );
  for (const pullRequest of input.pullRequests) {
    const { branch, existing } = await reads.resolve(pullRequest);
    if (!branch) {
      diff.skippedBranchCount += 1;
      continue;
    }
    if (!(existing || input.repository.id)) {
      // Backfill does not create PR rows on the repo-less lane, by design: the
      // shared writer's create path keys on the `(repositoryId, number)` unique
      // and refuses a null id. An unseen PR is counted as skipped — the same
      // thing `skippedBranchCount` already means one branch above: an incoming
      // PR this pass could not attach to an existing projection row.
      diff.skippedBranchCount += 1;
      continue;
    }
    // Past every skip, so this iteration WILL write: the payload-wide read
    // stops being authoritative for this branch, and for whichever branch the
    // PR currently points at, here.
    reads.markWritten({ pullRequest, branch, existing });
    lifecycleBranches.push(branch);
    if (existing) {
      lifecycleExistingPullRequests.push(existing);
    }
    incrementWriteDiff(diff, branch, existing, pullRequest);

    const openedAt = parseNullableDate(pullRequest.openedAt);
    const closedAt = parseNullableDate(pullRequest.closedAt);
    const mergedAt = parseNullableDate(pullRequest.mergedAt);
    const prDetail = await writeExistingBranchPullRequestProjection(
      tx,
      {
        branchArtifactId: branch.artifactId,
        pullRequestDetailId: existing?.id ?? null,
        pullRequestBranchArtifactId: existing?.branchArtifactId ?? null,
        currentHeadSha: branch.headSha,
      },
      {
        organizationId: input.organizationId,
        repositoryId: input.repository.id,
        // Normalized, not provider casing: the shared writer's repo-less
        // resolution matches this column literally, and every other consumer
        // normalizes internally, so the App lane is unaffected.
        repositoryFullName: normalizeRepoFullName(input.repository.fullName),
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
        githubCreatedAt: openedAt,
        githubUpdatedAt: parseNullableDate(pullRequest.updatedAt),
        closedAt,
        mergedAt,
        mergeCommitSha: pullRequest.mergeCommitSha,
        fetchProvenance: provenance.backfill,
      }
    );
    lifecycleRecords.push(
      ...buildPullRequestLifecycleActivityRecords({
        organizationId: input.organizationId,
        branchArtifactId: branch.artifactId,
        pullRequestDetailId: prDetail.id,
        openedAt,
        mergedAt,
        closedAt,
      })
    );
    if (branch.currentPullRequestDetailId !== prDetail.id) {
      diff.branchProjectionChangeCount += 1;
    }
    input.onPullRequestProjected?.({
      number: pullRequest.number,
      pullRequestDetailId: prDetail.id,
    });
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
      provenance,
      metadataByNumber.get(pullRequest.number),
      diff
    );
  }
  // ISS-12463: every branch this pass filed a PR under. The pass stamps no PR
  // author, but it can relink an already-authored PR onto the branch, and the
  // commit-author rung and PR authors stamped earlier resolve here too; the
  // seed is set-if-NULL, so a branch already seeded is untouched.
  await seedBranchOwners(
    tx,
    input.organizationId,
    lifecycleBranches.map((branch) => branch.artifactId)
  );
  const lifecycleDiff = await predictBackfillLifecycleProjectionDiff(tx, {
    organizationId: input.organizationId,
    pullRequests: input.pullRequests,
    branches: lifecycleBranches,
    existingPullRequests: lifecycleExistingPullRequests,
  });
  Object.assign(diff, lifecycleDiff);
  await persistPullRequestLifecycleActivityRecordsInTransaction(tx, {
    organizationId: input.organizationId,
    records: lifecycleRecords,
  });
  return diff;
}

async function writePullRequestMetadata(
  tx: TransactionClient,
  scope: GitHubBackfillProjectionScope,
  provenance: BackfillWriteProvenance,
  metadata: GitHubBackfillPullRequestMetadata | undefined,
  diff: GitHubBackfillProjectionDiff
): Promise<void> {
  if (!metadata) {
    return;
  }
  // The comments themselves are not written here: the caller reconciles each
  // projected pull request's comments through the comment service after this
  // transaction commits (PLN-2122 Step 4).
  await addMetadataDiff(tx, diff, scope, metadata);
  await writeBackfillReviews(
    tx,
    scope.pullRequestDetailId,
    provenance,
    metadata.reviews
  );
  await writeStatusChecks(tx, scope, provenance, metadata.statusCheckRollup);
}

async function writeBackfillReviews(
  tx: TransactionClient,
  pullRequestDetailId: string,
  provenance: BackfillWriteProvenance,
  reviews: readonly GitHubPullRequestReview[]
): Promise<void> {
  const latestByAuthor = keepLatestReviewPerAuthor(reviews);
  if (latestByAuthor.size === 0) {
    return;
  }
  const fetchProvenance = gitHubFetchProvenanceData(provenance.backfill);
  for (const review of latestByAuthor.values()) {
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
  provenance: BackfillWriteProvenance,
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
    fetchProvenance: provenance.statusCheck,
  });
}

function buildMetadataByNumber(
  metadata: readonly GitHubBackfillPullRequestMetadata[] | undefined
): Map<number, GitHubBackfillPullRequestMetadata> {
  return new Map((metadata ?? []).map((entry) => [entry.number, entry]));
}

/** The identity every read in `backfill-projection-reads.ts` scopes on. */
function backfillProjectionReadScope(
  input: GitHubBackfillProjectionInput
): BackfillProjectionReadScope {
  return {
    organizationId: input.organizationId,
    repository: input.repository,
  };
}

/**
 * The two provenance stamps one backfill projection write applies, built once
 * from the credential that actually fetched the payload. Both were hardcoded to
 * the App before ISS-7721 taught this sweep the pool lane, which would have
 * named a credential an installation-free org does not have.
 */
type BackfillWriteProvenance = {
  backfill: GitHubFetchProvenance;
  statusCheck: GitHubFetchProvenance;
};

function backfillWriteProvenance(
  credential: GitHubBackfillCredential
): BackfillWriteProvenance {
  const observedAt = new Date();
  return {
    backfill: backfillFetchProvenance({
      credentialType: credential.type,
      credentialOwnerId: credential.ownerId,
      observedAt,
    }),
    statusCheck: graphqlFetchProvenance({
      trigger: GitHubFetchTrigger.Backfill,
      credentialType: credential.type,
      credentialOwnerId: credential.ownerId,
      observedAt,
    }),
  };
}
