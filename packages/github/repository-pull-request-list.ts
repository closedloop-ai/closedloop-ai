import type { GitHubPullRequestSummary } from "@repo/api/src/types/github";
import type { GitHubReadModelPullRequest } from "@repo/api/src/types/github-read-model";
import { GitHubPRState } from "@repo/api/src/types/github-status";

export type RepositoryPullRequestListItem = GitHubPullRequestSummary;

type RepositoryPullRequestStateFilter = "open" | "closed" | "all";

/** Normalize the public PR-list limit to the existing bounded contract. */
export function normalizeRepositoryPullRequestListLimit(
  limit: number | undefined
): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return 30;
  }
  return Math.min(100, Math.max(1, Math.floor(limit)));
}

/** Return whether a read-model PR belongs to the requested provider state. */
export function repositoryPullRequestMatchesState(
  pullRequest: GitHubReadModelPullRequest,
  state: RepositoryPullRequestStateFilter
): boolean {
  if (state === "all") {
    return true;
  }
  if (state === "open") {
    return pullRequest.state === GitHubPRState.Open;
  }
  return (
    pullRequest.state === GitHubPRState.Closed ||
    pullRequest.state === GitHubPRState.Merged
  );
}

/** Keep the bounded visible window plus explicitly targeted pull requests. */
export function selectRepositoryPullRequestsForList(
  pullRequests: readonly GitHubReadModelPullRequest[],
  limit: number,
  targetNumbers: readonly number[]
): GitHubReadModelPullRequest[] {
  const targetSet = new Set(targetNumbers);
  return pullRequests.filter(
    (pullRequest, index) => index < limit || targetSet.has(pullRequest.number)
  );
}

/** Map the provider read model to the existing additive API list contract. */
export function mapRepositoryPullRequest(
  pullRequest: GitHubReadModelPullRequest
): RepositoryPullRequestListItem {
  return {
    githubId: pullRequest.githubId,
    number: pullRequest.number,
    title: pullRequest.title,
    htmlUrl: pullRequest.htmlUrl,
    headBranch: pullRequest.headBranch,
    baseBranch: pullRequest.baseBranch,
    headSha: pullRequest.headSha,
    state: pullRequest.state,
    isDraft: pullRequest.isDraft,
    additions: pullRequest.additions,
    deletions: pullRequest.deletions,
    changedFiles: pullRequest.changedFiles,
    closedAt: pullRequest.closedAt,
    mergedAt: pullRequest.mergedAt,
    mergeCommitSha: pullRequest.mergeCommitSha,
    updatedAt: pullRequest.updatedAt ?? "",
    author: pullRequest.author ?? "unknown",
    checksStatus: pullRequest.checksStatus,
    reviewDecision: pullRequest.reviewDecision,
    ...(pullRequest.headRepository === undefined
      ? {}
      : { headRepository: pullRequest.headRepository }),
    ...(pullRequest.headRepositoryUnavailable === undefined
      ? {}
      : {
          headRepositoryUnavailable: pullRequest.headRepositoryUnavailable,
        }),
  };
}
