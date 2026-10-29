import { gitHubConfirmedHeadBranch } from "@repo/api/src/types/pull-request-github-head";
import type { TransactionClient } from "@repo/database";
import { relinkPullRequestBranchInTransaction } from "@/app/branches/pull-request-branch-relink";
import { refilePullRequestUnderGitHubHeadInTransaction } from "@/app/branches/pull-request-github-head-refile";
import { acquirePullRequestProviderIdentityLockInTransaction } from "@/app/branches/pull-request-provider-lock";
import { isWithinTrustedFutureBoundary } from "@/lib/trusted-timestamp";

/**
 * Move an existing PR projection onto the provider-authoritative head Branch.
 * Returns whether the caller must reload its PR projection after the repair.
 */
export async function repairPullRequestBranchAssociationInTransaction(
  tx: TransactionClient,
  input: {
    organizationId: string | null;
    repositoryId: string;
    repositoryFullName: string;
    headBranch: string;
    /** GitHub's head repository; null when the payload carries none. */
    headRepositoryFullName: string | null;
    pullRequestNumber: number;
    pullRequestDetailId: string;
    currentBranchArtifactId: string | null;
    incomingUpdatedAt: Date;
  }
): Promise<boolean> {
  if (!(input.organizationId && input.currentBranchArtifactId)) {
    return false;
  }
  if (!isWithinTrustedFutureBoundary(input.incomingUpdatedAt, new Date())) {
    throw new Error("pull request relink timestamp is not trustworthy");
  }
  // ISS-12344 decision record (thread th_1__bTDiF9jNPx9ebLHmn0): a head in a
  // fork, or one with no reported repository, never re-files the PR.
  const confirmedHead = gitHubConfirmedHeadBranch({
    headBranch: input.headBranch,
    headRepositoryFullName: input.headRepositoryFullName,
    repositoryFullName: input.repositoryFullName,
  });
  if (confirmedHead === undefined) {
    return false;
  }
  await acquirePullRequestProviderIdentityLockInTransaction(tx, {
    organizationId: input.organizationId,
    repositoryFullName: input.repositoryFullName,
    number: input.pullRequestNumber,
  });
  const currentPullRequest = await tx.pullRequestDetail.findFirst({
    where: {
      id: input.pullRequestDetailId,
      organizationId: input.organizationId,
    },
    select: { branchArtifactId: true, githubUpdatedAt: true },
  });
  if (!currentPullRequest) {
    return false;
  }
  if (
    currentPullRequest.githubUpdatedAt &&
    input.incomingUpdatedAt.getTime() <
      currentPullRequest.githubUpdatedAt.getTime()
  ) {
    return false;
  }
  const authoritativeBranch = await tx.branchDetail.findFirst({
    where: {
      organizationId: input.organizationId,
      repositoryId: input.repositoryId,
      branchName: input.headBranch,
    },
    select: {
      artifactId: true,
    },
  });
  if (!authoritativeBranch) {
    // ISS-12344 (Perrin Upcott, 2026-10-09, "Move it"): no Branch carries this
    // repository id, so look the head up by repository name; one missing
    // entirely is created by the reconciler, never inside this delivery.
    return refilePullRequestUnderGitHubHeadInTransaction(tx, {
      organizationId: input.organizationId,
      pullRequestDetailId: input.pullRequestDetailId,
      head: {
        branchName: input.headBranch,
        repositoryFullName: input.headRepositoryFullName,
        updatedAt: input.incomingUpdatedAt,
      },
    });
  }
  if (authoritativeBranch.artifactId === currentPullRequest.branchArtifactId) {
    return false;
  }
  await relinkPullRequestBranchInTransaction(tx, {
    organizationId: input.organizationId,
    pullRequestDetailId: input.pullRequestDetailId,
    branchArtifactId: authoritativeBranch.artifactId,
    repositoryFullName: input.repositoryFullName,
    pullRequestNumber: input.pullRequestNumber,
  });
  return true;
}
