import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockRelinkBranchViewRepositoryCredential, mockResolvePrContext } =
  vi.hoisted(() => ({
    mockRelinkBranchViewRepositoryCredential: vi.fn(),
    mockResolvePrContext: vi.fn(),
  }));

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  ArtifactSubtype: {
    FEATURE: "FEATURE",
    IMPLEMENTATION_PLAN: "IMPLEMENTATION_PLAN",
  },
  ArtifactType: { DOCUMENT: "DOCUMENT", BRANCH: "BRANCH" },
  ExternalCommentProvider: { GITHUB: "GITHUB" },
  ThreadSource: { GITHUB: "GITHUB" },
  Prisma: {
    join: (values: unknown[]) => values,
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
  },
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
  githubService: {
    relinkBranchViewRepositoryCredential:
      mockRelinkBranchViewRepositoryCredential,
  },
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  BranchViewSyncErrorCode,
  BranchViewSyncFailureReason,
} from "@repo/api/src/types/branch-view";
import { currentPrContext } from "@/__tests__/utils/branch-view-pr-context";
import {
  RepositoryArtifactRelinkReason,
  type RepositoryArtifactRelinkResult,
  RepositoryArtifactRelinkStatus,
} from "@/app/integrations/github/service/repository-relink-telemetry";
import {
  BranchViewContextCredentialMode,
  BranchViewContextCredentialSource,
} from "@/lib/resolve-pr-context";
import {
  buildCanonicalGitHubPullRequestUrl,
  buildStaleCommentDeleteWhere,
  resolveBranchViewSyncPreflightContext,
} from "./service";

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
