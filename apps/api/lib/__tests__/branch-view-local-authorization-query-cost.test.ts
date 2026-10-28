/**
 * ISS-9156: the Branch View local authorization path resolves its PR context
 * through the REAL `resolvePrContext`, so the queries that resolution issues are
 * this boundary's per-authorization cost.
 *
 * The sibling suite (`branch-view-local-authorization.test.ts`) mocks
 * `resolvePrContext` wholesale and therefore cannot observe them at all. Here the
 * resolver runs for real against a mocked `withDb`, which is what makes
 * `artifactLink.findFirst` observable: it was issued on every authorization to
 * populate `PrContext.gitHubPullRequest.documentId`, whose only two readers were
 * deleted by ISS-6400 (`4792850e2d`).
 *
 * `artifactFindFirst` is asserted alongside every "never called" so the negative
 * cannot pass vacuously — a resolver that returned early, or a mock wired to the
 * wrong module, would fail that positive first.
 */
import {
  BranchViewLocalErrorCode,
  BranchViewLocalGatewayPath,
  BranchViewLocalHeader,
} from "@repo/api/src/types/branch-view-local";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  artifactFindFirst: vi.fn(),
  artifactLinkFindFirst: vi.fn(),
  computeTargetsService: { findAccessibleById: vi.fn() },
  evaluateServerFeatureFlagForDistinctId: vi.fn(),
  usersService: { findById: vi.fn() },
}));

vi.mock("server-only", () => ({}));

// Only the two models the authorization path can reach are stubbed. The branch
// artifact is pinned to an ACTIVE same-org installation, so credential
// resolution short-circuits before any installation-repository lookup; a change
// that reaches one should fail loudly here rather than read as an absent query.
vi.mock("@repo/database", () => ({
  ArtifactType: { BRANCH: "BRANCH" },
  GitHubInstallationStatus: { ACTIVE: "ACTIVE" },
  withDb: (fn: (db: unknown) => unknown) =>
    fn({
      artifact: { findFirst: mocks.artifactFindFirst },
      artifactLink: { findFirst: mocks.artifactLinkFindFirst },
    }),
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: mocks.computeTargetsService,
}));

vi.mock("@/app/users/service", () => ({
  usersService: mocks.usersService,
}));

vi.mock("@/lib/feature-flags/server-feature-flag-evaluation", () => ({
  evaluateServerFeatureFlagForDistinctId:
    mocks.evaluateServerFeatureFlagForDistinctId,
}));

import { validateBranchViewLocalAccess } from "@/lib/branch-view-local-authorization";

const ORG_ID = "org-1";
const USER_ID = "user-1";
const COMPUTE_TARGET_ID = "target-1";
const EXTERNAL_LINK_ID = "branch-artifact-1";
const REPO_FULL_NAME = "acme/repo";
const HEAD_BRANCH = "feature/local";
const PR_NUMBER = 42;
const GITHUB_USERNAME = "octocat";

