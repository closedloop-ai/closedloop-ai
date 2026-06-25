import type { ApiKeyScope } from "@repo/api/src/types/api-key";
import {
  BranchFileCacheStatus,
  BranchSyncStatus,
} from "@repo/api/src/types/artifact";
import { StatusCheckRollupFailureReason } from "@repo/api/src/types/github";
import type * as GitHubModule from "@repo/github";
import { GitHubProviderResultStatus } from "@repo/github";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockListPullRequestIssueComments,
  mockListPullRequestReviewComments,
  mockListPullRequestReviews,
  mockQueryStatusCheckRollup,
  mockRecomputeAndUpdateAggregate,
  mockMarkBranchSyncCompleted,
  mockMarkBranchSyncFailed,
  mockMarkBranchSyncProviderRateLimited,
  mockRefreshBranchFileChangeCache,
  mockRefreshPullRequestLifecycle,
  mockResolvePrContext,
  mockRelinkBranchViewRepositoryCredential,
  mockSchedulePrReadRepair,
  mockResolveExternalGitHubAuthorInTransaction,
  mockSoftDeleteGitHubCommentProjection,
  mockStartBranchSync,
  mockUpsertGitHubIssueCommentThread,
  mockUpsertGitHubReviewCommentThread,
  mockWithDb,
} = vi.hoisted(() => ({
  mockListPullRequestIssueComments: vi.fn(),
  mockListPullRequestReviewComments: vi.fn(),
  mockListPullRequestReviews: vi.fn(),
  mockQueryStatusCheckRollup: vi.fn(),
  mockRecomputeAndUpdateAggregate: vi.fn(),
  mockMarkBranchSyncCompleted: vi.fn(),
  mockMarkBranchSyncFailed: vi.fn(),
  mockMarkBranchSyncProviderRateLimited: vi.fn(),
  mockRefreshBranchFileChangeCache: vi.fn(),
  mockRefreshPullRequestLifecycle: vi.fn(),
  mockResolvePrContext: vi.fn(),
  mockRelinkBranchViewRepositoryCredential: vi.fn(),
  mockSchedulePrReadRepair: vi.fn(),
  mockResolveExternalGitHubAuthorInTransaction: vi.fn(),
  mockSoftDeleteGitHubCommentProjection: vi.fn(),
  mockStartBranchSync: vi.fn(),
  mockUpsertGitHubIssueCommentThread: vi.fn(),
  mockUpsertGitHubReviewCommentThread: vi.fn(),
  mockWithDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/database", () => ({
  withDb: mockWithDb,
  ArtifactSubtype: {
    FEATURE: "FEATURE",
    IMPLEMENTATION_PLAN: "IMPLEMENTATION_PLAN",
  },
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
  },
  ExternalCommentProvider: {
    GITHUB: "GITHUB",
  },
  ThreadSource: {
    GITHUB: "GITHUB",
  },
  Prisma: {
    join: (values: unknown[]) => values,
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
  },
}));

vi.mock("@repo/github", async (importOriginal) => {
  const actual = await importOriginal<typeof GitHubModule>();
  const { toGitHubProviderResultMock } = await import(
    "../../../__tests__/helpers/github-provider-result-mock"
  );

  return {
    getSinglePullRequest: vi.fn(),
    GitHubProviderResultStatus: actual.GitHubProviderResultStatus,
    listPullRequestIssueComments: mockListPullRequestIssueComments,
    listPullRequestIssueCommentsWithProviderResult: async (
      ...args: unknown[]
    ) =>
      toGitHubProviderResultMock(
        await mockListPullRequestIssueComments(...args)
      ),
    listPullRequestReviewComments: mockListPullRequestReviewComments,
    listPullRequestReviewCommentsWithProviderResult: async (
      ...args: unknown[]
    ) =>
      toGitHubProviderResultMock(
        await mockListPullRequestReviewComments(...args)
      ),
    listPullRequestReviews: mockListPullRequestReviews,
    listPullRequestReviewsWithProviderResult: async (...args: unknown[]) =>
      toGitHubProviderResultMock(await mockListPullRequestReviews(...args)),
    queryStatusCheckRollup: mockQueryStatusCheckRollup,
    queryStatusCheckRollupWithProviderResult: async (...args: unknown[]) =>
      toGitHubProviderResultMock(await mockQueryStatusCheckRollup(...args)),
  };
});

vi.mock("@/app/branches/branch-sync-status", () => ({
  markBranchSyncCompleted: mockMarkBranchSyncCompleted,
  markBranchSyncFailed: mockMarkBranchSyncFailed,
  markBranchSyncProviderRateLimited: mockMarkBranchSyncProviderRateLimited,
  parseBranchSyncStatus: (value: string | null | undefined) => value ?? null,
  startBranchSync: mockStartBranchSync,
}));

vi.mock("@/app/branches/file-cache-service", () => ({
  refreshBranchFileChangeCache: mockRefreshBranchFileChangeCache,
}));

vi.mock("@/lib/resolve-pr-context", () => ({
  BranchViewContextCredentialMode: {
    PinnedActiveOnly: "pinned_active_only",
    RenderRead: "render_read",
  },
  BranchViewContextCredentialSource: {
    PinnedActive: "pinned_active",
    ActiveSibling: "active_sibling",
  },
  resolvePrContext: mockResolvePrContext,
}));

vi.mock("@/app/integrations/github/service", () => ({
  RepositoryArtifactRelinkReason: {
    None: "none",
    NoActiveInstallation: "no_active_installation",
    NoActiveRepositories: "no_active_repositories",
    ActiveRepositoryAmbiguous: "active_repository_ambiguous",
    BranchNameCollision: "branch_name_collision",
    PullRequestNumberCollision: "pull_request_number_collision",
    GuardedWriteFailed: "guarded_write_failed",
  },
  RepositoryArtifactRelinkStatus: {
    Completed: "completed",
    Partial: "partial",
    Skipped: "skipped",
  },
  githubService: {
    relinkBranchViewRepositoryCredential:
      mockRelinkBranchViewRepositoryCredential,
  },
}));

vi.mock("@/app/comments/external-authors", () => ({
  normalizeGitHubLogin: (login: string) => login.trim().toLowerCase(),
  resolveExternalGitHubAuthorInTransaction:
    mockResolveExternalGitHubAuthorInTransaction,
}));

vi.mock("@/app/comments/github-diff-side", () => ({
  normalizeGitHubDiffSide: (side: string | null | undefined) =>
    side === "LEFT" || side === "RIGHT" ? side : null,
}));

vi.mock("@/app/comments/github-projection", () => ({
  softDeleteGitHubCommentProjection: mockSoftDeleteGitHubCommentProjection,
  upsertGitHubIssueCommentThread: mockUpsertGitHubIssueCommentThread,
  upsertGitHubReviewCommentThread: mockUpsertGitHubReviewCommentThread,
}));

vi.mock("@/lib/review-decision-utils", () => ({
  recomputeAndUpdateAggregate: mockRecomputeAndUpdateAggregate,
}));

vi.mock("@/lib/pr-lifecycle-refresh", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  refreshPullRequestLifecycle: mockRefreshPullRequestLifecycle,
}));

vi.mock("@/lib/pr-read-repair", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  schedulePrReadRepair: mockSchedulePrReadRepair,
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  BranchViewCheckKind,
  BranchViewChecksProviderState,
  BranchViewCommentWriteIdentityStatus,
  BranchViewFileCacheSyncErrorCode,
  BranchViewLoadErrorCode,
  BranchViewPrLifecycleRepairStatus,
  BranchViewSyncErrorCode,
  BranchViewSyncFailureReason,
  BranchViewSyncOutcomeSource,
  BranchViewSyncPresentationState,
  BranchViewSyncScope,
  BranchViewSyncThrottleReason,
  CommentKind,
  GitHubCommentThreadKind,
  GitHubDiffSide,
  PrCommentAuthorKind,
} from "@repo/api/src/types/branch-view";
import { statusRollup } from "@/__tests__/utils/status-check-helpers";
import {
  RepositoryArtifactRelinkReason,
  type RepositoryArtifactRelinkResult,
  RepositoryArtifactRelinkStatus,
} from "@/app/integrations/github/service";
import {
  BranchViewContextCredentialMode,
  BranchViewContextCredentialSource,
  type PrContext,
} from "@/lib/resolve-pr-context";
import {
  buildCanonicalGitHubPullRequestUrl,
  buildStaleCommentDeleteWhere,
  fetchUnifiedBranchViewComments,
  getBranchViewData,
  resolveBranchViewMissingContextFailure,
  resolveBranchViewSyncPreflightContext,
  syncBranchViewData,
  syncBranchViewDataWithRequest,
} from "./service";

describe("buildStaleCommentDeleteWhere", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes all comment rows when GitHub returns no comments", () => {
    expect(buildStaleCommentDeleteWhere("pr-1", new Set())).toEqual({
      pullRequestId: "pr-1",
    });
  });

  it("deletes only rows missing from the live GitHub comment set", () => {
    expect(
      buildStaleCommentDeleteWhere("pr-1", new Set(["101", "202"]))
    ).toEqual({
      pullRequestId: "pr-1",
      githubCommentId: { notIn: ["101", "202"] },
    });
  });
});

