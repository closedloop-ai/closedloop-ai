import {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks";
import { GitHubPRState } from "@repo/api/src/types/github";

/**
 * Row fixtures for the projection PR read, shared by `projection-read.test.ts`
 * and `projection-read-producer-parity.test.ts`. ISS-8162 split the parity suite
 * into its own file; these live here so the two cannot drift into disagreeing
 * about what a stored row looks like.
 */
export const ORG = "org-1";
export const REPO = "repo-1";
export const REPO_SELECTOR = { repositoryId: REPO } as const;

// One PR's provider facts, fed to BOTH producers of GitHubPullRequestSummary.
export const PARITY_PR = {
  databaseId: 100,
  nodeId: "PR_node_1",
  number: 7,
  title: "Add X",
  htmlUrl: "https://github.com/acme/widgets/pull/7",
  baseBranch: "main",
  headRefName: "feature/renamed-on-github",
  headRefOid: "head-oid",
  authorLogin: "octocat",
} as const;

// The owning Branch artifact's CURRENT name, deliberately different from the
// provider head ref: the rename / multi-PR case where inferring headBranch from
// the Branch row disagrees with what GitHub reports for this PR.
export const PARITY_BRANCH_ARTIFACT_NAME = "feature/before-the-rename";

/**
 * The owning Branch's CURRENT base, deliberately different from the PR's own
 * (`PARITY_PR.baseBranch`). This is the retargeted / multi-PR branch: reading the
 * Branch row reported THIS value on every historical PR of that branch, which is
 * the confident wrong answer ISS-8155 removed. No assertion in this file may
 * ever produce it.
 */
export const BRANCH_CURRENT_BASE_DECOY = "release/retargeted";

export function prRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "pr-detail-1",
    githubId: "100",
    number: 7,
    title: "Add X",
    htmlUrl: "https://github.com/acme/widgets/pull/7",
    prState: GitHubPRState.Merged,
    isDraft: false,
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    closedAt: new Date("2026-02-11T09:00:00Z"),
    mergedAt: new Date("2026-02-11T09:00:00Z"),
    mergeCommitSha: "merge-sha",
    githubUpdatedAt: new Date("2026-02-11T09:00:00Z"),
    headRefName: "feature-x",
    baseRefName: "main",
    headRefOid: "head-oid",
    headRepositoryGithubId: null,
    headRepositoryFullName: null,
    headRepositoryDefaultBranchName: null,
    headRepositoryDefaultBranchAvailability: null,
    headRepositoryDefaultBranchCompleteness: null,
    headRepositoryDefaultBranchReason: null,
    headRepositoryDefaultBranchSource: null,
    headRepositoryDefaultBranchMechanism: null,
    headRepositoryDefaultBranchTrigger: null,
    headRepositoryDefaultBranchCredentialType: null,
    headRepositoryDefaultBranchCredentialOwnerId: null,
    headRepositoryDefaultBranchObservationKey: null,
    headRepositoryDefaultBranchObservedAt: null,
    headRepositoryDefaultBranchEventAt: null,
    authorLogin: "octocat",
    reviewDecision: ReviewDecision.Approved,
    branchArtifact: {
      branch: {
        branchName: "feature-x",
        baseBranch: BRANCH_CURRENT_BASE_DECOY,
        checksStatus: ChecksStatus.Passing,
        currentPullRequestDetailId: "pr-detail-1",
      },
    },
    ...overrides,
  };
}

/** The PARITY_PR facts as the projection stores them, on a renamed branch. */
export function parityRow(overrides: Record<string, unknown> = {}) {
  return prRow({
    githubId: String(PARITY_PR.databaseId),
    number: PARITY_PR.number,
    title: PARITY_PR.title,
    htmlUrl: PARITY_PR.htmlUrl,
    headRefName: PARITY_PR.headRefName,
    baseRefName: PARITY_PR.baseBranch,
    headRefOid: PARITY_PR.headRefOid,
    branchArtifact: {
      branch: {
        branchName: PARITY_BRANCH_ARTIFACT_NAME,
        baseBranch: BRANCH_CURRENT_BASE_DECOY,
        checksStatus: ChecksStatus.Passing,
        currentPullRequestDetailId: "pr-detail-1",
      },
    },
    ...overrides,
  });
}