describe("Branch View local authorization PR-context query cost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.artifactFindFirst.mockResolvedValue(branchArtifactRow());
    mocks.usersService.findById.mockResolvedValue({
      active: true,
      githubUsername: GITHUB_USERNAME,
      id: USER_ID,
    });
    mocks.evaluateServerFeatureFlagForDistinctId.mockResolvedValue(true);
    mocks.computeTargetsService.findAccessibleById.mockResolvedValue({
      id: COMPUTE_TARGET_ID,
      isOnline: true,
    });
  });

  it("grants a matching author without issuing an artifact-link query", async () => {
    const result = await validateBranchViewLocalAccess(validInput());

    expect(result).toEqual({
      ok: true,
      metadataHeaders: {
        [BranchViewLocalHeader.Operation]: "1",
        [BranchViewLocalHeader.ExternalLinkId]: EXTERNAL_LINK_ID,
        [BranchViewLocalHeader.RepoFullName]: REPO_FULL_NAME,
        [BranchViewLocalHeader.HeadBranch]: HEAD_BRANCH,
        [BranchViewLocalHeader.PrNumber]: "42",
        [BranchViewLocalHeader.AuthorizedUserId]: USER_ID,
        [BranchViewLocalHeader.AuthorizedOrgId]: ORG_ID,
      },
    });
    expect(mocks.artifactFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.artifactLinkFindFirst).not.toHaveBeenCalled();
  });

  it("denies a mismatched PR number without issuing an artifact-link query", async () => {
    const result = await validateBranchViewLocalAccess({
      ...validInput(),
      prNumber: 99,
    });

    expect(result).toEqual({
      ok: false,
      status: 403,
      code: BranchViewLocalErrorCode.ContextMismatch,
      error: BranchViewLocalErrorCode.ContextMismatch,
    });
    expect(mocks.artifactFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.artifactLinkFindFirst).not.toHaveBeenCalled();
  });

  it("denies a non-author without issuing an artifact-link query", async () => {
    mocks.usersService.findById.mockResolvedValue({
      active: true,
      githubUsername: "someone-else",
      id: USER_ID,
    });

    const result = await validateBranchViewLocalAccess(validInput());

    expect(result).toEqual({
      ok: false,
      status: 403,
      code: BranchViewLocalErrorCode.NotAuthor,
      error: BranchViewLocalErrorCode.NotAuthor,
    });
    expect(mocks.artifactFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.artifactLinkFindFirst).not.toHaveBeenCalled();
  });
});

function validInput() {
  return {
    computeTargetId: COMPUTE_TARGET_ID,
    externalLinkId: EXTERNAL_LINK_ID,
    headBranch: HEAD_BRANCH,
    operationPath: BranchViewLocalGatewayPath.CommitPush,
    organizationId: ORG_ID,
    prNumber: PR_NUMBER,
    repoFullName: REPO_FULL_NAME,
    userId: USER_ID,
  };
}

/**
 * A BRANCH artifact with a valid current PR detail — the shape
 * `db.artifact.findFirst` returns to `resolvePrContext`, pinned to an ACTIVE
 * same-org installation so credential resolution needs no further query.
 */
function branchArtifactRow() {
  const repositoryId = "repo-1";
  return {
    id: EXTERNAL_LINK_ID,
    organizationId: ORG_ID,
    projectId: "proj-1",
    name: HEAD_BRANCH,
    status: "OPEN",
    externalUrl: `https://github.com/${REPO_FULL_NAME}/tree/${HEAD_BRANCH}`,
    createdBy: { githubUsername: GITHUB_USERNAME },
    branch: {
      artifactId: EXTERNAL_LINK_ID,
      repositoryId,
      branchName: HEAD_BRANCH,
      baseBranch: "main",
      baseBranchSource: "pull_request_base",
      headSha: "head-sha",
      headShaSource: "pull_request_webhook",
      headShaObservedAt: null,
      lastPushBeforeSha: null,
      currentPullRequestDetailId: "pr-detail-1",
      checksStatus: "UNKNOWN",
      fileCacheStatus: "absent",
      fileCacheHeadSha: null,
      fileCacheFileCount: 0,
      fileCachePatchBytes: 0,
      fileCacheUpdatedAt: null,
      syncStatus: "idle",
      lastSyncStartedAt: null,
      lastSyncCompletedAt: null,
      lastSyncErrorCode: null,
      lastSyncErrorMessage: null,
      currentPullRequestDetail: {
        id: "pr-detail-1",
        branchArtifactId: EXTERNAL_LINK_ID,
        repositoryId,
        githubId: "github-pr-1",
        number: PR_NUMBER,
        title: "Current PR",
        htmlUrl: `https://github.com/${REPO_FULL_NAME}/pull/${PR_NUMBER}`,
        prState: "OPEN",
        isDraft: false,
        reviewDecision: null,
      },
      repository: {
        id: repositoryId,
        githubRepoId: "github-repo-1",
        fullName: REPO_FULL_NAME,
        removedAt: null,
        installation: {
          installationId: "install-1",
          organizationId: ORG_ID,
          status: "ACTIVE",
        },
      },
    },
  };
}