describe("buildCanonicalGitHubPullRequestUrl", () => {
  it("accepts only canonical identity-matched GitHub pull request URLs", () => {
    expect(
      buildCanonicalGitHubPullRequestUrl({
        candidateUrls: ["https://github.com/Acme/Repo/pull/42"],
        owner: "acme",
        repo: "repo",
        pullNumber: 42,
      })
    ).toBe("https://github.com/acme/repo/pull/42");

    for (const candidateUrl of [
      "https://github.com/other/repo/pull/42",
      "https://github.com/acme/other/pull/42",
      "https://github.com/acme/repo/pull/43",
      "https://github.com/acme/repo/pull/42?check=1",
      "https://github.com/acme/repo/pull/42#discussion_r1",
      "https://github.com/acme/repo/pull/42/files",
      "https://example.com/acme/repo/pull/42",
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(
        buildCanonicalGitHubPullRequestUrl({
          candidateUrls: [candidateUrl],
          owner: "acme",
          repo: "repo",
          pullNumber: 42,
        })
      ).toBeUndefined();
    }
  });

  it("rejects unsafe identity inputs before reading candidate URLs", () => {
    expect(
      buildCanonicalGitHubPullRequestUrl({
        candidateUrls: ["https://github.com/acme/repo/pull/42"],
        owner: "acme",
        repo: "repo",
        pullNumber: null,
      })
    ).toBeUndefined();
    expect(
      buildCanonicalGitHubPullRequestUrl({
        candidateUrls: ["https://github.com/acme/repo/pull/42"],
        owner: "acme/bad",
        repo: "repo",
        pullNumber: 42,
      })
    ).toBeUndefined();
  });
});

describe("getBranchViewData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes an orphaned file-cache pointer (no rows at pointer) before serving the diff", async () => {
    const branchBase = {
      artifactId: "branch-artifact-1",
      repositoryId: "repo-1",
      branchName: "feature/branch-artifact",
      baseBranch: "main",
      baseBranchSource: "repository_default",
      headSha: "new-head",
      headShaSource: "push_webhook",
      headShaObservedAt: new Date("2026-05-15T00:00:00Z"),
      lastPushBeforeSha: "before-sha",
      currentPullRequestDetailId: "pr-detail-1",
      checksStatus: "UNKNOWN",
      fileCacheStatus: "fresh",
      fileCacheFileCount: 1,
      fileCachePatchBytes: 8,
      fileCacheUpdatedAt: new Date("2026-05-15T00:00:00Z"),
      syncStatus: "fresh",
      lastSyncStartedAt: new Date("2026-05-15T00:00:00Z"),
      lastSyncCompletedAt: new Date("2026-05-15T00:01:00Z"),
      lastSyncErrorCode: null,
      lastSyncErrorMessage: null,
    };
    const externalLink = {
      id: "branch-artifact-1",
      title: "feature/branch-artifact",
      externalUrl:
        "https://github.com/acme/repo/tree/feature%2Fbranch-artifact",
      status: "OPEN",
      metadata: null,
      projectId: "project-1",
      organizationId: "org-1",
      createdBy: null,
    };
    const baseCtx = {
      externalLink,
      prMetadata: null,
      gitHubPullRequest: currentPullRequestDetail(),
      repositoryId: "repo-1",
      installationId: "123",
      owner: "acme",
      repo: "repo",
      pullNumber: 42,
    };
    // Pointer (stale-pointer) is behind the head (new-head); the realigned
    // context returned after refresh points the cache at the head.
    const staleCtx = {
      ...baseCtx,
      branch: { ...branchBase, fileCacheHeadSha: "stale-pointer" },
    };
    const healedCtx = {
      ...baseCtx,
      branch: { ...branchBase, fileCacheHeadSha: "new-head" },
    };

    const mockDb = {
      artifactLink: { findFirst: vi.fn().mockResolvedValue(null) },
      project: { findFirst: vi.fn().mockResolvedValue(projectRecoveryRow()) },
      branchFileChange: {
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([
          {
            path: "src/changed.ts",
            previousPath: null,
            status: "modified",
            additions: 4,
            deletions: 1,
            patch: "@@ patch",
          },
        ]),
      },
      commentThread: { findMany: vi.fn().mockResolvedValue([]) },
      gitHubPRReview: { findMany: vi.fn().mockResolvedValue([]) },
      gitHubUserConnection: { findUnique: vi.fn().mockResolvedValue(null) },
      pullRequestDetail: {
        findUnique: vi.fn().mockResolvedValue({ reviewDecision: null }),
      },
      user: { findMany: vi.fn().mockResolvedValue([]) },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));
    mockRefreshBranchFileChangeCache.mockResolvedValue({ ok: true });
    mockResolvePrContext.mockResolvedValue(healedCtx);

    const result = await getBranchViewData(
      staleCtx as never,
      {
        id: "user-1",
        githubUsername: "octocat",
      } as never
    );

    expect(mockDb.branchFileChange.count).toHaveBeenCalledWith({
      where: {
        branchArtifactId: "branch-artifact-1",
        headSha: "stale-pointer",
      },
    });
    expect(mockRefreshBranchFileChangeCache).toHaveBeenCalledWith(
      "branch-artifact-1",
      { organizationId: "org-1" }
    );
    expect(mockResolvePrContext).toHaveBeenCalledWith(
      "branch-artifact-1",
      "org-1"
    );
    // Files are served from the realigned head SHA, not the stale pointer.
    expect(mockDb.branchFileChange.findMany).toHaveBeenCalledWith({
      where: { branchArtifactId: "branch-artifact-1", headSha: "new-head" },
      orderBy: { path: "asc" },
    });
    const data = expectOk(result);
    expect(data?.branch?.fileCacheHeadSha).toBe("new-head");
  });

  it("does not run file-cache read-repair for active-sibling render contexts", async () => {
    const mockDb = {
      artifactLink: { findFirst: vi.fn().mockResolvedValue(null) },
      project: { findFirst: vi.fn().mockResolvedValue(projectRecoveryRow()) },
      branchFileChange: {
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([
          {
            path: "src/stale-cached.ts",
            previousPath: null,
            status: "modified",
            additions: 1,
            deletions: 0,
            patch: "@@ cached",
          },
        ]),
      },
      commentThread: { findMany: vi.fn().mockResolvedValue([]) },
      gitHubPRReview: { findMany: vi.fn().mockResolvedValue([]) },
      gitHubUserConnection: { findUnique: vi.fn().mockResolvedValue(null) },
      pullRequestDetail: {
        findUnique: vi.fn().mockResolvedValue({ reviewDecision: null }),
      },
      user: { findMany: vi.fn().mockResolvedValue([]) },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));
    const ctx = currentPrContext();
    ctx.credentialSource = BranchViewContextCredentialSource.ActiveSibling;
    ctx.credentialRepositoryId = "active-repo-1";
    ctx.branch!.fileCacheHeadSha = "stale-pointer";

    const result = await getBranchViewData(ctx, {
      id: "user-1",
      githubUsername: "octocat",
    } as never);

    const data = expectOk(result);
    expect(data?.branch?.fileCacheHeadSha).toBe("stale-pointer");
    expect(mockDb.branchFileChange.count).not.toHaveBeenCalled();
    expect(mockRefreshBranchFileChangeCache).not.toHaveBeenCalled();
    expect(mockResolvePrContext).not.toHaveBeenCalled();
    expect(mockDb.branchFileChange.findMany).toHaveBeenCalledWith({
      where: {
        branchArtifactId: "branch-artifact-1",
        headSha: "stale-pointer",
      },
      orderBy: { path: "asc" },
    });
  });

  it("does not schedule PR lifecycle read-repair for active-sibling render contexts", async () => {
    const mockDb = {
      artifactLink: { findFirst: vi.fn().mockResolvedValue(null) },
      branchFileChange: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      commentThread: { findMany: vi.fn().mockResolvedValue([]) },
      gitHubPRReview: { findMany: vi.fn().mockResolvedValue([]) },
      gitHubUserConnection: { findUnique: vi.fn().mockResolvedValue(null) },
      project: { findFirst: vi.fn().mockResolvedValue(projectRecoveryRow()) },
      pullRequestDetail: {
        findUnique: vi.fn().mockResolvedValue({ reviewDecision: null }),
      },
      user: { findMany: vi.fn().mockResolvedValue([]) },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));
    const ctx = currentPrContext();
    ctx.credentialSource = BranchViewContextCredentialSource.ActiveSibling;
    ctx.credentialRepositoryId = "active-repo-1";
    ctx.gitHubPullRequest!.lastVerifiedAt = null;
    ctx.gitHubPullRequest!.lastRefreshAttemptAt = null;

    const result = await getBranchViewData(ctx, {
      id: "user-1",
      githubUsername: "octocat",
    } as never);

    const data = expectOk(result);
    expect(data?.prLifecycleRepair).toEqual({
      status: BranchViewPrLifecycleRepairStatus.Idle,
    });
    expect(mockSchedulePrReadRepair).not.toHaveBeenCalled();
  });

  it.each([
    [
      "refresh failure",
      () => {
        mockRefreshBranchFileChangeCache.mockRejectedValue(
          new Error("GitHub timed out")
        );
      },
    ],
    [
      "context reload failure",
      () => {
        mockRefreshBranchFileChangeCache.mockResolvedValue({ ok: true });
        mockResolvePrContext.mockRejectedValue(new Error("resolve failed"));
      },
    ],
  ])("keeps serving original branch data when orphaned file-cache healing hits a %s", async (_caseName, arrangeFailure) => {
    arrangeFailure();
    const mockDb = {
      artifactLink: { findFirst: vi.fn().mockResolvedValue(null) },
      project: { findFirst: vi.fn().mockResolvedValue(projectRecoveryRow()) },
      branchFileChange: {
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([]),
      },
      commentThread: { findMany: vi.fn().mockResolvedValue([]) },
      gitHubPRReview: { findMany: vi.fn().mockResolvedValue([]) },
      gitHubUserConnection: { findUnique: vi.fn().mockResolvedValue(null) },
      pullRequestDetail: {
        findUnique: vi.fn().mockResolvedValue({ reviewDecision: null }),
      },
      user: { findMany: vi.fn().mockResolvedValue([]) },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));

    const result = await getBranchViewData(
      {
        externalLink: {
          id: "branch-artifact-1",
          title: "feature/branch-artifact",
          externalUrl:
            "https://github.com/acme/repo/tree/feature%2Fbranch-artifact",
          status: "OPEN",
          metadata: null,
          projectId: "project-1",
          organizationId: "org-1",
          createdBy: null,
        },
        prMetadata: null,
        gitHubPullRequest: currentPullRequestDetail(),
        repositoryId: "repo-1",
        installationId: "123",
        owner: "acme",
        repo: "repo",
        pullNumber: 42,
        branch: {
          artifactId: "branch-artifact-1",
          repositoryId: "repo-1",
          branchName: "feature/branch-artifact",
          baseBranch: "main",
          baseBranchSource: "repository_default",
          headSha: "new-head",
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
          fileCacheHeadSha: "stale-pointer",
          fileCacheFileCount: 1,
          fileCachePatchBytes: 8,
          fileCacheUpdatedAt: new Date("2026-05-15T00:00:00Z"),
          syncStatus: "fresh",
          lastSyncStartedAt: new Date("2026-05-15T00:00:00Z"),
          lastSyncCompletedAt: new Date("2026-05-15T00:01:00Z"),
          lastSyncErrorCode: null,
          lastSyncErrorMessage: null,
        },
      } as never,
      { id: "user-1", githubUsername: "octocat" } as never
    );

    const data = expectOk(result);
    expect(data?.branch?.fileCacheHeadSha).toBe("stale-pointer");
    expect(mockDb.branchFileChange.findMany).toHaveBeenCalledWith({
      where: {
        branchArtifactId: "branch-artifact-1",
        headSha: "stale-pointer",
      },
      orderBy: { path: "asc" },
    });
  });

  it("does not refresh when the pointer still has rows (stale but consistent)", async () => {
    const mockDb = {
      artifactLink: { findFirst: vi.fn().mockResolvedValue(null) },
      project: { findFirst: vi.fn().mockResolvedValue(projectRecoveryRow()) },
      branchFileChange: {
        count: vi.fn().mockResolvedValue(2),
        findMany: vi.fn().mockResolvedValue([]),
      },
      commentThread: { findMany: vi.fn().mockResolvedValue([]) },
      gitHubPRReview: { findMany: vi.fn().mockResolvedValue([]) },
      gitHubUserConnection: { findUnique: vi.fn().mockResolvedValue(null) },
      pullRequestDetail: {
        findUnique: vi.fn().mockResolvedValue({ reviewDecision: null }),
      },
      user: { findMany: vi.fn().mockResolvedValue([]) },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));

    await getBranchViewData(
      {
        externalLink: {
          id: "branch-artifact-1",
          title: "feature/branch-artifact",
          externalUrl: "https://github.com/acme/repo",
          status: "OPEN",
          metadata: null,
          projectId: "project-1",
          organizationId: "org-1",
          createdBy: null,
        },
        prMetadata: null,
        gitHubPullRequest: currentPullRequestDetail(),
        repositoryId: "repo-1",
        installationId: "123",
        owner: "acme",
        repo: "repo",
        pullNumber: 42,
        branch: {
          artifactId: "branch-artifact-1",
          repositoryId: "repo-1",
          branchName: "feature/branch-artifact",
          baseBranch: "main",
          baseBranchSource: "repository_default",
          headSha: "new-head",
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
          fileCacheHeadSha: "stale-but-cached",
          fileCacheFileCount: 2,
          fileCachePatchBytes: 8,
          fileCacheUpdatedAt: new Date("2026-05-15T00:00:00Z"),
          syncStatus: "fresh",
          lastSyncStartedAt: new Date("2026-05-15T00:00:00Z"),
          lastSyncCompletedAt: new Date("2026-05-15T00:01:00Z"),
          lastSyncErrorCode: null,
          lastSyncErrorMessage: null,
        },
      } as never,
      { id: "user-1", githubUsername: "octocat" } as never
    );

    expect(mockRefreshBranchFileChangeCache).not.toHaveBeenCalled();
    expect(mockResolvePrContext).not.toHaveBeenCalled();
  });

  it("reads branch page-load data from DB without live GitHub calls", async () => {
    const mockDb = {
      artifactLink: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      project: { findFirst: vi.fn().mockResolvedValue(projectRecoveryRow()) },
      branchFileChange: {
        findMany: vi.fn().mockResolvedValue([
          {
            path: "src/changed.ts",
            previousPath: null,
            status: "modified",
            additions: 4,
            deletions: 1,
            patch: "@@ patch",
          },
        ]),
      },
      commentThread: { findMany: vi.fn().mockResolvedValue([]) },
      gitHubPRReview: { findMany: vi.fn().mockResolvedValue([]) },
      gitHubUserConnection: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      pullRequestDetail: {
        findUnique: vi.fn().mockResolvedValue({ reviewDecision: null }),
      },
      user: { findMany: vi.fn().mockResolvedValue([]) },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));

    const result = await getBranchViewData(
      {
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
          headSha: "head-sha",
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
          fileCacheFileCount: 1,
          fileCachePatchBytes: 8,
          fileCacheUpdatedAt: new Date("2026-05-15T00:00:00Z"),
          syncStatus: "fresh",
          lastSyncStartedAt: new Date("2026-05-15T00:00:00Z"),
          lastSyncCompletedAt: new Date("2026-05-15T00:01:00Z"),
          lastSyncErrorCode: null,
          lastSyncErrorMessage: null,
        },
        gitHubPullRequest: currentPullRequestDetail(),
        repositoryId: "repo-1",
        installationId: "123",
        owner: "acme",
        repo: "repo",
        pullNumber: 42,
      },
      {
        id: "user-1",
        githubUsername: "octocat",
      } as never
    );

    const data = expectOk(result);
    expect(data).toMatchObject({
      currentPullRequest: {
        id: "pr-detail-1",
        number: 42,
      },
      prNumber: 42,
      repoFullName: "acme/repo",
    });
    expect(mockListPullRequestIssueComments).not.toHaveBeenCalled();
    expect(mockListPullRequestReviewComments).not.toHaveBeenCalled();
    expect(mockListPullRequestReviews).not.toHaveBeenCalled();
    expect(mockDb.branchFileChange.findMany).toHaveBeenCalledWith({
      where: {
        branchArtifactId: "branch-artifact-1",
        headSha: "head-sha",
      },
      orderBy: { path: "asc" },
    });
  });

  it("returns unavailable before comment, review, or file-list work when current PR context is missing", async () => {
    const mockDb = {
      artifactLink: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      branchFileChange: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      gitHubPRReview: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      gitHubUserConnection: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      project: { findFirst: vi.fn().mockResolvedValue(projectRecoveryRow()) },
      pullRequestDetail: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));

    const result = await getBranchViewData(
      {
        externalLink: {
          id: "branch-artifact-1",
          title: "feature/branch-artifact",
          externalUrl:
            "https://github.com/acme/repo/tree/feature%2Fbranch-artifact",
          status: "OPEN",
          metadata: null,
          projectId: "project-1",
          organizationId: "org-1",
          createdBy: null,
        },
        prMetadata: null,
        branch: {
          artifactId: "branch-artifact-1",
          repositoryId: "repo-1",
          branchName: "feature/branch-artifact",
          baseBranch: "main",
          baseBranchSource: "repository_default",
          headSha: "head-sha",
          headShaSource: "push_webhook",
          headShaObservedAt: null,
          lastPushBeforeSha: null,
          currentPullRequestDetailId: null,
          checksStatus: "UNKNOWN",
          checksDetailHeadSha: null,
          checksDetailTotalCount: 0,
          checksDetailTruncated: false,
          checksDetailProviderState: null,
          checksDetailUnavailableReason: null,
          checksDetailUpdatedAt: null,
          statusChecks: [],
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
        },
        gitHubPullRequest: null,
        repositoryId: "repo-1",
        installationId: "123",
        owner: "acme",
        repo: "repo",
        pullNumber: null,
      },
      {
        id: "user-1",
        githubUsername: "octocat",
      } as never
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: BranchViewLoadErrorCode.PullRequestUnavailable,
        message: "Branch view pull request is unavailable",
      });
      expect(result.error.details).toMatchObject({
        projectId: "project-1",
        projectName: "Platform",
      });
    }
    expect(mockDb.gitHubPRReview.findMany).not.toHaveBeenCalled();
    expect(mockDb.pullRequestDetail.findUnique).not.toHaveBeenCalled();
    expect(mockDb.branchFileChange.findMany).not.toHaveBeenCalled();
  });

  it("returns a typed unavailable failure before repair paths for an invalid current PR relation", async () => {
    const mockDb = {
      artifactLink: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      project: { findFirst: vi.fn().mockResolvedValue(projectRecoveryRow()) },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));
    const ctx = currentPrContext();
    ctx.branch!.invalidCurrentPullRequestRelation = true;
    ctx.gitHubPullRequest = null;
    ctx.pullNumber = null;

    const result = await getBranchViewData(ctx, {
      id: "user-1",
      organizationId: "org-1",
      githubUsername: "octocat",
    } as never);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: BranchViewLoadErrorCode.PullRequestUnavailable,
        message: "Branch view pull request is unavailable",
      });
    }
    expect(mockRefreshBranchFileChangeCache).not.toHaveBeenCalled();
    expect(mockSchedulePrReadRepair).not.toHaveBeenCalled();
    expect(mockStartBranchSync).not.toHaveBeenCalled();
  });

  it("omits project details when the recovery project is not org-owned", async () => {
    const mockDb = {
      artifactLink: { findFirst: vi.fn().mockResolvedValue(null) },
      project: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));
    const ctx = currentPrContext();
    ctx.gitHubPullRequest = null;

    const result = await getBranchViewData(ctx, {
      id: "user-1",
      organizationId: "org-1",
      githubUsername: "octocat",
    } as never);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.details?.projectId).toBeUndefined();
      expect(result.error.details?.projectName).toBeUndefined();
    }
    expect(mockDb.project.findFirst).toHaveBeenCalledWith({
      where: { id: "project-1", organizationId: "org-1" },
      select: expect.any(Object),
    });
  });

  it("classifies org-owned branch artifacts with missing branch relations as unavailable", async () => {
    const mockDb = {
      artifact: {
        findFirst: vi.fn().mockResolvedValue({
          id: "branch-artifact-1",
          organizationId: "org-1",
          projectId: "project-1",
          name: "feature/branch-artifact",
          status: "OPEN",
          externalUrl: null,
          createdBy: null,
          branch: null,
        }),
      },
      artifactLink: { findFirst: vi.fn().mockResolvedValue(null) },
      project: { findFirst: vi.fn().mockResolvedValue(projectRecoveryRow()) },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));

    const failure = await resolveBranchViewMissingContextFailure(
      "branch-artifact-1",
      "org-1"
    );

    expect(failure).toMatchObject({
      code: BranchViewLoadErrorCode.PullRequestUnavailable,
      message: "Branch view pull request is unavailable",
      details: {
        projectId: "project-1",
        projectName: "Platform",
      },
    });
  });

  it.each([
    [
      "missing GitHub pull request",
      (ctx: PrContext) => {
        ctx.gitHubPullRequest = null;
      },
    ],
    [
      "missing pull number",
      (ctx: PrContext) => {
        ctx.pullNumber = null;
      },
    ],
    [
      "missing current pull request detail id",
      (ctx: PrContext) => {
        ctx.branch!.currentPullRequestDetailId = null;
      },
    ],
  ])("returns unavailable before repair paths for %s", async (_name, mutate) => {
    const mockDb = {
      artifactLink: { findFirst: vi.fn().mockResolvedValue(null) },
      project: { findFirst: vi.fn().mockResolvedValue(projectRecoveryRow()) },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));
    const ctx = currentPrContext();
    mutate(ctx);

    const result = await getBranchViewData(ctx, {
      id: "user-1",
      organizationId: "org-1",
      githubUsername: "octocat",
    } as never);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: BranchViewLoadErrorCode.PullRequestUnavailable,
        message: "Branch view pull request is unavailable",
      });
    }
    expect(mockRefreshBranchFileChangeCache).not.toHaveBeenCalled();
    expect(mockSchedulePrReadRepair).not.toHaveBeenCalled();
    expect(mockStartBranchSync).not.toHaveBeenCalled();
  });

  it.each<
    [
      string,
      (
        | { authMethod: "session" }
        | {
            authMethod: "api_key";
            apiKeyScopes: ApiKeyScope[];
          }
      ),
      boolean,
    ]
  >([
    ["session auth", { authMethod: "session" as const }, true],
    [
      "write API key",
      { authMethod: "api_key" as const, apiKeyScopes: ["write"] },
      true,
    ],
    [
      "read-only API key",
      { authMethod: "api_key" as const, apiKeyScopes: ["read"] },
      false,
    ],
    [
      "missing-scope API key",
      { authMethod: "api_key" as const, apiKeyScopes: [] },
      false,
    ],
  ])("derives create-comment capabilities for %s", async (_label, auth, expectedCapability) => {
    const mockDb = {
      artifactLink: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      branchFileChange: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      commentThread: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      gitHubPRReview: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      gitHubUserConnection: {
        findUnique: vi.fn().mockResolvedValue({
          githubUserId: "github-user-1",
          login: "octocat",
          revokedAt: null,
          tokenExpiresAt: new Date("2099-12-31T00:00:00.000Z"),
        }),
      },
      project: { findFirst: vi.fn().mockResolvedValue(projectRecoveryRow()) },
      pullRequestDetail: {
        findUnique: vi.fn().mockResolvedValue({ reviewDecision: null }),
      },
      user: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));

    const result = await getBranchViewData(
      currentPrContext(),
      {
        id: "user-1",
        organizationId: "org-1",
        githubUsername: "octocat",
      } as never,
      {
        organizationId: "org-1",
        ...auth,
      }
    );

    const data = expectOk(result);
    expect(data?.canCreateConversationComment).toBe(expectedCapability);
    expect(data?.canCreateInlineComment).toBe(expectedCapability);
  });

  it("keeps active-sibling render recovery contexts read-only for branch-view comments", async () => {
    const mockDb = {
      artifactLink: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      branchFileChange: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      commentThread: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "thread-review",
            source: "GITHUB",
            status: "OPEN",
            createdAt: new Date("2026-05-21T10:00:00Z"),
            githubProjection: {
              threadKind: GitHubCommentThreadKind.ReviewThread,
              reviewId: "review-1",
              htmlUrl: "https://github.com/acme/repo/pull/42#discussion_r101",
              path: "src/file.ts",
              line: 12,
              commitSha: "review-anchor-sha",
              side: GitHubDiffSide.Left,
              startLine: 10,
              startSide: GitHubDiffSide.Left,
              resolvable: true,
              legacyState: "PENDING",
            },
            comments: [
              {
                id: "comment-review",
                authorId: "user-1",
                body: {
                  type: "github_markdown",
                  markdown: "Inline review note",
                },
                plainText: "Inline review note",
                createdAt: new Date("2026-05-21T10:00:00Z"),
                githubProjection: {
                  githubCommentId: "review-101",
                  githubInReplyToCommentId: null,
                  githubHtmlUrl:
                    "https://github.com/acme/repo/pull/42#discussion_r101",
                  externalAuthor: {
                    providerUserId: "github-user-1",
                    providerLogin: "octocat",
                    avatarUrl: null,
                    profileUrl: "https://github.com/octocat",
                  },
                },
              },
            ],
          },
        ]),
      },
      gitHubPRReview: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      gitHubUserConnection: {
        findUnique: vi.fn().mockResolvedValue({
          githubUserId: "github-user-1",
          login: "octocat",
          revokedAt: null,
          tokenExpiresAt: new Date("2099-12-31T00:00:00.000Z"),
        }),
      },
      project: { findFirst: vi.fn().mockResolvedValue(projectRecoveryRow()) },
      pullRequestDetail: {
        findUnique: vi.fn().mockResolvedValue({ reviewDecision: null }),
      },
      user: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));

    const result = await getBranchViewData(
      {
        ...currentPrContext(),
        credentialRepositoryId: "repo-active-sibling",
        credentialSource: BranchViewContextCredentialSource.ActiveSibling,
      },
      {
        id: "user-1",
        organizationId: "org-1",
        githubUsername: "octocat",
      } as never,
      {
        authMethod: "session",
        organizationId: "org-1",
      }
    );

    const data = expectOk(result);
    expect(data.canCreateConversationComment).toBe(false);
    expect(data.canCreateInlineComment).toBe(false);
    expect(data.commentPromptEligibility).toEqual({
      createConversation: { prompt: false },
      createInline: { prompt: false },
    });
    expect(data.comments).toEqual([
      expect.objectContaining({
        id: "review-101",
        kind: CommentKind.ReviewComment,
        canReply: false,
        canEdit: false,
        canDelete: false,
        canResolve: false,
        canUnresolve: false,
      }),
    ]);
  });

  it("returns pending lifecycle repair status and schedules read repair for an unverified current PR", async () => {
    const mockDb = {
      artifactLink: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      branchFileChange: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      commentThread: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      gitHubPRReview: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      gitHubUserConnection: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      project: { findFirst: vi.fn().mockResolvedValue(projectRecoveryRow()) },
      pullRequestDetail: {
        findUnique: vi.fn().mockResolvedValue({ reviewDecision: null }),
      },
      user: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));

    const result = await getBranchViewData(currentPrContext(), {
      id: "user-1",
      organizationId: "org-1",
      githubUsername: "octocat",
    } as never);

    const data = expectOk(result);
    expect(data?.prLifecycleRepair).toEqual({
      status: BranchViewPrLifecycleRepairStatus.Pending,
    });
    expect(mockSchedulePrReadRepair).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          id: "branch-artifact-1",
          externalUrl: "https://github.com/acme/repo/pull/42",
          organizationId: "org-1",
          projectId: "project-1",
          prState: "OPEN",
          lastVerifiedAt: null,
          lastRefreshAttemptAt: null,
        }),
      ],
      "org-1",
      expect.any(Number)
    );
  });

  it("returns idle lifecycle repair status without scheduling when the current PR was recently verified", async () => {
    const mockDb = {
      artifactLink: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      branchFileChange: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      commentThread: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      gitHubPRReview: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      gitHubUserConnection: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      project: { findFirst: vi.fn().mockResolvedValue(projectRecoveryRow()) },
      pullRequestDetail: {
        findUnique: vi.fn().mockResolvedValue({ reviewDecision: null }),
      },
      user: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));
    const ctx = currentPrContext();
    if (!ctx.gitHubPullRequest) {
      throw new Error("Expected current PR context");
    }
    ctx.gitHubPullRequest.lastVerifiedAt = new Date();

    const result = await getBranchViewData(ctx, {
      id: "user-1",
      organizationId: "org-1",
      githubUsername: "octocat",
    } as never);

    const data = expectOk(result);
    expect(data?.prLifecycleRepair).toEqual({
      status: BranchViewPrLifecycleRepairStatus.Idle,
    });
    expect(mockSchedulePrReadRepair).not.toHaveBeenCalled();
  });

  it("keeps lifecycle repair pending without rescheduling during a recent repair attempt", async () => {
    const mockDb = {
      artifactLink: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      branchFileChange: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      commentThread: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      gitHubPRReview: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      gitHubUserConnection: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      project: { findFirst: vi.fn().mockResolvedValue(projectRecoveryRow()) },
      pullRequestDetail: {
        findUnique: vi.fn().mockResolvedValue({ reviewDecision: null }),
      },
      user: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));
    const ctx = currentPrContext();
    if (!ctx.gitHubPullRequest) {
      throw new Error("Expected current PR context");
    }
    ctx.gitHubPullRequest.lastRefreshAttemptAt = new Date();

    const result = await getBranchViewData(ctx, {
      id: "user-1",
      organizationId: "org-1",
      githubUsername: "octocat",
    } as never);

    const data = expectOk(result);
    expect(data?.prLifecycleRepair).toEqual({
      status: BranchViewPrLifecycleRepairStatus.Pending,
    });
    expect(mockSchedulePrReadRepair).not.toHaveBeenCalled();
  });

  it("projects the approved flat syncState shape from persisted successful fields", async () => {
    mockWithDb.mockImplementation((callback) => callback(branchViewDb()));
    const ctx = currentPrContext();
    ctx.branch!.lastSyncStartedAt = new Date("2099-05-27T16:59:00.000Z");
    ctx.branch!.lastSyncCompletedAt = new Date("2099-05-27T17:00:00.000Z");
    ctx.gitHubPullRequest!.lastRefreshAttemptAt = new Date(
      "2099-05-27T16:58:00.000Z"
    );
    ctx.gitHubPullRequest!.lastVerifiedAt = new Date(
      "2099-05-27T17:00:00.000Z"
    );

    const result = await getBranchViewData(ctx, {
      id: "user-1",
      organizationId: "org-1",
      githubUsername: "octocat",
    } as never);

    const data = expectOk(result);
    expect(data?.syncState).toEqual({
      backgroundRefreshAfterAt: "2099-05-27T17:05:00.000Z",
      branchLastAttemptedAt: "2099-05-27T16:59:00.000Z",
      branchLastSyncedAt: "2099-05-27T17:00:00.000Z",
      inProgress: false,
      lastOutcome: {
        code: null,
        httpStatus: null,
        message: null,
        retryAfterSeconds: null,
        source: null,
        synced: true,
      },
      lifecycleLastAttemptedAt: "2099-05-27T16:58:00.000Z",
      lifecycleLastSyncedAt: "2099-05-27T17:00:00.000Z",
      presentation: BranchViewSyncPresentationState.Fresh,
    });
  });

  it("schedules immediate background refresh for syncable unknown state with no previous attempts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T17:00:00.000Z"));
    mockWithDb.mockImplementation((callback) => callback(branchViewDb()));
    const ctx = currentPrContext();
    ctx.branch!.fileCacheUpdatedAt = null;
    ctx.gitHubPullRequest!.lastVerifiedAt = new Date(
      "2099-05-27T17:00:00.000Z"
    );

    const result = await getBranchViewData(ctx, {
      id: "user-1",
      organizationId: "org-1",
      githubUsername: "octocat",
    } as never);

    const data = expectOk(result);
    expect(data?.syncState).toMatchObject({
      backgroundRefreshAfterAt: "2099-05-27T17:05:00.000Z",
      branchLastAttemptedAt: null,
      branchLastSyncedAt: null,
      lifecycleLastAttemptedAt: null,
      lifecycleLastSyncedAt: "2099-05-27T17:00:00.000Z",
      presentation: BranchViewSyncPresentationState.Fresh,
    });
  });

  it("defers failed-state background refresh until the retry throttle expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T17:00:00.000Z"));
    mockWithDb.mockImplementation((callback) => callback(branchViewDb()));
    const ctx = currentPrContext();
    ctx.branch!.fileCacheStatus = BranchFileCacheStatus.Failed;
    ctx.branch!.fileCacheUpdatedAt = null;
    ctx.branch!.lastSyncStartedAt = new Date("2026-05-27T16:59:30.000Z");
    ctx.branch!.lastSyncErrorCode =
      BranchViewFileCacheSyncErrorCode.CompareFailed;
    ctx.gitHubPullRequest!.lastVerifiedAt = new Date(
      "2099-05-27T17:00:00.000Z"
    );

    const result = await getBranchViewData(ctx, {
      id: "user-1",
      organizationId: "org-1",
      githubUsername: "octocat",
    } as never);

    const data = expectOk(result);
    expect(data?.syncState).toMatchObject({
      backgroundRefreshAfterAt: "2099-05-27T17:05:00.000Z",
      branchLastAttemptedAt: "2026-05-27T16:59:30.000Z",
      branchLastSyncedAt: null,
      presentation: BranchViewSyncPresentationState.Failed,
    });
  });

  it("defers showing-last-known background refresh until a recent attempt clears throttle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T17:00:00.000Z"));
    mockWithDb.mockImplementation((callback) => callback(branchViewDb()));
    const ctx = currentPrContext();
    ctx.branch!.lastSyncStartedAt = new Date("2026-05-27T16:59:30.000Z");
    ctx.branch!.lastSyncCompletedAt = new Date("2026-05-27T15:00:00.000Z");
    ctx.branch!.lastSyncErrorCode =
      BranchViewSyncErrorCode.PrLifecycleUnavailable;
    ctx.gitHubPullRequest!.state = "MERGED";
    ctx.gitHubPullRequest!.lastVerifiedAt = new Date(
      "2026-05-27T15:00:00.000Z"
    );

    const result = await getBranchViewData(ctx, {
      id: "user-1",
      organizationId: "org-1",
      githubUsername: "octocat",
    } as never);

    const data = expectOk(result);
    expect(data?.syncState).toMatchObject({
      backgroundRefreshAfterAt: "2026-05-27T17:00:30.000Z",
      branchLastAttemptedAt: "2026-05-27T16:59:30.000Z",
      lifecycleLastSyncedAt: "2026-05-27T15:00:00.000Z",
      presentation: BranchViewSyncPresentationState.ShowingLastKnown,
    });
  });

  it("suppresses background refresh while PR read-repair is pending", async () => {
    mockWithDb.mockImplementation((callback) => callback(branchViewDb()));
    const ctx = currentPrContext();
    ctx.branch!.lastSyncCompletedAt = new Date("2026-05-27T17:00:00.000Z");

    const result = await getBranchViewData(ctx, {
      id: "user-1",
      organizationId: "org-1",
      githubUsername: "octocat",
    } as never);

    const data = expectOk(result);
    expect(data?.syncState).toMatchObject({
      backgroundRefreshAfterAt: null,
      inProgress: true,
      presentation: BranchViewSyncPresentationState.Refreshing,
    });
  });

  it("suppresses background refresh while branch sync is active", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T17:00:30.000Z"));
    mockWithDb.mockImplementation((callback) => callback(branchViewDb()));
    const ctx = currentPrContext();
    ctx.branch!.syncStatus = BranchSyncStatus.Syncing;
    ctx.branch!.lastSyncStartedAt = new Date("2026-05-27T17:00:00.000Z");
    ctx.branch!.lastSyncCompletedAt = new Date("2026-05-27T16:55:00.000Z");
    ctx.gitHubPullRequest!.lastVerifiedAt = new Date(
      "2099-05-27T17:00:00.000Z"
    );

    const result = await getBranchViewData(ctx, {
      id: "user-1",
      organizationId: "org-1",
      githubUsername: "octocat",
    } as never);

    const data = expectOk(result);
    expect(data?.syncState).toMatchObject({
      backgroundRefreshAfterAt: null,
      inProgress: true,
      presentation: BranchViewSyncPresentationState.Refreshing,
    });
  });

  it("keeps scheduled file-cache branches eligible for explicit background refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T17:00:00.000Z"));
    mockWithDb.mockImplementation((callback) => callback(branchViewDb()));
    const ctx = currentPrContext();
    ctx.branch!.fileCacheStatus = BranchFileCacheStatus.Scheduled;
    ctx.branch!.fileCacheUpdatedAt = null;
    ctx.gitHubPullRequest!.lastVerifiedAt = new Date(
      "2099-05-27T17:00:00.000Z"
    );

    const result = await getBranchViewData(ctx, {
      id: "user-1",
      organizationId: "org-1",
      githubUsername: "octocat",
    } as never);

    const data = expectOk(result);
    expect(data?.syncState).toMatchObject({
      backgroundRefreshAfterAt: "2099-05-27T17:05:00.000Z",
      branchLastAttemptedAt: null,
      branchLastSyncedAt: null,
      inProgress: false,
      presentation: BranchViewSyncPresentationState.Fresh,
    });
  });

  it("preserves raw file-cache compare codes with safe labels and last-known timestamps", async () => {
    mockWithDb.mockImplementation((callback) => callback(branchViewDb()));
    const ctx = currentPrContext();
    ctx.branch!.fileCacheStatus = BranchFileCacheStatus.Failed;
    ctx.branch!.fileCacheUpdatedAt = new Date("2026-05-27T16:45:00.000Z");
    ctx.branch!.lastSyncStartedAt = new Date("2026-05-27T16:59:00.000Z");
    ctx.branch!.lastSyncCompletedAt = new Date("2026-05-27T17:00:00.000Z");
    ctx.branch!.lastSyncErrorCode =
      BranchViewFileCacheSyncErrorCode.CompareFailed;
    ctx.branch!.lastSyncErrorMessage = "token ghp_secret leaked by provider";
    ctx.gitHubPullRequest!.lastVerifiedAt = new Date(
      "2099-05-27T17:00:00.000Z"
    );

    const result = await getBranchViewData(ctx, {
      id: "user-1",
      organizationId: "org-1",
      githubUsername: "octocat",
    } as never);

    const data = expectOk(result);
    expect(data?.syncState).toMatchObject({
      branchLastSyncedAt: "2026-05-27T16:45:00.000Z",
      lastOutcome: {
        code: BranchViewFileCacheSyncErrorCode.CompareFailed,
        httpStatus: 500,
        message: "Could not refresh file changes from GitHub.",
        retryAfterSeconds: null,
        source: BranchViewSyncOutcomeSource.FileCache,
        synced: false,
      },
      lifecycleLastSyncedAt: "2099-05-27T17:00:00.000Z",
      presentation: BranchViewSyncPresentationState.Failed,
    });
    expect(JSON.stringify(data?.syncState)).not.toContain("ghp_secret");
  });

  it("maps missing compare refs to a file-cache outcome with HTTP 400", async () => {
    mockWithDb.mockImplementation((callback) => callback(branchViewDb()));
    const ctx = currentPrContext();
    ctx.branch!.fileCacheStatus = BranchFileCacheStatus.Failed;
    ctx.branch!.lastSyncStartedAt = new Date("2026-05-27T16:59:00.000Z");
    ctx.branch!.lastSyncCompletedAt = new Date("2026-05-27T17:00:00.000Z");
    ctx.branch!.lastSyncErrorCode =
      BranchViewFileCacheSyncErrorCode.MissingCompareRefs;
    ctx.gitHubPullRequest!.lastVerifiedAt = new Date(
      "2099-05-27T17:00:00.000Z"
    );

    const result = await getBranchViewData(ctx, {
      id: "user-1",
      organizationId: "org-1",
      githubUsername: "octocat",
    } as never);

    const data = expectOk(result);
    expect(data?.syncState?.lastOutcome).toMatchObject({
      code: BranchViewFileCacheSyncErrorCode.MissingCompareRefs,
      httpStatus: 400,
      message: "File comparison is unavailable for this branch.",
      source: BranchViewSyncOutcomeSource.FileCache,
      synced: false,
    });
  });

  it("uses a safe fallback for unknown persisted sync errors", async () => {
    mockWithDb.mockImplementation((callback) => callback(branchViewDb()));
    const ctx = currentPrContext();
    ctx.branch!.lastSyncStartedAt = new Date("2026-05-27T16:59:00.000Z");
    ctx.branch!.lastSyncCompletedAt = new Date("2026-05-27T17:00:00.000Z");
    ctx.branch!.lastSyncErrorCode = "provider_token_secret";
    ctx.branch!.lastSyncErrorMessage = "raw token ghp_secret leaked";
    ctx.gitHubPullRequest!.lastVerifiedAt = new Date(
      "2099-05-27T17:00:00.000Z"
    );

    const result = await getBranchViewData(ctx, {
      id: "user-1",
      organizationId: "org-1",
      githubUsername: "octocat",
    } as never);

    const data = expectOk(result);
    expect(data?.syncState?.lastOutcome).toMatchObject({
      code: "provider_token_secret",
      httpStatus: null,
      message: "Sync did not complete. Showing last-known data.",
      source: BranchViewSyncOutcomeSource.BranchSync,
      synced: false,
    });
    expect(JSON.stringify(data?.syncState)).not.toContain("ghp_secret");
  });

  it("defaults invalid stored PR state to OPEN in the branch-view response", async () => {
    const mockDb = {
      artifactLink: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      branchFileChange: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      gitHubPRReview: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      gitHubUserConnection: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      project: { findFirst: vi.fn().mockResolvedValue(projectRecoveryRow()) },
      pullRequestDetail: {
        findUnique: vi.fn().mockResolvedValue({ reviewDecision: null }),
      },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));

    const result = await getBranchViewData(
      {
        externalLink: {
          id: "branch-artifact-1",
          title: "feature/branch-artifact",
          externalUrl:
            "https://github.com/acme/repo/tree/feature%2Fbranch-artifact",
          status: "BROKEN",
          metadata: null,
          projectId: "project-1",
          organizationId: "org-1",
          createdBy: null,
        },
        prMetadata: null,
        branch: null,
        gitHubPullRequest: {
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
          state: "BROKEN",
          isDraft: false,
          checksStatus: null,
          reviewDecision: null,
        },
        repositoryId: "repo-1",
        installationId: "123",
        owner: "acme",
        repo: "repo",
        pullNumber: 42,
      },
      {
        id: "user-1",
        githubUsername: "octocat",
      } as never
    );

    const data = expectOk(result);
    expect(data?.prState).toBe("OPEN");
    expect(data?.currentPullRequest?.state).toBe("OPEN");
  });
});

