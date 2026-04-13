import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetFileContentAtRef,
  mockGetSinglePullRequest,
  mockListPullRequestFiles,
} = vi.hoisted(() => ({
  mockGetFileContentAtRef: vi.fn(),
  mockGetSinglePullRequest: vi.fn(),
  mockListPullRequestFiles: vi.fn(),
}));

vi.mock("@repo/github", () => ({
  getFileContentAtRef: mockGetFileContentAtRef,
  getSinglePullRequest: mockGetSinglePullRequest,
  listPullRequestFiles: mockListPullRequestFiles,
}));

import { getFileDiff, isRequestedDiffInPullRequest } from "./service";

const prContext = {
  externalLink: {
    id: "ext-1",
    title: "PR 42",
    externalUrl: "https://github.com/acme/repo/pull/42",
    metadata: null,
    projectId: "proj-1",
    workstreamId: "work-1",
    organizationId: "org-1",
  },
  prMetadata: null,
  gitHubPullRequest: null,
  repositoryId: "repo-1",
  installationId: "123",
  owner: "acme",
  repo: "repo",
  pullNumber: 42,
} as const;

describe("branch-view file diff authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSinglePullRequest.mockResolvedValue({
      baseSha: "base-sha",
      headSha: "head-sha",
    });
  });

  it("requires an exact path and previousPath match for renamed files", () => {
    const files = [
      {
        filename: "src/new-name.ts",
        previous_filename: "src/old-name.ts",
      },
    ];

    expect(
      isRequestedDiffInPullRequest(files, "src/new-name.ts", "src/old-name.ts")
    ).toBe(true);
    expect(isRequestedDiffInPullRequest(files, "src/new-name.ts", null)).toBe(
      false
    );
  });

  it("rejects file reads for paths that are not in the pull request", async () => {
    mockListPullRequestFiles.mockResolvedValue([
      {
        filename: "src/changed.ts",
      },
    ]);

    const result = await getFileDiff(
      prContext as never,
      "src/secrets.ts",
      null
    );

    expect(result).toEqual({
      data: null,
      error: "File is not part of this pull request",
    });
    expect(mockGetFileContentAtRef).not.toHaveBeenCalled();
  });
});
