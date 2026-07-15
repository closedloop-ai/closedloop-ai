import { BranchHeadShaSource } from "@repo/api/src/types/artifact";

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

/** Maximum current PR detail candidates loaded before ownership filtering. */
export const BRANCH_CURRENT_PULL_REQUEST_DETAIL_CANDIDATE_LIMIT = 10;

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

/** Returns the current pull request detail owned by the branch artifact row. */
export function getOwnedCurrentPullRequestDetail<
  Detail extends OwnedCurrentPullRequestDetail,
>(row: BranchWithCurrentPullRequest<Detail>): Detail | null {
  if (!row.branch) {
    return null;
  }
  const candidates = [
    row.branch.currentPullRequestDetail,
    ...row.pullRequestDetails,
  ];
  return (
    candidates.find(
      (detail) =>
        detail?.isCurrent &&
        detail.branchArtifactId === row.id &&
        detail.repositoryId === row.branch?.repositoryId
    ) ?? null
  );
}
