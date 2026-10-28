import { BranchHeadShaSource } from "@repo/api/src/types/artifact";
import { branchCandidatePullRequests } from "./branch-canonical-pull-request";

export const RemoteBranchHeadShaSource = {
  MigrationPrHead: BranchHeadShaSource.MigrationPrHead,
  PullRequestWebhook: BranchHeadShaSource.PullRequestWebhook,
  PushWebhook: BranchHeadShaSource.PushWebhook,
} as const;

export const remoteBranchHeadShaSources = Object.values(
  RemoteBranchHeadShaSource
);

export function hasRemoteBranchHeadShaEvidence(input: {
  headSha: string | null;
  headShaSource: string | null;
}): boolean {
  return Boolean(
    input.headSha && isRemoteBranchHeadShaSource(input.headShaSource)
  );
}

function isRemoteBranchHeadShaSource(value: string | null): boolean {
  return Boolean(
    value && (remoteBranchHeadShaSources as readonly string[]).includes(value)
  );
}

type OwnedCurrentPullRequestDetail = {
  branchArtifactId: string;
  isCurrent: boolean;
  // Nullable for desktop-produced PRs in non-App repos (FEA-2732): they have no
  // installation-repo id. Ownership is scoped by branchArtifactId === row.id
  // below; repositoryId matches null===null for a non-App branch/PR pair.
  repositoryId: string | null;
};

type BranchWithCurrentPullRequest<
  Detail extends OwnedCurrentPullRequestDetail,
> = {
  id: string;
  branch: {
    currentPullRequestDetail: Detail | null;
    // Nullable for desktop-produced branches in non-App repos (PRD-510 D2/FR8):
    // they have no installation-repo id, so no owned current PR can match.
    repositoryId: string | null;
  } | null;
  pullRequestDetails: readonly Detail[];
};

/**
 * Returns the current pull request detail owned by the branch artifact row.
 *
 * The candidate set comes from {@link branchCandidatePullRequests} — the
 * seventh and last site that spelled the pointer/owned-set union by hand
 * (ISS-8521). Pointer-first order is preserved, which is load-bearing here and
 * pinned by a case below: two rows can carry `isCurrent` at once, and the
 * pointer's is the one that wins. Retiring the `isCurrent` term itself belongs
 * to the promotion lane (ISS-8522), not to this read.
 */
export function getOwnedCurrentPullRequestDetail<
  Detail extends OwnedCurrentPullRequestDetail,
>(row: BranchWithCurrentPullRequest<Detail>): Detail | null {
  if (!row.branch) {
    return null;
  }
  return (
    branchCandidatePullRequests(row.branch, row.pullRequestDetails).find(
      (detail) =>
        detail.isCurrent &&
        detail.branchArtifactId === row.id &&
        detail.repositoryId === row.branch?.repositoryId
    ) ?? null
  );
}
