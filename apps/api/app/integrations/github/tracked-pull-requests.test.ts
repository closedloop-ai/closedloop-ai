import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  ArtifactType: { BRANCH: "BRANCH" },
}));

import { withDb } from "@repo/database";
import { getTrackedPullRequestState } from "./tracked-pull-requests";

const mockWithDb = withDb as unknown as ReturnType<typeof vi.fn>;
let artifacts: unknown[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  artifacts = [];
  const db = {
    artifact: { findMany: vi.fn(() => Promise.resolve(artifacts)) },
  };
  mockWithDb.mockImplementation((fn: (client: unknown) => unknown) => fn(db));
});

describe("getTrackedPullRequestState", () => {
  it("returns empty state and skips the DB when there is no projectId", async () => {
    const result = await getTrackedPullRequestState({
      organizationId: "org",
      projectId: null,
      repositoryFullName: "acme/repo",
      repositoryId: "repo-1",
    });

    expect(result).toEqual({
      trackedPrUrls: [],
      trackedBranches: [],
      trackedBranchKeys: [],
      trackedPrNumbers: [],
    });
    expect(mockWithDb).not.toHaveBeenCalled();
  });

  it("derives tracked branches, keys, PR urls, and deduped PR numbers for this repo", async () => {
    artifacts = [
      {
        externalUrl: "https://github.com/acme/repo/tree/feature-42",
        branch: {
          branchName: "feature-42",
          currentPullRequestDetail: {
            htmlUrl: "https://github.com/acme/repo/pull/42",
          },
        },
      },
      {
        externalUrl: "https://github.com/acme/repo/tree/branch-only",
        branch: { branchName: "branch-only", currentPullRequestDetail: null },
      },
      // A row whose branch relation did not load is skipped, not crashed on.
      { externalUrl: null, branch: null },
    ];

    const result = await getTrackedPullRequestState({
      organizationId: "org",
      projectId: "proj",
      repositoryFullName: "acme/repo",
      repositoryId: "repo-1",
    });

    expect(result.trackedBranchKeys).toEqual([
      "acme/repo:feature-42",
      "acme/repo:branch-only",
    ]);
    expect(result.trackedPrUrls).toEqual([
      "https://github.com/acme/repo/pull/42",
    ]);
    expect(result.trackedPrNumbers).toEqual([42]);
    expect(result.trackedBranches).toContainEqual({
      branchName: "branch-only",
      branchKey: "acme/repo:branch-only",
      htmlUrl: "https://github.com/acme/repo/tree/branch-only",
      pullRequestUrl: null,
    });
  });
});
