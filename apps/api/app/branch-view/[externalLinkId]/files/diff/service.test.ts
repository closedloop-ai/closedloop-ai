import {
  BranchFileCacheStatus,
  BranchSyncStatus,
} from "@repo/api/src/types/artifact";
import { ChecksStatus } from "@repo/api/src/types/branch-view";
import {
  GitHubAccessDenialReason,
  GitHubPRState,
} from "@repo/api/src/types/github";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BranchViewContextCredentialSource } from "@/lib/resolve-pr-context";

const {
  mockGetBoundedFileContentAtRef,
  mockGetMergeBaseSha,
  mockRunBranchViewRead,
  mockWithDb,
} = vi.hoisted(() => ({
  mockGetBoundedFileContentAtRef: vi.fn(),
  mockGetMergeBaseSha: vi.fn(),
  mockRunBranchViewRead: vi.fn(),
  mockWithDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/github/file-content", () => ({
  getBoundedFileContentAtRef: mockGetBoundedFileContentAtRef,
  getMergeBaseSha: mockGetMergeBaseSha,
}));

vi.mock("@/lib/github/github-branch-view-read-client", () => ({
  runBranchViewRead: mockRunBranchViewRead,
}));

vi.mock("@repo/database", () => ({
  withDb: mockWithDb,
}));

vi.mock("@/lib/resolve-pr-context", () => ({
  BranchViewContextCredentialSource: {
    PinnedActive: "pinned_active",
    ActiveSibling: "active_sibling",
  },
}));

import { getFileDiff } from "./service";

// The resolver-built client the service must thread into every GitHub read.
const RESOLVED_OCTOKIT = { marker: "resolved-octokit" };

const prContext = {
  externalLink: {
    id: "ext-1",
    title: "PR 42",
    externalUrl: "https://github.com/acme/repo/pull/42",
    status: GitHubPRState.Open,
    metadata: null,
    projectId: "proj-1",
    workstreamId: "work-1",
    organizationId: "org-1",
    createdBy: { githubUsername: "octocat" },
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
    currentPullRequestDetailId: "pr-detail-42",
    checksStatus: ChecksStatus.Unknown,
    fileCacheStatus: BranchFileCacheStatus.Fresh,
    fileCacheHeadSha: "head-sha",
    fileCacheFileCount: 1,
    fileCachePatchBytes: 0,
    fileCacheUpdatedAt: null,
    syncStatus: BranchSyncStatus.Fresh,
    lastSyncStartedAt: null,
    lastSyncCompletedAt: null,
    lastSyncErrorCode: null,
    lastSyncErrorMessage: null,
  },
  gitHubPullRequest: {
    id: "branch-artifact-1",
    repositoryId: "repo-1",
    documentId: null,
    workstreamId: "work-1",
    githubId: "4242",
    headSha: "head-sha",
    number: 42,
    title: "PR 42",
    htmlUrl: "https://github.com/acme/repo/pull/42",
    baseBranch: "main",
    headBranch: "feature/branch-artifact",
    state: GitHubPRState.Open,
    isDraft: false,
    checksStatus: ChecksStatus.Unknown,
    reviewDecision: null,
  },
  repositoryId: "repo-1",
  installationId: "123",
  owner: "acme",
  repo: "repo",
  pullNumber: 42,
} as const;

/** Wire the file-cache lookup so the requested path is a changed file. */
function installChangedFile() {
  mockWithDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback({
      branchFileChange: {
        findFirst: vi.fn().mockResolvedValue({
          path: "src/changed.ts",
          previousPath: null,
          isBinary: false,
        }),
      },
    })
  );
}