describe("fetchUnifiedBranchViewComments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds edit and delete capabilities to caller-authored issue comments", async () => {
    const mockDb = {
      commentThread: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "thread-1",
            source: "GITHUB",
            status: "OPEN",
            createdAt: new Date("2026-05-21T10:00:00Z"),
            githubProjection: {
              threadKind: "ISSUE_COMMENT",
              reviewId: null,
              htmlUrl: "https://github.com/acme/repo/pull/42#issuecomment-123",
              path: null,
              line: null,
              commitSha: null,
              resolvable: false,
              legacyState: "PENDING",
            },
            comments: [
              {
                id: "comment-1",
                authorId: "user-1",
                body: { type: "github_markdown", markdown: "Looks good" },
                plainText: "Looks good",
                createdAt: new Date("2026-05-21T10:00:00Z"),
                githubProjection: {
                  githubCommentId: "123",
                  githubInReplyToCommentId: null,
                  githubHtmlUrl:
                    "https://github.com/acme/repo/pull/42#issuecomment-123",
                  externalAuthor: {
                    providerUserId: "github-user-1",
                    providerLogin: "octocat",
                    avatarUrl: "https://avatars.githubusercontent.com/u/1",
                    profileUrl: "https://github.com/octocat",
                  },
                },
              },
            ],
          },
        ]),
      },
      user: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));

    const comments = await fetchUnifiedBranchViewComments(
      {
        externalLink: { organizationId: "org-1" },
        branch: {
          artifactId: "branch-artifact-1",
          currentPullRequestDetailId: "pr-detail-1",
        },
      } as never,
      {
        id: "user-1",
        organizationId: "org-1",
      } as never,
      {
        auth: { authMethod: "session", organizationId: "org-1" },
        githubIdentity: {
          status: BranchViewCommentWriteIdentityStatus.Active,
          githubUserId: "github-user-1",
          login: "octocat",
        },
      }
    );

    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      id: "123",
      githubCommentId: "123",
      threadId: "thread-1",
      commentId: "comment-1",
      author: "octocat",
      kind: "issue_comment",
      anchorCommitSha: null,
      canEdit: true,
      canDelete: true,
    });
    const [[findManyArgs]] = mockDb.commentThread.findMany.mock.calls;
    expect(findManyArgs).toMatchObject({
      where: {
        githubProjection: {
          is: {
            branchArtifactId: "branch-artifact-1",
            pullRequestDetailId: "pr-detail-1",
            deletedAt: null,
          },
        },
      },
    });
    expect(findManyArgs.where.githubProjection.is).not.toHaveProperty(
      "threadKind"
    );
  });

  it("returns issue and review rows from the unified current-PR projection", async () => {
    const mockDb = {
      commentThread: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "thread-review",
            source: "GITHUB",
            status: "OPEN",
            createdAt: new Date("2026-05-21T10:00:00Z"),
            githubProjection: {
              threadKind: GitHubCommentThreadKind.ReviewThread,
              reviewId: "review-1",
              htmlUrl: "https://github.com/acme/repo/pull/42#discussion_r101",
              path: "src/file.ts",
              line: 12,
              commitSha: "review-anchor-sha",
              side: GitHubDiffSide.Left,
              startLine: 10,
              startSide: GitHubDiffSide.Left,
              resolvable: true,
              legacyState: "PENDING",
            },
            comments: [
              {
                id: "comment-review",
                authorId: "user-1",
                body: {
                  type: "github_markdown",
                  markdown: "Inline review note",
                },
                plainText: "Inline review note",
                createdAt: new Date("2026-05-21T10:00:00Z"),
                githubProjection: {
                  githubCommentId: "review-101",
                  githubInReplyToCommentId: null,
                  githubHtmlUrl:
                    "https://github.com/acme/repo/pull/42#discussion_r101",
                  externalAuthor: {
                    providerUserId: "github-user-1",
                    providerLogin: "octocat",
                    avatarUrl: null,
                    profileUrl: "https://github.com/octocat",
                  },
                },
              },
            ],
          },
          {
            id: "thread-issue",
            source: "GITHUB",
            status: "OPEN",
            createdAt: new Date("2026-05-21T10:01:00Z"),
            githubProjection: {
              threadKind: GitHubCommentThreadKind.IssueComment,
              reviewId: null,
              htmlUrl: "https://github.com/acme/repo/pull/42#issuecomment-202",
              path: null,
              line: null,
              commitSha: null,
              side: null,
              startLine: null,
              startSide: null,
              resolvable: false,
              legacyState: "PENDING",
            },
            comments: [
              {
                id: "comment-issue",
                authorId: "user-1",
                body: {
                  type: "github_markdown",
                  markdown: "Top-level conversation",
                },
                plainText: "Top-level conversation",
                createdAt: new Date("2026-05-21T10:01:00Z"),
                githubProjection: {
                  githubCommentId: "202",
                  githubInReplyToCommentId: null,
                  githubHtmlUrl:
                    "https://github.com/acme/repo/pull/42#issuecomment-202",
                  externalAuthor: {
                    providerUserId: "github-user-1",
                    providerLogin: "octocat",
                    avatarUrl: null,
                    profileUrl: "https://github.com/octocat",
                  },
                },
              },
            ],
          },
        ]),
      },
      user: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));

    const comments = await fetchUnifiedBranchViewComments(
      {
        externalLink: { organizationId: "org-1" },
        branch: {
          artifactId: "branch-artifact-1",
          currentPullRequestDetailId: "pr-detail-1",
        },
      } as never,
      {
        id: "user-1",
        organizationId: "org-1",
      } as never,
      {
        auth: { authMethod: "session", organizationId: "org-1" },
        githubIdentity: {
          status: BranchViewCommentWriteIdentityStatus.Active,
          githubUserId: "github-user-1",
          login: "octocat",
        },
      }
    );

    expect(comments).toHaveLength(2);
    expect(comments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "review-101",
          kind: CommentKind.ReviewComment,
          path: "src/file.ts",
          line: 12,
          anchorCommitSha: "review-anchor-sha",
          side: GitHubDiffSide.Left,
          startLine: 10,
          startSide: GitHubDiffSide.Left,
          canReply: true,
          canEdit: true,
          canDelete: true,
        }),
        expect.objectContaining({
          id: "202",
          kind: CommentKind.IssueComment,
          path: null,
          line: null,
          anchorCommitSha: null,
        }),
      ])
    );
  });

  it("keeps app-authored issue comments read-only", async () => {
    const mockDb = {
      commentThread: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "thread-1",
            source: "GITHUB",
            status: "OPEN",
            createdAt: new Date("2026-05-21T10:00:00Z"),
            githubProjection: {
              threadKind: "ISSUE_COMMENT",
              reviewId: null,
              htmlUrl: "https://github.com/acme/repo/pull/42#issuecomment-123",
              path: null,
              line: null,
              commitSha: null,
              resolvable: false,
              legacyState: "PENDING",
            },
            comments: [
              {
                id: "comment-1",
                authorId: "bot-user-1",
                body: { type: "github_markdown", markdown: "Bot update" },
                plainText: "Bot update",
                createdAt: new Date("2026-05-21T10:00:00Z"),
                githubProjection: {
                  githubCommentId: "123",
                  githubInReplyToCommentId: null,
                  githubHtmlUrl:
                    "https://github.com/acme/repo/pull/42#issuecomment-123",
                  externalAuthor: {
                    providerUserId: "github-user-1",
                    providerLogin: "closedloop-ai[bot]",
                    avatarUrl: "https://avatars.githubusercontent.com/u/2",
                    profileUrl: "https://github.com/apps/closedloop-ai",
                  },
                },
              },
            ],
          },
        ]),
      },
      user: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));

    const comments = await fetchUnifiedBranchViewComments(
      {
        externalLink: { organizationId: "org-1" },
        branch: {
          artifactId: "branch-artifact-1",
          currentPullRequestDetailId: "pr-detail-1",
        },
      } as never,
      {
        id: "user-1",
        organizationId: "org-1",
      } as never,
      {
        auth: { authMethod: "session", organizationId: "org-1" },
        githubIdentity: {
          status: BranchViewCommentWriteIdentityStatus.Active,
          githubUserId: "github-user-1",
          login: "octocat",
        },
      }
    );

    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      author: "closedloop-ai[bot]",
      authorKind: PrCommentAuthorKind.Bot,
      canEdit: false,
      canDelete: false,
    });
  });

  it("removes edit and delete capabilities from issue comments authored by another GitHub user", async () => {
    const mockDb = unifiedIssueCommentDb({
      providerLogin: "not-octocat",
      providerUserId: "github-user-2",
    });
    mockWithDb.mockImplementation((callback) => callback(mockDb));

    const comments = await fetchUnifiedBranchViewComments(
      {
        externalLink: { organizationId: "org-1" },
        branch: {
          artifactId: "branch-artifact-1",
          currentPullRequestDetailId: "pr-detail-1",
        },
      } as never,
      {
        id: "user-1",
        organizationId: "org-1",
      } as never,
      {
        auth: { authMethod: "session", organizationId: "org-1" },
        githubIdentity: {
          status: BranchViewCommentWriteIdentityStatus.Active,
          githubUserId: "github-user-1",
          login: "octocat",
        },
      }
    );

    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      author: "not-octocat",
      kind: CommentKind.IssueComment,
      canEdit: false,
      canDelete: false,
    });
  });

  it("removes edit and delete capabilities for read-only API key callers", async () => {
    const mockDb = unifiedIssueCommentDb({
      providerLogin: "octocat",
      providerUserId: "github-user-1",
    });
    mockWithDb.mockImplementation((callback) => callback(mockDb));

    const comments = await fetchUnifiedBranchViewComments(
      {
        externalLink: { organizationId: "org-1" },
        branch: {
          artifactId: "branch-artifact-1",
          currentPullRequestDetailId: "pr-detail-1",
        },
      } as never,
      {
        id: "user-1",
        organizationId: "org-1",
      } as never,
      {
        auth: {
          authMethod: "api_key",
          organizationId: "org-1",
          apiKeyScopes: ["read"],
        },
        githubIdentity: {
          status: BranchViewCommentWriteIdentityStatus.Active,
          githubUserId: "github-user-1",
          login: "octocat",
        },
      }
    );

    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      author: "octocat",
      kind: CommentKind.IssueComment,
      canEdit: false,
      canDelete: false,
    });
  });
});

describe("resolveBranchViewSyncPreflightContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolvePrContext.mockReset();
    mockRelinkBranchViewRepositoryCredential.mockReset();
  });

  it("returns pinned-active contexts without relinking", async () => {
    const ctx = {
      ...currentPrContext(),
      credentialSource: BranchViewContextCredentialSource.PinnedActive,
    };
    mockResolvePrContext.mockResolvedValueOnce(ctx);

    const result = await resolveBranchViewSyncPreflightContext(
      "branch-artifact-1",
      "org-1"
    );

    expect(result).toEqual({ status: "ready", ctx });
    expect(mockResolvePrContext).toHaveBeenCalledWith(
      "branch-artifact-1",
      "org-1",
      { credentialMode: BranchViewContextCredentialMode.RenderRead }
    );
    expect(mockRelinkBranchViewRepositoryCredential).not.toHaveBeenCalled();
  });

  it("fails stale active-sibling current PR relations before relink", async () => {
    const ctx = {
      ...currentPrContext(),
      credentialSource: BranchViewContextCredentialSource.ActiveSibling,
      credentialRepositoryId: "active-repo-1",
    };
    ctx.branch!.invalidCurrentPullRequestRelation = true;
    mockResolvePrContext.mockResolvedValueOnce(ctx);

    const result = await resolveBranchViewSyncPreflightContext(
      "branch-artifact-1",
      "org-1"
    );

    expect(result).toEqual({
      status: "failed",
      error: "Branch current pull request relation is stale",
      code: BranchViewSyncErrorCode.CurrentPullRequestStale,
      httpStatus: 409,
      reason: BranchViewSyncFailureReason.StaleCurrentPullRequestRelation,
    });
    expect(mockRelinkBranchViewRepositoryCredential).not.toHaveBeenCalled();
    expect(mockResolvePrContext).toHaveBeenCalledTimes(1);
  });

  it.each([
    RepositoryArtifactRelinkStatus.Partial,
    RepositoryArtifactRelinkStatus.Skipped,
  ])("reloads after %s active-sibling relink outcomes before provider sync", async (status) => {
    const activeSiblingCtx = {
      ...currentPrContext(),
      credentialSource: BranchViewContextCredentialSource.ActiveSibling,
      credentialRepositoryId: "active-repo-1",
    };
    const pinnedCtx = {
      ...currentPrContext(),
      credentialSource: BranchViewContextCredentialSource.PinnedActive,
    };
    mockResolvePrContext
      .mockResolvedValueOnce(activeSiblingCtx)
      .mockResolvedValueOnce(pinnedCtx);
    mockRelinkBranchViewRepositoryCredential.mockResolvedValueOnce(
      repositoryRelinkResult({ status })
    );

    const result = await resolveBranchViewSyncPreflightContext(
      "branch-artifact-1",
      "org-1"
    );

    expect(result).toEqual({ status: "ready", ctx: pinnedCtx });
    expect(mockRelinkBranchViewRepositoryCredential).toHaveBeenCalledWith({
      organizationId: "org-1",
      activeRepositoryId: "active-repo-1",
    });
    expect(mockResolvePrContext).toHaveBeenNthCalledWith(
      2,
      "branch-artifact-1",
      "org-1"
    );
  });

  it("stops before reloading when relink fails before transaction state is known", async () => {
    const activeSiblingCtx = {
      ...currentPrContext(),
      credentialSource: BranchViewContextCredentialSource.ActiveSibling,
      credentialRepositoryId: "active-repo-1",
    };
    mockResolvePrContext.mockResolvedValueOnce(activeSiblingCtx);
    mockRelinkBranchViewRepositoryCredential.mockResolvedValueOnce(
      repositoryRelinkResult({
        status: RepositoryArtifactRelinkStatus.Skipped,
        reasons: [RepositoryArtifactRelinkReason.GuardedWriteFailed],
      })
    );

    const result = await resolveBranchViewSyncPreflightContext(
      "branch-artifact-1",
      "org-1"
    );

    expect(result).toEqual({
      status: "failed",
      error: "Failed to fetch data from GitHub",
      code: BranchViewSyncErrorCode.PrSyncFailed,
      httpStatus: 409,
      reason: BranchViewSyncFailureReason.GitHubPrSyncUnavailable,
    });
    expect(mockResolvePrContext).toHaveBeenCalledTimes(1);
  });

  it("relinks active-sibling contexts and reloads pinned-active before syncing", async () => {
    const activeSiblingCtx = {
      ...currentPrContext(),
      credentialSource: BranchViewContextCredentialSource.ActiveSibling,
      credentialRepositoryId: "active-repo-1",
    };
    const pinnedCtx = {
      ...currentPrContext(),
      credentialSource: BranchViewContextCredentialSource.PinnedActive,
    };
    mockResolvePrContext
      .mockResolvedValueOnce(activeSiblingCtx)
      .mockResolvedValueOnce(pinnedCtx);
    mockRelinkBranchViewRepositoryCredential.mockResolvedValueOnce(
      repositoryRelinkResult({
        status: RepositoryArtifactRelinkStatus.Completed,
        branchRelinkedCount: 1,
      })
    );

    const result = await resolveBranchViewSyncPreflightContext(
      "branch-artifact-1",
      "org-1"
    );

    expect(result).toEqual({ status: "ready", ctx: pinnedCtx });
    expect(mockResolvePrContext).toHaveBeenNthCalledWith(
      1,
      "branch-artifact-1",
      "org-1",
      { credentialMode: BranchViewContextCredentialMode.RenderRead }
    );
    expect(mockResolvePrContext).toHaveBeenNthCalledWith(
      2,
      "branch-artifact-1",
      "org-1"
    );
  });
});

