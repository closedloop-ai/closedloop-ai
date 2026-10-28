import { GitHubPRState } from "@repo/api/src/types/github";

/**
 * Rows the tracked-PR artifact read returns, in the ISS-8153 shape: the
 * artifact id, the owned `pullRequestDetails` rows, and the branch's POINTER
 * ID — the canonical PR is resolved via `resolveCloudBranchCanonicalDetail`,
 * never read off a `currentPullRequestDetail` relation.
 */
export function trackedPrArtifactRow(input: {
  branchName: string;
  number: number;
  repositoryFullName: string;
}) {
  const artifactId = `art-${input.branchName}`;
  return {
    id: artifactId,
    externalUrl: `https://github.com/${input.repositoryFullName}/tree/${input.branchName}`,
    branch: trackedBranchScalars({
      ...input,
      detailId: `detail-${input.number}`,
    }),
    pullRequestDetails: [
      {
        id: `detail-${input.number}`,
        branchArtifactId: artifactId,
        repositoryId: "repo-1",
        repositoryFullName: null,
        repository: { fullName: input.repositoryFullName },
        number: input.number,
        title: `PR ${input.number}`,
        htmlUrl: `https://github.com/${input.repositoryFullName}/pull/${input.number}`,
        prState: GitHubPRState.Open,
        isDraft: false,
        reviewDecision: null,
        githubCreatedAt: null,
        closedAt: null,
        mergedAt: null,
        lastVerifiedAt: null,
        fetchMechanism: "webhook",
        githubId: `gh-${input.number}`,
        additions: 1,
        deletions: 1,
        changedFiles: 1,
      },
    ],
  };
}

/** A branch that owns no PR rows and has no pointer. */
export function bareBranchArtifactRow(input: {
  branchName: string;
  repositoryFullName: string;
}) {
  return {
    id: `art-${input.branchName}`,
    externalUrl: `https://github.com/${input.repositoryFullName}/tree/${input.branchName}`,
    branch: trackedBranchScalars(input),
    pullRequestDetails: [],
  };
}

function trackedBranchScalars(input: {
  branchName: string;
  detailId?: string;
  repositoryFullName: string;
}) {
  return {
    branchName: input.branchName,
    currentPullRequestDetailId: input.detailId ?? null,
    repositoryId: "repo-1",
    repositoryFullName: null,
    repository: { fullName: input.repositoryFullName },
  };
}
