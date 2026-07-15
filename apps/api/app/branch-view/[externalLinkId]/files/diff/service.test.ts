import {
  BranchFileCacheStatus,
  BranchSyncStatus,
} from "@repo/api/src/types/artifact";
import { ChecksStatus } from "@repo/api/src/types/branch-view";
import { GitHubPRState } from "@repo/api/src/types/github";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BranchViewContextCredentialSource } from "@/lib/resolve-pr-context";

const { mockGetBoundedFileContentAtRef, mockGetMergeBaseSha, mockWithDb } =
  vi.hoisted(() => ({
    mockGetBoundedFileContentAtRef: vi.fn(),
    mockGetMergeBaseSha: vi.fn(),
    mockWithDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  }));

vi.mock("@repo/github", () => ({
  getBoundedFileContentAtRef: mockGetBoundedFileContentAtRef,
  getMergeBaseSha: mockGetMergeBaseSha,
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

describe("branch-view file diff authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      "src/secrets.ts",
      null
    );

    expect(result).toEqual({
      data: null,
      error: "File is not part of this branch",
    });
    expect(mockGetBoundedFileContentAtRef).not.toHaveBeenCalled();
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
    // The base side is read at the merge-base, not the base branch tip.
    expect(mockGetMergeBaseSha).toHaveBeenCalledWith(
      "123",
      "acme",
      "repo",
      "main",
      "head-sha"
    );
    expect(mockGetBoundedFileContentAtRef).toHaveBeenCalledTimes(2);
    expect(mockGetBoundedFileContentAtRef).toHaveBeenNthCalledWith(
      1,
      "123",
      "acme",
      "repo",
      "src/changed.ts",
      "merge-base-sha",
      1024 * 1024
    );
    expect(mockGetBoundedFileContentAtRef).toHaveBeenNthCalledWith(
      2,
      "123",
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
    expect(mockGetMergeBaseSha).toHaveBeenCalledWith(
      "active-installation",
      "active-owner",
      "renamed-repo",
      "main",
      "head-sha"
    );
    expect(mockGetBoundedFileContentAtRef).toHaveBeenNthCalledWith(
      1,
      "active-installation",
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

    const result = await getFileDiff(prContext as never, "src/huge.ts", null);

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

    await getFileDiff(prContext as never, "src/changed.ts", null);

    expect(mockGetBoundedFileContentAtRef).toHaveBeenNthCalledWith(
      1,
      "123",
      "acme",
      "repo",
      "src/changed.ts",
      "main",
      1024 * 1024
    );
  });
});