describe("syncBranchViewData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStartBranchSync.mockResolvedValue({
      throttled: false,
      fileCount: 0,
      patchBytes: 0,
    });
    mockRefreshPullRequestLifecycle.mockResolvedValue({
      status: "not_applicable",
    });
    mockQueryStatusCheckRollup.mockResolvedValue({
      ok: false,
      reason: StatusCheckRollupFailureReason.GraphqlError,
    });
    mockWithDb.tx.mockImplementation((callback) =>
      callback(makeStatusCheckTx())
    );
    mockResolveExternalGitHubAuthorInTransaction.mockResolvedValue({
      user: { id: "github-user-1" },
      externalAuthor: { id: "external-author-1" },
    });
    mockSoftDeleteGitHubCommentProjection.mockResolvedValue({
      comments: 0,
      threads: 0,
    });
    mockUpsertGitHubIssueCommentThread.mockResolvedValue({
      threadId: "thread-issue",
      commentIds: ["comment-issue"],
    });
    mockUpsertGitHubReviewCommentThread.mockResolvedValue({
      threadId: "thread-review",
      commentIds: ["comment-review"],
    });
  });

  it("returns branch file-cache failure without syncing PR comments", async () => {
    const mockTx = {
      gitHubPRReview: {
        upsert: vi.fn(),
      },
    };
    mockWithDb.tx.mockImplementation((callback) => callback(mockTx));
    mockRefreshBranchFileChangeCache.mockResolvedValue({
      ok: false,
      error: 500,
    });
    mockListPullRequestReviewComments.mockResolvedValue([]);
    mockListPullRequestIssueComments.mockResolvedValue([]);
    mockListPullRequestReviews.mockResolvedValue([]);

    const result = await syncBranchViewData({
      externalLink: { id: "branch-artifact-1", organizationId: "org-1" },
      branch: { artifactId: "branch-artifact-1" },
      gitHubPullRequest: { id: "pr-detail-1" },
      installationId: "123",
      owner: "closedloop-ai",
      repo: "symphony-alpha",
      pullNumber: 42,
    } as never);

    expect(result).toEqual({
      synced: false,
      error: "Failed to refresh branch file cache",
      code: BranchViewSyncErrorCode.FileCacheRefreshFailed,
      httpStatus: 500,
      details: { reason: BranchViewSyncFailureReason.FileCacheRefreshFailed },
      scope: BranchViewSyncScope.Branch,
    });
    expect(mockRefreshBranchFileChangeCache).toHaveBeenCalledWith(
      "branch-artifact-1",
      { organizationId: "org-1", syncAlreadyStarted: true }
    );
    expect(mockListPullRequestReviewComments).not.toHaveBeenCalled();
    expect(mockListPullRequestIssueComments).not.toHaveBeenCalled();
    expect(mockListPullRequestReviews).not.toHaveBeenCalled();
    expect(mockSoftDeleteGitHubCommentProjection).not.toHaveBeenCalled();
    expect(mockRecomputeAndUpdateAggregate).not.toHaveBeenCalled();
  });

  it("returns throttle before downstream GitHub calls when no current PR exists", async () => {
    mockStartBranchSync.mockResolvedValueOnce({
      throttled: true,
      retryAfterSeconds: 42,
      throttleReason: BranchViewSyncThrottleReason.InFlight,
    });

    const result = await syncBranchViewData({
      externalLink: { id: "branch-artifact-1", organizationId: "org-1" },
      branch: {
        artifactId: "branch-artifact-1",
        headSha: "head-sha",
        fileCacheHeadSha: "head-sha",
        lastSyncStartedAt: new Date(),
      },
      gitHubPullRequest: null,
      installationId: "123",
      owner: "closedloop-ai",
      repo: "symphony-alpha",
      pullNumber: null,
    } as never);

    expect(result).toEqual({
      synced: false,
      error: null,
      retryAfterSeconds: 42,
      throttleReason: BranchViewSyncThrottleReason.InFlight,
      scope: BranchViewSyncScope.Branch,
    });
    expect(mockRefreshPullRequestLifecycle).not.toHaveBeenCalled();
    expect(mockQueryStatusCheckRollup).not.toHaveBeenCalled();
    expect(mockRefreshBranchFileChangeCache).not.toHaveBeenCalled();
    expect(mockListPullRequestReviewComments).not.toHaveBeenCalled();
    expect(mockListPullRequestIssueComments).not.toHaveBeenCalled();
    expect(mockListPullRequestReviews).not.toHaveBeenCalled();
  });

  it("uses the PR head SHA for throttling and returns throttle before comment providers", async () => {
    mockStartBranchSync.mockResolvedValueOnce({
      throttled: true,
      retryAfterSeconds: 42,
      throttleReason: BranchViewSyncThrottleReason.InFlight,
    });

    const result = await syncBranchViewData(currentPrContext(null));

    expect(result).toEqual({
      synced: false,
      error: null,
      retryAfterSeconds: 42,
      throttleReason: BranchViewSyncThrottleReason.InFlight,
      scope: BranchViewSyncScope.Branch,
    });
    expect(mockStartBranchSync).toHaveBeenCalledWith(
      expect.objectContaining({
        branchArtifactId: "branch-artifact-1",
        organizationId: "org-1",
        headSha: "head-sha",
      })
    );
    expect(mockRefreshPullRequestLifecycle).not.toHaveBeenCalled();
    expect(mockQueryStatusCheckRollup).not.toHaveBeenCalled();
    expect(mockRefreshBranchFileChangeCache).not.toHaveBeenCalled();
    expect(mockListPullRequestReviewComments).not.toHaveBeenCalled();
    expect(mockListPullRequestIssueComments).not.toHaveBeenCalled();
    expect(mockListPullRequestReviews).not.toHaveBeenCalled();
  });

  it("returns a file-cache failure status when branch sync has no branch record", async () => {
    const result = await syncBranchViewDataWithRequest({
      externalLink: { id: "branch-artifact-1", organizationId: "org-1" },
      branch: null,
      gitHubPullRequest: null,
      installationId: "123",
      owner: "closedloop-ai",
      repo: "symphony-alpha",
      pullNumber: null,
    } as never);

    expect(result).toEqual({
      synced: false,
      error: "No branch record to sync",
      code: BranchViewSyncErrorCode.FileCacheRefreshFailed,
      httpStatus: 500,
      details: { reason: BranchViewSyncFailureReason.FileCacheRefreshFailed },
      scope: BranchViewSyncScope.Branch,
    });
    expect(mockStartBranchSync).not.toHaveBeenCalled();
    expect(mockRefreshBranchFileChangeCache).not.toHaveBeenCalled();
  });

  it("fails closed before file-cache mutation when current PR relation is stale", async () => {
    const result = await syncBranchViewData({
      externalLink: { id: "branch-artifact-1", organizationId: "org-1" },
      branch: {
        artifactId: "branch-artifact-1",
        currentPullRequestDetailId: "foreign-pr-detail-1",
        invalidCurrentPullRequestRelation: true,
      },
      gitHubPullRequest: null,
      installationId: "123",
      owner: "closedloop-ai",
      repo: "symphony-alpha",
      pullNumber: null,
    } as never);

    expect(result).toEqual({
      synced: false,
      error: "Branch current pull request relation is stale",
      code: BranchViewSyncErrorCode.CurrentPullRequestStale,
      httpStatus: 409,
      details: {
        reason: BranchViewSyncFailureReason.StaleCurrentPullRequestRelation,
      },
      scope: BranchViewSyncScope.Branch,
    });
    expect(mockQueryStatusCheckRollup).not.toHaveBeenCalled();
    expect(mockRefreshBranchFileChangeCache).not.toHaveBeenCalled();
  });

  it("returns comments-scope PR sync failure when the current PR is missing", async () => {
    const result = await syncBranchViewDataWithRequest(
      {
        ...currentPrContext(),
        gitHubPullRequest: null,
        pullNumber: null,
      },
      { scope: BranchViewSyncScope.Comments }
    );

    expect(result).toEqual({
      synced: false,
      error: "No current pull request record to sync into",
      code: BranchViewSyncErrorCode.PrSyncFailed,
      httpStatus: 409,
      details: {
        reason: BranchViewSyncFailureReason.MissingCurrentPullRequest,
      },
      scope: BranchViewSyncScope.Comments,
    });
    expect(mockListPullRequestReviewComments).not.toHaveBeenCalled();
    expect(mockListPullRequestIssueComments).not.toHaveBeenCalled();
    expect(mockListPullRequestReviews).not.toHaveBeenCalled();
  });

  it("returns comments-scope PR sync failure when the current PR relation is stale", async () => {
    const ctx = currentPrContext();
    ctx.branch!.currentPullRequestDetailId = "foreign-pr-detail-1";

    const result = await syncBranchViewDataWithRequest(ctx, {
      scope: BranchViewSyncScope.Comments,
    });

    expect(result).toEqual({
      synced: false,
      error: "Branch current pull request relation is stale",
      code: BranchViewSyncErrorCode.PrSyncFailed,
      httpStatus: 409,
      details: {
        reason: BranchViewSyncFailureReason.StaleCurrentPullRequestRelation,
      },
      scope: BranchViewSyncScope.Comments,
    });
    expect(mockListPullRequestReviewComments).not.toHaveBeenCalled();
    expect(mockListPullRequestIssueComments).not.toHaveBeenCalled();
    expect(mockListPullRequestReviews).not.toHaveBeenCalled();
  });

  it("returns PR sync failure when GitHub comment or review data is unavailable", async () => {
    mockRefreshBranchFileChangeCache.mockResolvedValue({
      ok: true,
      value: { throttled: false, fileCount: 0, patchBytes: 0 },
    });
    mockListPullRequestReviewComments.mockResolvedValue(null);
    mockListPullRequestIssueComments.mockResolvedValue([]);
    mockListPullRequestReviews.mockResolvedValue([]);

    const result = await syncBranchViewDataWithRequest(currentPrContext(), {
      scope: BranchViewSyncScope.Comments,
    });

    expect(result).toEqual({
      synced: false,
      error: "Failed to fetch data from GitHub",
      code: BranchViewSyncErrorCode.PrSyncFailed,
      httpStatus: 502,
      details: { reason: BranchViewSyncFailureReason.GitHubPrSyncUnavailable },
      scope: BranchViewSyncScope.Comments,
    });
    expect(mockWithDb.tx).not.toHaveBeenCalled();
  });

  it("returns comments provider throttle without writing partial projections", async () => {
    mockListPullRequestReviewComments.mockResolvedValue({
      status: GitHubProviderResultStatus.ProviderRateLimit,
      retryAfterSeconds: 12,
    });
    mockListPullRequestIssueComments.mockResolvedValue([]);
    mockListPullRequestReviews.mockResolvedValue({
      status: GitHubProviderResultStatus.ProviderRateLimit,
      retryAfterSeconds: 45,
    });

    const result = await syncBranchViewDataWithRequest(currentPrContext(), {
      scope: BranchViewSyncScope.Comments,
    });

    expect(result).toEqual({
      synced: false,
      error: null,
      retryAfterSeconds: 45,
      throttleReason: BranchViewSyncThrottleReason.ProviderRateLimit,
      scope: BranchViewSyncScope.Comments,
    });
    expect(mockWithDb.tx).not.toHaveBeenCalled();
    expect(mockSoftDeleteGitHubCommentProjection).not.toHaveBeenCalled();
    expect(mockUpsertGitHubIssueCommentThread).not.toHaveBeenCalled();
    expect(mockUpsertGitHubReviewCommentThread).not.toHaveBeenCalled();
  });

  it("uses refreshed PR head SHA for checks before file cache and PR sync", async () => {
    const mockDb = {
      branchDetail: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));
    mockRefreshPullRequestLifecycle.mockResolvedValueOnce({
      status: "refreshed",
      headSha: "provider-head-sha",
      baseBranch: "main",
      state: "CLOSED",
      pullRequestDetailId: "pr-detail-1",
    });
    mockQueryStatusCheckRollup.mockResolvedValue(statusRollup("SUCCESS"));
    mockRefreshBranchFileChangeCache.mockResolvedValue({
      ok: true,
      value: { throttled: false, fileCount: 0, patchBytes: 0 },
    });
    mockWithDb.tx.mockImplementation((callback) =>
      callback(makeStatusCheckTx())
    );
    mockListPullRequestReviewComments.mockResolvedValue([]);
    mockListPullRequestIssueComments.mockResolvedValue([]);
    mockListPullRequestReviews.mockResolvedValue([]);

    const result = await syncBranchViewData(currentPrContext());

    expect(result).toEqual({
      synced: true,
      error: null,
      scope: BranchViewSyncScope.Branch,
    });
    expect(mockRefreshPullRequestLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        branchArtifactId: "branch-artifact-1",
        pullRequestDetailId: "pr-detail-1",
        repositoryId: "repo-1",
      })
    );
    expect(mockQueryStatusCheckRollup).toHaveBeenCalledWith(
      "123",
      "acme",
      "repo",
      "provider-head-sha"
    );
  });

  it("marks lifecycle failure and returns the branch failure when provider is unavailable", async () => {
    mockRefreshPullRequestLifecycle.mockResolvedValueOnce({
      status: GitHubProviderResultStatus.ProviderUnavailable,
      code: BranchViewSyncErrorCode.PrLifecycleUnavailable,
      message: "Failed to refresh pull request lifecycle",
      httpStatus: 502,
      details: { reason: BranchViewSyncFailureReason.GitHubPrUnavailable },
    });
    mockRefreshBranchFileChangeCache.mockResolvedValue({
      ok: true,
      value: { throttled: false, fileCount: 1, patchBytes: 12 },
    });

    const result = await syncBranchViewData(currentPrContext());

    expect(result).toEqual({
      synced: false,
      error: "Failed to refresh pull request lifecycle",
      code: BranchViewSyncErrorCode.PrLifecycleUnavailable,
      httpStatus: 502,
      details: { reason: BranchViewSyncFailureReason.GitHubPrUnavailable },
      scope: BranchViewSyncScope.Branch,
    });
    expect(mockMarkBranchSyncFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        branchArtifactId: "branch-artifact-1",
        organizationId: "org-1",
        code: BranchViewSyncErrorCode.PrLifecycleUnavailable,
        message: "Failed to refresh pull request lifecycle",
      })
    );
    expect(mockQueryStatusCheckRollup).not.toHaveBeenCalled();
    expect(mockListPullRequestReviewComments).not.toHaveBeenCalled();
    expect(mockListPullRequestIssueComments).not.toHaveBeenCalled();
    expect(mockListPullRequestReviews).not.toHaveBeenCalled();
  });

  it("returns and settles provider throttle when file-cache also fails generically", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));
    mockRefreshPullRequestLifecycle.mockResolvedValueOnce({
      status: GitHubProviderResultStatus.ProviderRateLimit,
      retryAfterSeconds: 91,
    });
    mockRefreshBranchFileChangeCache.mockResolvedValue({
      ok: false,
      error: 500,
    });

    const result = await syncBranchViewData(currentPrContext());

    expect(result).toEqual({
      synced: false,
      error: null,
      retryAfterSeconds: 91,
      throttleReason: BranchViewSyncThrottleReason.ProviderRateLimit,
      scope: BranchViewSyncScope.Branch,
    });
    expect(mockMarkBranchSyncProviderRateLimited).toHaveBeenCalledWith({
      organizationId: "org-1",
      branchArtifactId: "branch-artifact-1",
      completedAt: expect.any(Date),
      startedAt: new Date("2026-06-01T12:00:00.000Z"),
    });
    expect(mockMarkBranchSyncFailed).not.toHaveBeenCalled();
    expect(mockListPullRequestReviewComments).not.toHaveBeenCalled();
    expect(mockListPullRequestIssueComments).not.toHaveBeenCalled();
    expect(mockListPullRequestReviews).not.toHaveBeenCalled();
  });

  it("marks lifecycle failure and returns the branch failure when guarded write fails", async () => {
    mockRefreshPullRequestLifecycle.mockResolvedValueOnce({
      status: "guarded_write_failed",
      code: BranchViewSyncErrorCode.PrLifecycleGuardFailed,
      message: "Failed to apply pull request lifecycle refresh",
      httpStatus: 409,
      details: { reason: BranchViewSyncFailureReason.GuardedWriteFailed },
    });
    mockRefreshBranchFileChangeCache.mockResolvedValue({
      ok: true,
      value: { throttled: false, fileCount: 1, patchBytes: 12 },
    });

    const result = await syncBranchViewData(currentPrContext());

    expect(result).toEqual({
      synced: false,
      error: "Failed to apply pull request lifecycle refresh",
      code: BranchViewSyncErrorCode.PrLifecycleGuardFailed,
      httpStatus: 409,
      details: { reason: BranchViewSyncFailureReason.GuardedWriteFailed },
      scope: BranchViewSyncScope.Branch,
    });
    expect(mockMarkBranchSyncFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        branchArtifactId: "branch-artifact-1",
        organizationId: "org-1",
        code: BranchViewSyncErrorCode.PrLifecycleGuardFailed,
        message: "Failed to apply pull request lifecycle refresh",
      })
    );
    expect(mockQueryStatusCheckRollup).not.toHaveBeenCalled();
    expect(mockListPullRequestReviewComments).not.toHaveBeenCalled();
    expect(mockListPullRequestIssueComments).not.toHaveBeenCalled();
    expect(mockListPullRequestReviews).not.toHaveBeenCalled();
  });

  it("refreshes stale branch checksStatus from GitHub rollup before syncing files", async () => {
    const statusTx = makeStatusCheckTx();
    const mockDb = {
      branchDetail: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));
    mockWithDb.tx.mockImplementation((callback) => callback(statusTx));
    mockQueryStatusCheckRollup.mockResolvedValue(statusRollup("SUCCESS"));
    mockRefreshBranchFileChangeCache.mockResolvedValue({
      ok: true,
      value: { throttled: false, fileCount: 0, patchBytes: 0 },
    });

    const result = await syncBranchViewData({
      externalLink: { id: "branch-artifact-1", organizationId: "org-1" },
      branch: {
        artifactId: "branch-artifact-1",
        headSha: "abc123def456abc123def456abc123def456abc1",
        checksStatus: "UNKNOWN",
      },
      gitHubPullRequest: null,
      installationId: "123",
      owner: "closedloop-ai",
      repo: "symphony-alpha",
      pullNumber: null,
    } as never);

    expect(result).toEqual({
      synced: true,
      error: null,
      scope: BranchViewSyncScope.Branch,
    });
    expect(mockQueryStatusCheckRollup).toHaveBeenCalledWith(
      "123",
      "closedloop-ai",
      "symphony-alpha",
      "abc123def456abc123def456abc123def456abc1"
    );
    expect(statusTx.branchDetail.updateMany).toHaveBeenCalledWith({
      data: expect.objectContaining({ checksStatus: "PASSING" }),
      where: {
        artifact: { organizationId: "org-1" },
        artifactId: "branch-artifact-1",
        deletedAt: null,
        headSha: "abc123def456abc123def456abc123def456abc1",
      },
    });
    expect(mockRefreshBranchFileChangeCache).toHaveBeenCalledWith(
      "branch-artifact-1",
      { organizationId: "org-1", syncAlreadyStarted: true }
    );
  });

  it("returns status-check provider throttle and skips status persistence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));
    const statusTx = makeStatusCheckTx();
    const mockDb = {
      branchDetail: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));
    mockWithDb.tx.mockImplementation((callback) => callback(statusTx));
    mockQueryStatusCheckRollup.mockResolvedValue({
      status: GitHubProviderResultStatus.ProviderRateLimit,
      retryAfterSeconds: 22,
    });
    mockRefreshBranchFileChangeCache.mockResolvedValue({
      ok: true,
      value: { throttled: false, fileCount: 0, patchBytes: 0 },
    });

    const result = await syncBranchViewData({
      externalLink: { id: "branch-artifact-1", organizationId: "org-1" },
      branch: {
        artifactId: "branch-artifact-1",
        headSha: "abc123def456abc123def456abc123def456abc1",
        checksStatus: "UNKNOWN",
      },
      gitHubPullRequest: null,
      installationId: "123",
      owner: "closedloop-ai",
      repo: "symphony-alpha",
      pullNumber: null,
    } as never);

    expect(result).toEqual({
      synced: false,
      error: null,
      retryAfterSeconds: 22,
      throttleReason: BranchViewSyncThrottleReason.ProviderRateLimit,
      scope: BranchViewSyncScope.Branch,
    });
    expect(mockMarkBranchSyncProviderRateLimited).toHaveBeenCalledWith({
      organizationId: "org-1",
      branchArtifactId: "branch-artifact-1",
      completedAt: expect.any(Date),
      startedAt: new Date("2026-06-01T12:00:00.000Z"),
    });
    expect(statusTx.branchDetail.updateMany).not.toHaveBeenCalled();
    expect(statusTx.branchStatusCheck.deleteMany).not.toHaveBeenCalled();
    expect(statusTx.branchStatusCheck.upsert).not.toHaveBeenCalled();
  });

  it("does not overwrite checksStatus when the branch head changed during sync", async () => {
    const statusTx = makeStatusCheckTx();
    statusTx.branchDetail.findFirst.mockResolvedValue(null);
    const mockDb = {
      branchDetail: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));
    mockWithDb.tx.mockImplementation((callback) => callback(statusTx));
    mockQueryStatusCheckRollup.mockResolvedValue(statusRollup("SUCCESS"));
    mockRefreshBranchFileChangeCache.mockResolvedValue({
      ok: true,
      value: { throttled: false, fileCount: 0, patchBytes: 0 },
    });

    const result = await syncBranchViewData({
      externalLink: { id: "branch-artifact-1", organizationId: "org-1" },
      branch: {
        artifactId: "branch-artifact-1",
        headSha: "abc123def456abc123def456abc123def456abc1",
        checksStatus: "UNKNOWN",
      },
      gitHubPullRequest: null,
      installationId: "123",
      owner: "closedloop-ai",
      repo: "symphony-alpha",
      pullNumber: null,
    } as never);

    expect(result).toEqual({
      synced: true,
      error: null,
      scope: BranchViewSyncScope.Branch,
    });
    expect(statusTx.branchDetail.updateMany).not.toHaveBeenCalled();
  });

  it("skips check metadata and rows when the guarded current-head write misses", async () => {
    const statusTx = makeStatusCheckTx();
    statusTx.branchDetail.updateMany.mockResolvedValue({ count: 0 });
    const mockDb = {
      branchDetail: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));
    mockWithDb.tx.mockImplementation((callback) => callback(statusTx));
    mockQueryStatusCheckRollup.mockResolvedValue(statusRollup("SUCCESS"));
    mockRefreshBranchFileChangeCache.mockResolvedValue({
      ok: true,
      value: { throttled: false, fileCount: 0, patchBytes: 0 },
    });

    const result = await syncBranchViewData({
      externalLink: { id: "branch-artifact-1", organizationId: "org-1" },
      branch: {
        artifactId: "branch-artifact-1",
        headSha: "abc123def456abc123def456abc123def456abc1",
        checksStatus: "UNKNOWN",
      },
      gitHubPullRequest: null,
      installationId: "123",
      owner: "closedloop-ai",
      repo: "symphony-alpha",
      pullNumber: null,
    } as never);

    expect(result).toEqual({
      synced: true,
      error: null,
      scope: BranchViewSyncScope.Branch,
    });
    expect(statusTx.branchDetail.updateMany).toHaveBeenCalledWith({
      data: expect.objectContaining({ checksStatus: "PASSING" }),
      where: {
        artifact: { organizationId: "org-1" },
        artifactId: "branch-artifact-1",
        deletedAt: null,
        headSha: "abc123def456abc123def456abc123def456abc1",
      },
    });
    expect(statusTx.branchStatusCheck.deleteMany).not.toHaveBeenCalled();
    expect(statusTx.branchStatusCheck.upsert).not.toHaveBeenCalled();
  });

  it("preserves last known checksStatus when GitHub rollup state is unavailable", async () => {
    const mockDb = {
      branchDetail: {
        updateMany: vi.fn(),
      },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));
    mockQueryStatusCheckRollup.mockResolvedValue({
      ok: false,
      reason: StatusCheckRollupFailureReason.GraphqlError,
    });
    mockRefreshBranchFileChangeCache.mockResolvedValue({
      ok: true,
      value: { throttled: false, fileCount: 0, patchBytes: 0 },
    });

    const result = await syncBranchViewData({
      externalLink: { id: "branch-artifact-1", organizationId: "org-1" },
      branch: {
        artifactId: "branch-artifact-1",
        headSha: "abc123def456abc123def456abc123def456abc1",
        checksStatus: "PASSING",
      },
      gitHubPullRequest: null,
      installationId: "123",
      owner: "closedloop-ai",
      repo: "symphony-alpha",
      pullNumber: null,
    } as never);

    expect(result).toEqual({
      synced: true,
      error: null,
      scope: BranchViewSyncScope.Branch,
    });
    expect(mockDb.branchDetail.updateMany).not.toHaveBeenCalled();
  });

  it("projects only current-head persisted status checks", async () => {
    const mockDb = {
      artifactLink: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      branchFileChange: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      gitHubPRReview: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      gitHubUserConnection: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      commentThread: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      project: { findFirst: vi.fn().mockResolvedValue(projectRecoveryRow()) },
      pullRequestDetail: {
        findUnique: vi.fn().mockResolvedValue({ reviewDecision: null }),
      },
      user: { findMany: vi.fn().mockResolvedValue([]) },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));

    const result = await getBranchViewData(
      {
        externalLink: {
          id: "branch-artifact-1",
          title: "feature/branch-artifact",
          externalUrl:
            "https://github.com/acme/repo/tree/feature%2Fbranch-artifact",
          status: "OPEN",
          metadata: null,
          projectId: "project-1",
          organizationId: "org-1",
          createdBy: null,
        },
        prMetadata: null,
        branch: {
          artifactId: "branch-artifact-1",
          repositoryId: "repo-1",
          branchName: "feature/branch-artifact",
          baseBranch: "main",
          baseBranchSource: "repository_default",
          headSha: "current-head",
          headShaSource: "push_webhook",
          headShaObservedAt: null,
          lastPushBeforeSha: null,
          currentPullRequestDetailId: "pr-detail-1",
          checksStatus: "FAILING",
          checksDetailHeadSha: "current-head",
          checksDetailTotalCount: 2,
          checksDetailTruncated: false,
          checksDetailProviderState: BranchViewChecksProviderState.Available,
          checksDetailUnavailableReason: null,
          checksDetailUpdatedAt: new Date("2026-05-15T00:00:00Z"),
          statusChecks: [
            {
              providerKey: "stale-check",
              headSha: "previous-head",
              kind: BranchViewCheckKind.CheckRun,
              name: "Stale check",
              status: "COMPLETED",
              conclusion: "FAILURE",
              targetUrl: "https://github.com/acme/repo/actions/runs/1",
              position: 0,
            },
            {
              providerKey: "current-check",
              headSha: "current-head",
              kind: BranchViewCheckKind.CheckRun,
              name: "Current check",
              status: "COMPLETED",
              conclusion: "FAILURE",
              targetUrl: "https://github.com/acme/repo/actions/runs/2",
              position: 1,
            },
          ],
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
        },
        gitHubPullRequest: {
          ...currentPullRequestDetail(),
          headSha: "current-head",
        },
        repositoryId: "repo-1",
        installationId: "123",
        owner: "acme",
        repo: "repo",
        pullNumber: 42,
      } as never,
      {
        id: "user-1",
        githubUsername: "octocat",
        organizationId: "org-1",
      } as never
    );

    const data = expectOk(result);
    expect(data.checks?.items).toEqual([
      expect.objectContaining({ id: "current-check", name: "Current check" }),
    ]);
  });

  it("hides stale status check rows when the provider is unavailable", async () => {
    const mockDb = {
      artifactLink: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      branchFileChange: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      gitHubPRReview: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      gitHubUserConnection: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      commentThread: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      project: { findFirst: vi.fn().mockResolvedValue(projectRecoveryRow()) },
      pullRequestDetail: {
        findUnique: vi.fn().mockResolvedValue({ reviewDecision: null }),
      },
      user: { findMany: vi.fn().mockResolvedValue([]) },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));

    const result = await getBranchViewData(
      {
        externalLink: {
          id: "branch-artifact-1",
          title: "feature/branch-artifact",
          externalUrl:
            "https://github.com/acme/repo/tree/feature%2Fbranch-artifact",
          status: "OPEN",
          metadata: null,
          projectId: "project-1",
          organizationId: "org-1",
          createdBy: null,
        },
        prMetadata: null,
        branch: {
          artifactId: "branch-artifact-1",
          repositoryId: "repo-1",
          branchName: "feature/branch-artifact",
          baseBranch: "main",
          baseBranchSource: "repository_default",
          headSha: "current-head",
          headShaSource: "push_webhook",
          headShaObservedAt: null,
          lastPushBeforeSha: null,
          currentPullRequestDetailId: "pr-detail-1",
          checksStatus: "PASSING",
          checksDetailHeadSha: "current-head",
          checksDetailTotalCount: 1,
          checksDetailTruncated: false,
          checksDetailProviderState:
            BranchViewChecksProviderState.ProviderUnavailable,
          checksDetailUnavailableReason:
            StatusCheckRollupFailureReason.GraphqlError,
          checksDetailUpdatedAt: new Date("2026-05-15T00:00:00Z"),
          statusChecks: [
            {
              providerKey: "stale-check",
              headSha: "current-head",
              kind: BranchViewCheckKind.CheckRun,
              name: "Previous response check",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              targetUrl: "https://github.com/acme/repo/actions/runs/1",
              position: 0,
            },
          ],
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
        },
        gitHubPullRequest: {
          ...currentPullRequestDetail(),
          headSha: "current-head",
        },
        repositoryId: "repo-1",
        installationId: "123",
        owner: "acme",
        repo: "repo",
        pullNumber: 42,
      } as never,
      {
        id: "user-1",
        githubUsername: "octocat",
        organizationId: "org-1",
      } as never
    );

    const data = expectOk(result);
    expect(data.checks).toEqual(
      expect.objectContaining({
        providerState: BranchViewChecksProviderState.ProviderUnavailable,
        unavailableReason: StatusCheckRollupFailureReason.GraphqlError,
        items: [],
      })
    );
  });
});

