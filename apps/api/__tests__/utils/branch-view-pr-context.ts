/**
 * Shared Branch View `PrContext` fixtures. The branch-view service suites are
 * split by responsibility (`service.test.ts`, `service-preflight.test.ts`) and
 * every one of them resolves the same pinned-active context, so the fixture
 * lives here rather than being re-declared per suite.
 */

import type { PrContext } from "@/lib/resolve-pr-context";

/** The `PullRequestDetail` row `currentPrContext()` hangs off its branch. */
export function currentPullRequestDetail() {
  return {
    id: "pr-detail-1",
    repositoryId: "repo-1",
    documentId: null,
    githubId: "github-pr-1",
    headSha: "head-sha",
    number: 42,
    title: "Feature branch",
    htmlUrl: "https://github.com/acme/repo/pull/42",
    baseBranch: "main",
    headBranch: "feature/branch-artifact",
    state: "OPEN",
    isDraft: false,
    checksStatus: null,
    reviewDecision: null,
    lastVerifiedAt: null,
    lastRefreshAttemptAt: null,
  };
}

/** A resolved context for a branch whose current PR relation is intact. */
export function currentPrContext(
  branchHeadSha: string | null = "head-sha"
): PrContext {
  return {
    externalLink: {
      id: "branch-artifact-1",
      title: "feature/branch-artifact",
      externalUrl:
        "https://github.com/acme/repo/tree/feature%2Fbranch-artifact",
      status: "OPEN",
      metadata: null,
      projectId: "project-1",
      organizationId: "org-1",
      createdBy: { githubUsername: "OctoCat" },
    },
    prMetadata: null,
    branch: {
      artifactId: "branch-artifact-1",
      repositoryId: "repo-1",
      branchName: "feature/branch-artifact",
      baseBranch: "main",
      baseBranchSource: "repository_default",
      headSha: branchHeadSha,
      headShaSource: "push_webhook",
      headShaObservedAt: new Date("2026-05-15T00:00:00Z"),
      lastPushBeforeSha: "before-sha",
      currentPullRequestDetailId: "pr-detail-1",
      checksStatus: "UNKNOWN",
      checksDetailHeadSha: null,
      checksDetailTotalCount: 0,
      checksDetailTruncated: false,
      checksDetailProviderState: null,
      checksDetailUnavailableReason: null,
      checksDetailUpdatedAt: null,
      statusChecks: [],
      fileCacheStatus: "fresh",
      fileCacheHeadSha: "head-sha",
      fileCacheFileCount: 0,
      fileCachePatchBytes: 0,
      fileCacheUpdatedAt: new Date("2026-05-15T00:00:00Z"),
      syncStatus: "fresh",
      lastSyncStartedAt: null,
      lastSyncCompletedAt: null,
      lastSyncErrorCode: null,
      lastSyncErrorMessage: null,
    },
    gitHubPullRequest: currentPullRequestDetail(),
    repositoryId: "repo-1",
    installationId: "123",
    owner: "acme",
    repo: "repo",
    pullNumber: 42,
  };
}
