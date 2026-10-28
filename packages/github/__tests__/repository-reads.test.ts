import type { Octokit } from "@octokit/rest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockLogError } = vi.hoisted(() => ({
  mockLogError: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: mockLogError,
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { getRepositoryBranches } from "../index";

const OWNER = "acme";
const REPO = "widgets";
const EPOCH = new Date(0).toISOString();

const mockGraphql = vi.fn();
const octokit = {
  graphql: mockGraphql,
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

    it("prepends the default branch at epoch when it is absent from the fetched refs", async () => {
      mockGraphql.mockResolvedValueOnce(
        makeBranchResponse("main", [
          branch("feature/a", "2026-09-02T00:00:00Z"),
        ])
      );

      await expect(
        getRepositoryBranches(octokit, OWNER, REPO)
      ).resolves.toEqual([
        { name: "main", committedDate: EPOCH, isDefault: true },
        {
          name: "feature/a",
          committedDate: "2026-09-02T00:00:00Z",
          isDefault: false,
        },
      ]);
    });

    it("dates a ref with a null committed date at epoch", async () => {
      mockGraphql.mockResolvedValueOnce(
        makeBranchResponse("main", [branch("main", null)])
      );

      await expect(
        getRepositoryBranches(octokit, OWNER, REPO)
      ).resolves.toEqual([
        { name: "main", committedDate: EPOCH, isDefault: true },
      ]);
    });

    it.each([
      [new Error("provider unavailable"), "provider unavailable"],
      [null, "Unknown error"],
    ])(
      "describes provider failures without hiding unknown throws",
      async (error, message) => {
        mockGraphql.mockRejectedValueOnce(error);

        await expect(
          getRepositoryBranches(octokit, OWNER, REPO)
        ).rejects.toThrow(`Failed to fetch branches: ${message}`);
        expect(mockLogError).toHaveBeenCalledWith(
          "[github/branches] Failed to fetch branches",
          { owner: OWNER, name: REPO, error: message }
        );
      }
    );
  });
});

function branch(name: string, committedDate?: string | null) {
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