function makeStatusCheckTx(overrides: { checksStatus?: string } = {}) {
  return {
    $executeRaw: vi.fn().mockResolvedValue(1),
    branchDetail: {
      findFirst: vi.fn().mockResolvedValue({
        artifactId: "branch-artifact-1",
        checksStatus: overrides.checksStatus ?? "UNKNOWN",
      }),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    branchStatusCheck: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      upsert: vi.fn().mockResolvedValue({}),
    },
    gitHubPRReview: {
      upsert: vi.fn().mockResolvedValue({}),
    },
  };
}

function repositoryRelinkResult(
  overrides: Partial<RepositoryArtifactRelinkResult> = {}
): RepositoryArtifactRelinkResult {
  return {
    status: RepositoryArtifactRelinkStatus.Skipped,
    reasons: [RepositoryArtifactRelinkReason.None],
    activeRepositoryCount: 0,
    staleRepositoryCount: 0,
    branchRelinkedCount: 0,
    pullRequestRelinkedCount: 0,
    branchCollisionSkippedCount: 0,
    pullRequestCollisionSkippedCount: 0,
    ambiguousRepositorySkippedCount: 0,
    blockedBranchCount: 0,
    ...overrides,
  };
}

function currentPrContext(
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

function expectOk<T, E>(
  result: { ok: true; value: T } | { ok: false; error: E }
): T {
  if (!result.ok) {
    throw new Error("Expected branch view result to be ok");
  }
  return result.value;
}

function currentPullRequestDetail() {
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

function projectRecoveryRow() {
  return {
    id: "project-1",
    name: "Platform",
    teams: [],
  };
}

function branchViewDb() {
  return {
    artifactLink: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    branchFileChange: {
      count: vi.fn().mockResolvedValue(1),
      findMany: vi.fn().mockResolvedValue([]),
    },
    commentThread: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    gitHubPRReview: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    gitHubUserConnection: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    project: { findFirst: vi.fn().mockResolvedValue(projectRecoveryRow()) },
    pullRequestDetail: {
      findUnique: vi.fn().mockResolvedValue({ reviewDecision: null }),
    },
    user: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
}

function unifiedIssueCommentDb(input: {
  providerLogin: string;
  providerUserId: string;
}) {
  return {
    commentThread: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "thread-1",
          source: "GITHUB",
          status: "OPEN",
          createdAt: new Date("2026-05-21T10:00:00Z"),
          githubProjection: {
            threadKind: GitHubCommentThreadKind.IssueComment,
            reviewId: null,
            htmlUrl: "https://github.com/acme/repo/pull/42#issuecomment-123",
            path: null,
            line: null,
            commitSha: null,
            resolvable: false,
            legacyState: "PENDING",
          },
          comments: [
            {
              id: "comment-1",
              authorId: "user-1",
              body: { type: "github_markdown", markdown: "Looks good" },
              plainText: "Looks good",
              createdAt: new Date("2026-05-21T10:00:00Z"),
              githubProjection: {
                githubCommentId: "123",
                githubInReplyToCommentId: null,
                githubHtmlUrl:
                  "https://github.com/acme/repo/pull/42#issuecomment-123",
                externalAuthor: {
                  providerUserId: input.providerUserId,
                  providerLogin: input.providerLogin,
                  avatarUrl: "https://avatars.githubusercontent.com/u/1",
                  profileUrl: `https://github.com/${input.providerLogin}`,
                },
              },
            },
          ],
        },
      ]),
    },
    user: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
}
