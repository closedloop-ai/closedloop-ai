import type { Octokit } from "@octokit/rest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockLogError, mockLogWarn } = vi.hoisted(() => ({
  mockLogError: vi.fn(),
  mockLogWarn: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: mockLogError,
    info: vi.fn(),
    warn: mockLogWarn,
  },
}));

import { getRepositoryBranches, getRepositoryContributors } from "../index";

const OWNER = "acme";
const REPO = "widgets";
const EPOCH = new Date(0).toISOString();

const mockGraphql = vi.fn();
const mockListContributors = vi.fn();
const octokit = {
  graphql: mockGraphql,
  repos: { listContributors: mockListContributors },
} as unknown as Octokit;

describe("repository reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getRepositoryBranches", () => {
    it("sorts by commit date, fills missing dates, and pins the default branch", async () => {
      mockGraphql.mockResolvedValueOnce(
        makeBranchResponse("main", [
          branch("feature/new", "2026-08-07T12:00:00Z"),
          branch("feature/unknown"),
          branch("main", "2026-08-01T12:00:00Z"),
        ])
      );

      await expect(
        getRepositoryBranches(octokit, OWNER, REPO)
      ).resolves.toEqual([
        {
          name: "main",
          committedDate: "2026-08-01T12:00:00Z",
          isDefault: true,
        },
        {
          name: "feature/new",
          committedDate: "2026-08-07T12:00:00Z",
          isDefault: false,
        },
        {
          name: "feature/unknown",
          committedDate: EPOCH,
          isDefault: false,
        },
      ]);
      expect(mockGraphql).toHaveBeenCalledWith(expect.any(String), {
        owner: OWNER,
        name: REPO,
      });
    });

    it("preserves missing provider default authority without inferring a branch", async () => {
      mockGraphql.mockResolvedValueOnce(
        makeBranchResponse(null, [
          branch("feature/new", "2026-08-07T12:00:00Z"),
        ])
      );

      await expect(
        getRepositoryBranches(octokit, OWNER, REPO, 2)
      ).resolves.toEqual([
        {
          name: "feature/new",
          committedDate: "2026-08-07T12:00:00Z",
          isDefault: false,
        },
      ]);
    });

    it("leaves an already-first default branch in place", async () => {
      mockGraphql.mockResolvedValueOnce(
        makeBranchResponse("main", [
          branch("main", "2026-08-07T12:00:00Z"),
          branch("feature/old", "2026-08-01T12:00:00Z"),
        ])
      );

      const result = await getRepositoryBranches(octokit, OWNER, REPO, 1);

      expect(result).toEqual([
        {
          name: "main",
          committedDate: "2026-08-07T12:00:00Z",
          isDefault: true,
        },
      ]);
    });

    it.each([
      [new Error("provider unavailable"), "provider unavailable"],
      [null, "Unknown error"],
    ])("describes provider failures without hiding unknown throws", async (error, message) => {
      mockGraphql.mockRejectedValueOnce(error);

      await expect(getRepositoryBranches(octokit, OWNER, REPO)).rejects.toThrow(
        `Failed to fetch branches: ${message}`
      );
      expect(mockLogError).toHaveBeenCalledWith(
        "[github/branches] Failed to fetch branches",
        { owner: OWNER, name: REPO, error: message }
      );
    });
  });

  describe("getRepositoryContributors", () => {
    it("bounds the page and removes unusable or bot contributors", async () => {
      mockListContributors.mockResolvedValueOnce({
        data: [
          {
            login: "octocat",
            type: "User",
            avatar_url: "https://avatars.githubusercontent.com/u/1",
            contributions: 12,
            html_url: "https://github.com/octocat",
          },
          {
            login: "fallbacks",
            type: "User",
            avatar_url: null,
            contributions: undefined,
            html_url: null,
          },
          { login: null, type: "User" },
          { login: "dependabot", type: "Bot" },
        ],
      });

      await expect(
        getRepositoryContributors(octokit, OWNER, REPO, { perPage: 500 })
      ).resolves.toEqual([
        {
          login: "octocat",
          avatarUrl: "https://avatars.githubusercontent.com/u/1",
          contributions: 12,
          htmlUrl: "https://github.com/octocat",
        },
        {
          login: "fallbacks",
          avatarUrl: "",
          contributions: 0,
          htmlUrl: "",
        },
      ]);
      expect(mockListContributors).toHaveBeenCalledWith({
        owner: OWNER,
        repo: REPO,
        per_page: 100,
      });
    });

    it("uses the default page size", async () => {
      mockListContributors.mockResolvedValueOnce({ data: [] });

      await expect(
        getRepositoryContributors(octokit, OWNER, REPO)
      ).resolves.toEqual([]);
      expect(mockListContributors).toHaveBeenCalledWith({
        owner: OWNER,
        repo: REPO,
        per_page: 30,
      });
    });

    it.each([
      404, 204,
    ])("treats provider status %s as an empty contributor list", async (status) => {
      mockListContributors.mockRejectedValueOnce({ status });

      await expect(
        getRepositoryContributors(octokit, OWNER, REPO)
      ).resolves.toEqual([]);
      expect(mockLogWarn).not.toHaveBeenCalled();
    });

    it.each([
      [new Error("provider unavailable"), "provider unavailable"],
      [{}, "Unknown error"],
    ])("logs and suppresses ordinary provider failures", async (error, message) => {
      mockListContributors.mockRejectedValueOnce(error);

      await expect(
        getRepositoryContributors(octokit, OWNER, REPO)
      ).resolves.toEqual([]);
      expect(mockLogWarn).toHaveBeenCalledWith(
        "[github/contributors] Failed to list repository contributors",
        { owner: OWNER, repo: REPO, error: message }
      );
    });
  });
});

function branch(name: string, committedDate?: string) {
  return { name, target: { committedDate } };
}

function makeBranchResponse(
  defaultBranch: string | null,
  nodes: ReturnType<typeof branch>[]
) {
  return {
    repository: {
      defaultBranchRef: defaultBranch ? { name: defaultBranch } : null,
      refs: { nodes },
    },
  };
}
