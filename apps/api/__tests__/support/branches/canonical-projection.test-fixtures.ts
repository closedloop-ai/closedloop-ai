import { BranchSyncStatus } from "@repo/api/src/types/artifact";
import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import { ChecksStatus } from "@repo/api/src/types/branch-checks";
import { GitHubPRState } from "@repo/api/src/types/github";
import { toBranchFileChangeTotals } from "@/__tests__/support/branches/branch-file-change-totals.test-helpers";
import type { projectCanonicalCloudBranchRow } from "@/app/branches/branch-read-service/canonical-projection";

export const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
export const NOW = new Date("2026-08-10T00:00:00.000Z");
export const REPO = "closedloop-ai/closedloop-ai";

export type BranchRowInput = Parameters<
  typeof projectCanonicalCloudBranchRow
>[0];

export function pullRequest(
  overrides: Partial<BranchRowInput["pullRequestDetails"][number]> = {}
): BranchRowInput["pullRequestDetails"][number] {
  return {
    id: "pr-1",
    authorLogin: null,
    branchArtifactId: "branch-1",
    repositoryId: "repo-1",
    repositoryFullName: REPO,
    repository: { fullName: REPO, githubRepoId: "gh-repo-1" },
    isCurrent: true,
    number: 1,
    title: "Pull request",
    htmlUrl: `https://github.com/${REPO}/pull/1`,
    prState: GitHubPRState.Open,
    isDraft: false,
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    fetchMechanism: null,
    githubId: null,
    reviewDecision: null,
    githubCreatedAt: NOW,
    closedAt: null,
    mergedAt: null,
    lastVerifiedAt: NOW,
    lastRefreshAttemptAt: null,
    headRefOid: "a".repeat(40),
    headRefName: "feat/canonical",
    headRepositoryFullName: REPO,
    ...overrides,
  };
}

export function branchRow(overrides: Partial<BranchRowInput>): BranchRowInput {
  return {
    id: "branch-1",
    organizationId: ORGANIZATION_ID,
    name: "feat/canonical",
    status: BranchStatus.Open,
    priority: null,
    externalUrl: null,
    createdAt: NOW,
    projectId: null,
    project: null,
    assigneeId: null,
    assignee: null,
    tagArtifacts: [],
    pullRequestDetails: [pullRequest({ id: "live", number: 42 })],
    ...overrides,
    _count: overrides._count ?? {
      pullRequestDetails: overrides.pullRequestDetails?.length ?? 1,
    },
    branch: {
      artifactId: "branch-1",
      repositoryId: "repo-1",
      repositoryFullName: REPO,
      branchName: "feat/canonical",
      baseBranch: "main",
      deletedAt: null,
      headSha: "head-sha-current",
      fileCacheHeadSha: "head-sha-current",
      fileCacheCapped: false,
      firstPushedAt: NOW,
      pushSource: "webhook",
      headShaSource: "push_webhook",
      headShaObservedAt: NOW,
      fileCacheStatus: "fresh",
      fileCacheFileCount: 1,
      activityAtoms: [
        {
          version: BranchActivityAtomVersion.V1,
          source: BranchActivitySource.GitHead,
          sourceEventId: "atom-1",
          occurredAt: NOW,
          activityKind: null,
          compatibilityAliasForSourceEventId: null,
          attributionKind: BranchActivityAttributionKind.Branch,
          pullRequestDetailId: null,
          completeness: BranchActivityEvidenceCompleteness.Complete,
          createdAt: NOW,
        },
      ],
      syncStatus: BranchSyncStatus.Idle,
      lastSyncStartedAt: NOW,
      lastSyncCompletedAt: NOW,
      lastSyncErrorCode: null,
      checksStatus: ChecksStatus.Passing,
      checksDetailTotalCount: 3,
      checksDetailHeadSha: null,
      repository: null,
      currentPullRequestDetail: null,
      fileChangeTotals: toBranchFileChangeTotals(
        [{ additions: 30, deletions: 4 }],
        "head-sha-current"
      ),
      ...overrides.branch,
    },
  };
}
