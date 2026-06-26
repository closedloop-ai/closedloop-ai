import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockPaginate = vi.fn();
const mockGetRepoInstallation = vi.fn().mockResolvedValue({ data: { id: 42 } });

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    apps = {
      getRepoInstallation: mockGetRepoInstallation,
    };
    repos = {
      listBranches: vi.fn(),
    };
    paginate = mockPaginate;
  },
}));

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: vi.fn(() => async (_opts: unknown) => ({
    token: "test-token",
  })),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { log } from "@repo/observability/log";
import { listAllBranchNames } from "../index";

const OWNER = "acme";
const REPO = "my-repo";

describe("listAllBranchNames", () => {
  beforeAll(() => {
    process.env.GITHUB_APP_ID = "1";
    process.env.GITHUB_APP_PRIVATE_KEY = "test-key";
    process.env.GITHUB_APP_WEBHOOK_SECRET = "test-secret";
    process.env.GITHUB_APP_CLIENT_ID = "test-client-id";
    process.env.GITHUB_APP_CLIENT_SECRET = "test-client-secret";
    process.env.GITHUB_APP_DISPATCH_REPO = "owner/dispatch";
    process.env.WEBAPP_ENV = "stage";
  });

  beforeEach(() => {
    mockPaginate.mockReset();
    mockGetRepoInstallation.mockReset();
    mockGetRepoInstallation.mockResolvedValue({ data: { id: 42 } });
  });

  it("returns all branch names from a multi-page fetch", async () => {
    mockPaginate.mockResolvedValueOnce([
      { name: "main" },
      { name: "develop" },
      { name: "feature/foo" },
      { name: "release/1.0" },
    ]);

    const result = await listAllBranchNames(OWNER, REPO);

    expect(result).toEqual(["main", "develop", "feature/foo", "release/1.0"]);
    expect(mockPaginate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        owner: OWNER,
        repo: REPO,
        per_page: 100,
      })
    );
  });

  it("returns an empty array when the repository has no branches", async () => {
    mockPaginate.mockResolvedValueOnce([]);

    const result = await listAllBranchNames(OWNER, REPO);

    expect(result).toEqual([]);
    expect(mockPaginate).toHaveBeenCalledOnce();
  });

  it("throws a descriptive error when the GitHub API fails", async () => {
    mockPaginate.mockRejectedValueOnce(new Error("API rate limit exceeded"));

    await expect(listAllBranchNames(OWNER, REPO)).rejects.toThrow(
      "Failed to list all branch names: API rate limit exceeded"
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it("throws a descriptive error when the failure reason is not an Error instance", async () => {
    mockPaginate.mockRejectedValueOnce("unexpected string rejection");

    await expect(listAllBranchNames(OWNER, REPO)).rejects.toThrow(
      "Failed to list all branch names: Unknown error"
    );
  });

  it("resolves the installation for the correct owner and repo", async () => {
    mockPaginate.mockResolvedValueOnce([{ name: "main" }]);

    await listAllBranchNames(OWNER, REPO);

    expect(mockGetRepoInstallation).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
    });
  });
});
