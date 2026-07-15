import {
  BranchViewSyncErrorCode,
  BranchViewSyncFailureReason,
} from "@repo/api/src/types/branch-view";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
  GitHubSyncResultReason,
} from "@repo/api/src/types/github-read-model";
import type * as GitHubModule from "@repo/github";
import { GitHubProviderResultStatus } from "@repo/github";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetSinglePullRequest } = vi.hoisted(() => ({
  mockGetSinglePullRequest: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  GitHubInstallationStatus: {
    ACTIVE: "ACTIVE",
  },
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/github", async (importOriginal) => {
  const actual = await importOriginal<typeof GitHubModule>();
  return {
    getSinglePullRequest: vi.fn(),
    getSinglePullRequestWithProviderResult: async (...args: unknown[]) => {
      const value = await mockGetSinglePullRequest(...args);
      return value === null
        ? { status: actual.GitHubProviderResultStatus.ProviderUnavailable }
        : { status: actual.GitHubProviderResultStatus.Success, value };
    },
    GitHubProviderResultStatus: actual.GitHubProviderResultStatus,
  };
});

vi.mock("@repo/observability/log", () => ({
  log: {
    warn: vi.fn(),
  },
}));

import { GitHubInstallationStatus, withDb } from "@repo/database";
import { refreshPullRequestLifecycle } from "./pr-lifecycle-refresh";

const mockWithDb = vi.mocked(withDb) as unknown as ReturnType<typeof vi.fn> & {
  tx: ReturnType<typeof vi.fn>;
};
describe("refreshPullRequestLifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists closed lifecycle fields through guarded writes", async () => {
    const mockDb = {
      branchDetail: {
        count: vi.fn().mockResolvedValue(1),
      },
      pullRequestDetail: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const mockTx = {
      artifact: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      branchDetail: {
        findFirst: vi.fn().mockResolvedValue({ headSha: "head-closed" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      branchStatusCheck: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      pullRequestDetail: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));
    mockWithDb.tx.mockImplementation((callback) => callback(mockTx));
    mockGetSinglePullRequest.mockResolvedValue({
      githubId: "github-pr-42",
      number: 42,
      title: "Closed PR",
      htmlUrl: "https://github.com/acme/repo/pull/42",
      headBranch: "feature/x",
      baseBranch: "main",
      state: GitHubPRState.Closed,
      mergedAt: null,
      closedAt: "2026-05-19T20:41:49Z",
      authorLogin: "octocat",
      isDraft: false,
      headSha: "head-closed",
      baseSha: "base-sha",
      mergeCommitSha: null,
      additions: 33,
      deletions: 7,
      changedFiles: 4,
    });

    const result = await refreshPullRequestLifecycle(baseInput());

    expect(result).toEqual({
      status: "refreshed",
      headSha: "head-closed",
      baseBranch: "main",
      state: GitHubPRState.Closed,
      pullRequestDetailId: "pr-detail-1",
    });
    expect(mockGetSinglePullRequest).toHaveBeenCalledWith(
      "install-1",
      "acme",
      "repo",
      42
    );
    expect(mockDb.branchDetail.count).toHaveBeenCalledWith({
      where: expectedGuardedBranchWhere(),
    });
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenCalledWith({
      where: expectedGuardedPullRequestWhere(),
      data: expect.objectContaining({
        lastRefreshAttemptAt: expect.any(Date),
        ...expectedRestProvenance(GitHubSyncResultReason.Unknown),
      }),
    });
    expect(mockTx.artifact.updateMany).toHaveBeenCalledWith({
      where: { id: "branch-artifact-1", organizationId: "org-1" },
      data: { status: GitHubPRState.Closed },
    });
    expect(mockTx.branchDetail.updateMany).toHaveBeenCalledWith({
      where: expectedGuardedBranchWhere(),
      data: expect.objectContaining({
        baseBranch: "main",
        headSha: "head-closed",
        lastPushBeforeSha: null,
        ...expectedRestProvenance(GitHubSyncResultReason.Success),
      }),
    });
    expect(mockTx.pullRequestDetail.updateMany).toHaveBeenCalledWith({
      where: expectedGuardedPullRequestWhere(),
      data: expect.objectContaining({
        prState: GitHubPRState.Closed,
        title: "Closed PR",
        htmlUrl: "https://github.com/acme/repo/pull/42",
        isDraft: false,
        closedAt: new Date("2026-05-19T20:41:49Z"),
        mergedAt: null,
        mergeCommitSha: null,
        additions: 33,
        deletions: 7,
        changedFiles: 4,
        lastVerifiedAt: expect.any(Date),
        ...expectedRestProvenance(GitHubSyncResultReason.Success),
      }),
    });
  });

  it("persists merged lifecycle fields", async () => {
    const mockDb = {
      branchDetail: {
        count: vi.fn().mockResolvedValue(1),
      },
      pullRequestDetail: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const mockTx = {
      artifact: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      branchDetail: {
        findFirst: vi.fn().mockResolvedValue({ headSha: "head-merged" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      branchStatusCheck: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      pullRequestDetail: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));
    mockWithDb.tx.mockImplementation((callback) => callback(mockTx));
    mockGetSinglePullRequest.mockResolvedValue({
      githubId: "github-pr-42",
      number: 42,
      title: "Merged PR",
      htmlUrl: "https://github.com/acme/repo/pull/42",
      headBranch: "feature/x",
      baseBranch: "main",
      state: GitHubPRState.Merged,
      mergedAt: "2026-05-20T10:00:00Z",
      closedAt: "2026-05-20T10:00:01Z",
      authorLogin: "octocat",
      isDraft: true,
      headSha: "head-merged",
      baseSha: "base-sha",
      mergeCommitSha: "merge-sha",
    });

    const result = await refreshPullRequestLifecycle(baseInput());

    expect(result).toMatchObject({
      status: "refreshed",
      headSha: "head-merged",
      state: GitHubPRState.Merged,
    });
    expect(mockTx.artifact.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: GitHubPRState.Merged },
      })
    );
    expect(mockTx.pullRequestDetail.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          prState: GitHubPRState.Merged,
          isDraft: true,
          mergedAt: new Date("2026-05-20T10:00:00Z"),
          closedAt: new Date("2026-05-20T10:00:01Z"),
          mergeCommitSha: "merge-sha",
        }),
      })
    );
  });

  it("returns provider_unavailable without defaulting lifecycle state", async () => {
    const mockDb = {
      branchDetail: {
        count: vi.fn().mockResolvedValue(1),
      },
      pullRequestDetail: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));
    mockGetSinglePullRequest.mockResolvedValue(null);

    const result = await refreshPullRequestLifecycle(baseInput());

    expect(result).toEqual({
      status: GitHubProviderResultStatus.ProviderUnavailable,
      code: BranchViewSyncErrorCode.PrLifecycleUnavailable,
      message: "Failed to refresh pull request lifecycle",
      httpStatus: 502,
      details: { reason: BranchViewSyncFailureReason.GitHubPrUnavailable },
    });
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenNthCalledWith(1, {
      where: expectedGuardedPullRequestWhere(),
      data: expect.objectContaining({
        ...expectedRestProvenance(GitHubSyncResultReason.Unknown),
      }),
    });
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenNthCalledWith(2, {
      where: expectedGuardedPullRequestWhere(),
      data: expect.objectContaining({
        ...expectedRestProvenance(GitHubSyncResultReason.ProviderUnavailable),
      }),
    });
    expect(mockWithDb.tx).not.toHaveBeenCalled();
  });

  it("returns guarded_write_failed before stamping or GitHub when the current relation is stale", async () => {
    const mockDb = {
      branchDetail: {
        count: vi.fn().mockResolvedValue(0),
      },
      pullRequestDetail: {
        updateMany: vi.fn(),
      },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));

    const result = await refreshPullRequestLifecycle(baseInput());

    expect(result).toEqual({
      status: "guarded_write_failed",
      code: BranchViewSyncErrorCode.PrLifecycleGuardFailed,
      message: "Failed to apply pull request lifecycle refresh",
      httpStatus: 409,
      details: { reason: BranchViewSyncFailureReason.GuardedWriteFailed },
    });
    expect(mockDb.branchDetail.count).toHaveBeenCalledWith({
      where: expectedGuardedBranchWhere(),
    });
    expect(mockDb.pullRequestDetail.updateMany).not.toHaveBeenCalled();
    expect(mockGetSinglePullRequest).not.toHaveBeenCalled();
    expect(mockWithDb.tx).not.toHaveBeenCalled();
  });

  it("returns guarded_write_failed before GitHub when the current relation changes before the attempt stamp", async () => {
    const mockDb = {
      branchDetail: {
        count: vi.fn().mockResolvedValue(1),
      },
      pullRequestDetail: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));

    const result = await refreshPullRequestLifecycle(baseInput());

    expect(result).toEqual({
      status: "guarded_write_failed",
      code: BranchViewSyncErrorCode.PrLifecycleGuardFailed,
      message: "Failed to apply pull request lifecycle refresh",
      httpStatus: 409,
      details: { reason: BranchViewSyncFailureReason.GuardedWriteFailed },
    });
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenCalledWith({
      where: expectedGuardedPullRequestWhere(),
      data: expect.objectContaining({
        lastRefreshAttemptAt: expect.any(Date),
        ...expectedRestProvenance(GitHubSyncResultReason.Unknown),
      }),
    });
    expect(mockGetSinglePullRequest).not.toHaveBeenCalled();
    expect(mockWithDb.tx).not.toHaveBeenCalled();
  });

  it("returns guarded_write_failed when the current relation changes before the lifecycle detail write", async () => {
    const mockTx = {
      artifact: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      branchDetail: {
        findFirst: vi.fn().mockResolvedValue({ headSha: "head-closed" }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      branchStatusCheck: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      pullRequestDetail: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    mockWithDb.mockImplementation((callback) =>
      callback({
        branchDetail: {
          count: vi.fn().mockResolvedValue(1),
        },
        pullRequestDetail: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      })
    );
    mockWithDb.tx.mockImplementation((callback) => callback(mockTx));
    mockGetSinglePullRequest.mockResolvedValue({
      githubId: "github-pr-42",
      number: 42,
      title: "Closed PR",
      htmlUrl: "https://github.com/acme/repo/pull/42",
      headBranch: "feature/x",
      baseBranch: "main",
      state: GitHubPRState.Closed,
      mergedAt: null,
      closedAt: "2026-05-19T20:41:49Z",
      authorLogin: "octocat",
      isDraft: false,
      headSha: "head-closed",
      baseSha: "base-sha",
      mergeCommitSha: null,
    });

    const result = await refreshPullRequestLifecycle(baseInput());

    expect(result).toEqual({
      status: "guarded_write_failed",
      code: BranchViewSyncErrorCode.PrLifecycleGuardFailed,
      message: "Failed to apply pull request lifecycle refresh",
      httpStatus: 409,
      details: { reason: BranchViewSyncFailureReason.GuardedWriteFailed },
    });
    expect(mockTx.pullRequestDetail.updateMany).toHaveBeenCalledWith({
      where: expectedGuardedPullRequestWhere(),
      data: expect.objectContaining({
        prState: GitHubPRState.Closed,
      }),
    });
  });
});

function baseInput() {
  return {
    organizationId: "org-1",
    installationId: "install-1",
    owner: "acme",
    repo: "repo",
    pullNumber: 42,
    branchArtifactId: "branch-artifact-1",
    pullRequestDetailId: "pr-detail-1",
    repositoryId: "repo-1",
    requireCurrentRelation: true,
  };
}

function expectedGuardedBranchWhere() {
  return {
    artifactId: "branch-artifact-1",
    repositoryId: "repo-1",
    artifact: { organizationId: "org-1" },
    repository: {
      removedAt: null,
      installation: {
        organizationId: "org-1",
        status: GitHubInstallationStatus.ACTIVE,
      },
    },
    currentPullRequestDetailId: "pr-detail-1",
  };
}

function expectedGuardedPullRequestWhere() {
  return {
    id: "pr-detail-1",
    branchArtifactId: "branch-artifact-1",
    repositoryId: "repo-1",
    branchArtifact: { organizationId: "org-1" },
    repository: {
      removedAt: null,
      installation: {
        organizationId: "org-1",
        status: GitHubInstallationStatus.ACTIVE,
      },
    },
    currentForBranches: { some: expectedGuardedBranchWhere() },
  };
}

function expectedRestProvenance(resultReason: GitHubSyncResultReason) {
  return {
    fetchCredentialType: GitHubFetchCredentialType.GitHubApp,
    fetchCredentialOwnerId: null,
    fetchMechanism: GitHubFetchMechanism.Rest,
    fetchTrigger: GitHubFetchTrigger.SurfaceOpen,
    fetchObservedAt: expect.any(Date),
    fetchResultReason: resultReason,
  };
}