describe("branch-view file diff authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Pass-through: run the service's read with the resolved client and wrap
    // it in the runner's Result. Denial classification itself is covered by
    // the github-branch-view-read-client tests.
    mockRunBranchViewRead.mockImplementation(async (_input, read) => ({
      ok: true,
      value: await read(RESOLVED_OCTOKIT),
    }));
  });

  it("rejects file reads for paths that are not in the pull request", async () => {
    const mockDb = {
      branchFileChange: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));

    const result = await getFileDiff(
      prContext as never,
      "user-1",
      "src/secrets.ts",
      null
    );

    expect(result).toEqual({
      data: null,
      error: "File is not part of this branch",
    });
    expect(mockGetBoundedFileContentAtRef).not.toHaveBeenCalled();
    // No credential is resolved for a request that never reaches GitHub.
    expect(mockRunBranchViewRead).not.toHaveBeenCalled();
  });

  it("fetches raw content only after the requested path matches the branch file cache", async () => {
    const mockDb = {
      branchFileChange: {
        findFirst: vi.fn().mockResolvedValue({
          path: "src/changed.ts",
          previousPath: null,
          isBinary: false,
        }),
      },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));
    mockGetMergeBaseSha.mockResolvedValue("merge-base-sha");
    mockGetBoundedFileContentAtRef
      .mockResolvedValueOnce({ status: "found", content: "old content" })
      .mockResolvedValueOnce({ status: "found", content: "new content" });

    const result = await getFileDiff(
      prContext as never,
      "user-1",
      "src/changed.ts",
      null
    );

    expect(result).toEqual({
      data: {
        path: "src/changed.ts",
        oldContent: "old content",
        newContent: "new content",
        isNew: false,
        isDeleted: false,
        isBinary: false,
      },
      error: null,
    });
    // The client comes from the PLN-1525 read runner, once per request…
    expect(mockRunBranchViewRead).toHaveBeenCalledTimes(1);
    expect(mockRunBranchViewRead).toHaveBeenCalledWith(
      {
        organizationId: "org-1",
        userId: "user-1",
        target: { owner: "acme", repo: "repo" },
      },
      expect.any(Function),
      expect.any(Function)
    );
    // …and the base side is read at the merge-base, not the base branch tip.
    expect(mockGetMergeBaseSha).toHaveBeenCalledWith(
      RESOLVED_OCTOKIT,
      "acme",
      "repo",
      "main",
      "head-sha"
    );
    expect(mockGetBoundedFileContentAtRef).toHaveBeenCalledTimes(2);
    expect(mockGetBoundedFileContentAtRef).toHaveBeenNthCalledWith(
      1,
      RESOLVED_OCTOKIT,
      "acme",
      "repo",
      "src/changed.ts",
      "merge-base-sha",
      1024 * 1024
    );
    expect(mockGetBoundedFileContentAtRef).toHaveBeenNthCalledWith(
      2,
      RESOLVED_OCTOKIT,
      "acme",
      "repo",
      "src/changed.ts",
      "head-sha",
      1024 * 1024
    );
  });

  it("uses active-sibling credential values only after cached membership passes", async () => {
    const mockDb = {
      branchFileChange: {
        findFirst: vi.fn().mockResolvedValue({
          path: "src/changed.ts",
          previousPath: null,
          isBinary: false,
        }),
      },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));
    mockGetMergeBaseSha.mockResolvedValue("merge-base-sha");
    mockGetBoundedFileContentAtRef
      .mockResolvedValueOnce({ status: "found", content: "old content" })
      .mockResolvedValueOnce({ status: "found", content: "new content" });

    const result = await getFileDiff(
      {
        ...prContext,
        credentialRepositoryId: "active-repo-1",
        credentialSource: BranchViewContextCredentialSource.ActiveSibling,
        installationId: "active-installation",
        owner: "active-owner",
        repo: "renamed-repo",
      } as never,
      "user-1",
      "src/changed.ts",
      null
    );

    expect(result.error).toBeNull();
    expect(mockDb.branchFileChange.findFirst).toHaveBeenCalledWith({
      where: {
        branchArtifactId: "branch-artifact-1",
        path: "src/changed.ts",
        previousPath: null,
      },
      select: {
        path: true,
        previousPath: true,
        isBinary: true,
      },
    });
    // The sibling's identity feeds the resolver target. No installation
    // credential rides along — the read is the user's or it is denied.
    expect(mockRunBranchViewRead).toHaveBeenCalledWith(
      {
        organizationId: "org-1",
        userId: "user-1",
        target: { owner: "active-owner", repo: "renamed-repo" },
      },
      expect.any(Function),
      expect.any(Function)
    );
    expect(mockGetMergeBaseSha).toHaveBeenCalledWith(
      RESOLVED_OCTOKIT,
      "active-owner",
      "renamed-repo",
      "main",
      "head-sha"
    );
    expect(mockGetBoundedFileContentAtRef).toHaveBeenNthCalledWith(
      1,
      RESOLVED_OCTOKIT,
      "active-owner",
      "renamed-repo",
      "src/changed.ts",
      "merge-base-sha",
      1024 * 1024
    );
  });

  it("rejects oversized content before decoding strings in the diff service", async () => {
    const mockDb = {
      branchFileChange: {
        findFirst: vi.fn().mockResolvedValue({
          path: "src/huge.ts",
          previousPath: null,
          isBinary: false,
        }),
      },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));
    mockGetBoundedFileContentAtRef
      .mockResolvedValueOnce({ status: "found", content: "old content" })
      .mockResolvedValueOnce({ status: "too_large" });

    const result = await getFileDiff(
      prContext as never,
      "user-1",
      "src/huge.ts",
      null
    );

    expect(result).toEqual({
      data: null,
      error: "File content exceeds 1 MiB limit",
    });
  });

  it("denies binary cached files before requesting raw content", async () => {
    const mockDb = {
      branchFileChange: {
        findFirst: vi.fn().mockResolvedValue({
          path: "assets/screenshot.png",
          previousPath: null,
          isBinary: true,
        }),
      },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));

    const result = await getFileDiff(
      prContext as never,
      "user-1",
      "assets/screenshot.png",
      null
    );

    expect(result).toEqual({
      data: {
        path: "assets/screenshot.png",
        oldContent: "",
        newContent: "",
        isNew: false,
        isDeleted: false,
        isBinary: true,
      },
      error: null,
    });
    expect(mockGetBoundedFileContentAtRef).not.toHaveBeenCalled();
    expect(mockRunBranchViewRead).not.toHaveBeenCalled();
  });

  it("flags only a both-sides-missing outcome as a possible cloaked 404", async () => {
    const mockDb = {
      branchFileChange: {
        findFirst: vi.fn().mockResolvedValue({
          path: "src/changed.ts",
          previousPath: null,
          isBinary: false,
        }),
      },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));
    mockGetMergeBaseSha.mockResolvedValue("merge-base-sha");
    mockGetBoundedFileContentAtRef
      .mockResolvedValueOnce({ status: "missing" })
      .mockResolvedValueOnce({ status: "found", content: "new content" });

    await getFileDiff(prContext as never, "user-1", "src/changed.ts", null);

    const looksCloaked = mockRunBranchViewRead.mock.calls[0][2];
    // The cached file is a changed file of this branch: absent from BOTH refs
    // is implausible and must be distrusted…
    expect(looksCloaked([{ status: "missing" }, { status: "missing" }])).toBe(
      true
    );
    // …while one side missing is a legitimate new or deleted file.
    expect(
      looksCloaked([{ status: "missing" }, { status: "found", content: "x" }])
    ).toBe(false);
    expect(
      looksCloaked([{ status: "found", content: "x" }, { status: "missing" }])
    ).toBe(false);
  });

  it("falls back to the base branch ref when the merge base cannot be resolved", async () => {
    const mockDb = {
      branchFileChange: {
        findFirst: vi.fn().mockResolvedValue({
          path: "src/changed.ts",
          previousPath: null,
          isBinary: false,
        }),
      },
    };
    mockWithDb.mockImplementation((callback) => callback(mockDb));
    mockGetMergeBaseSha.mockResolvedValue(null);
    mockGetBoundedFileContentAtRef
      .mockResolvedValueOnce({ status: "found", content: "old content" })
      .mockResolvedValueOnce({ status: "found", content: "new content" });

    await getFileDiff(prContext as never, "user-1", "src/changed.ts", null);

    expect(mockGetBoundedFileContentAtRef).toHaveBeenNthCalledWith(
      1,
      RESOLVED_OCTOKIT,
      "acme",
      "repo",
      "src/changed.ts",
      "main",
      1024 * 1024
    );
  });
  it.each([
    GitHubAccessDenialReason.Revoked,
    GitHubAccessDenialReason.NoInstallation,
  ])("maps a %s read denial onto accessDenial instead of a bare error string", async (reason) => {
    installChangedFile();
    mockRunBranchViewRead.mockResolvedValueOnce({
      ok: false,
      error: { reason },
    });

    const result = await getFileDiff(
      prContext as never,
      "user-1",
      "src/changed.ts",
      null
    );

    expect(result).toEqual({
      data: null,
      error: "File diff unavailable",
      accessDenial: { reason },
    });
  });

  it("carries retryAfterSeconds through so the route can send a Retry-After", async () => {
    // The whole denial is threaded, not just its reason: dropping the ETA here
    // is what previously left the client with no idea when to retry.
    installChangedFile();
    mockRunBranchViewRead.mockResolvedValueOnce({
      ok: false,
      error: {
        reason: GitHubAccessDenialReason.RateLimited,
        retryAfterSeconds: 42,
      },
    });

    const result = await getFileDiff(
      prContext as never,
      "user-1",
      "src/changed.ts",
      null
    );

    expect(result.accessDenial).toEqual({
      reason: GitHubAccessDenialReason.RateLimited,
      retryAfterSeconds: 42,
    });
  });
});
