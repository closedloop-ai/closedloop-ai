import type * as GitHubModule from "@repo/github";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NARROWEST_BRANCH_FILE_CHANGE_READ_BOUND } from "./branch-file-change-read-bounds";

/**
 * The mismatch ISS-8480 guards cannot be staged from data — the persistence
 * cap's only argument is a compile-time constant — so it is staged the one way
 * it can actually occur: a provider compare limit raised past what the bounded
 * Branch reads load. Derived from the bound so it stays a mismatch if the bound
 * moves; the bound's own value is pinned against an independent literal in
 * `branch-file-change-read-bounds.test.ts`.
 */
const OVER_BOUND_PROVIDER_LIMIT = NARROWEST_BRANCH_FILE_CHANGE_READ_BOUND + 1;

const BRANCH_ARTIFACT_ID = "branch-artifact-1";
const ORGANIZATION_ID = "org-1";

const compareBranchFileChanges = vi.fn();
const getInstallationOctokit = vi.fn();
let mockTx: {
  branchFileChange: {
    deleteMany: ReturnType<typeof vi.fn>;
    createMany: ReturnType<typeof vi.fn>;
  };
  branchDetail: { updateMany: ReturnType<typeof vi.fn> };
};
let mockDb: {
  branchDetail: {
    findFirst: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
};

function mockRefreshDependencies(providerFileLimit?: number): void {
  mockDb = {
    branchDetail: {
      findFirst: vi.fn().mockResolvedValue({
        artifactId: BRANCH_ARTIFACT_ID,
        baseBranch: "main",
        headSha: "sha-2",
        fileCacheHeadSha: null,
        lastSyncStartedAt: null,
        repository: {
          owner: "closedloop-ai",
          name: "closedloop-ai",
          installation: { installationId: "123456", status: "ACTIVE" },
        },
        syncStatus: "FRESH",
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  mockTx = {
    branchFileChange: { deleteMany: vi.fn(), createMany: vi.fn() },
    branchDetail: { updateMany: vi.fn() },
  };
  const withDb = Object.assign(
    vi.fn((callback: (db: typeof mockDb) => unknown) => callback(mockDb)),
    {
      tx: vi.fn((callback: (tx: typeof mockTx) => unknown) => callback(mockTx)),
    }
  );

  vi.doMock("@repo/database", () => ({
    GitHubInstallationStatus: { ACTIVE: "ACTIVE" },
    withDb,
  }));
  vi.doMock("@repo/github/installation-auth", () => ({
    getInstallationOctokit,
  }));
  vi.doMock("@repo/observability/log", () => ({ log: { warn: vi.fn() } }));
  vi.doMock("@repo/github", async (importOriginal) => {
    const actual = await importOriginal<typeof GitHubModule>();
    return {
      ...actual,
      compareBranchFileChangesWithProviderResult: compareBranchFileChanges,
      GITHUB_COMPARE_FILE_LIMIT:
        providerFileLimit ?? actual.GITHUB_COMPARE_FILE_LIMIT,
    };
  });
}

async function refresh() {
  const { refreshBranchFileChangeCache } = await import("./file-cache-service");
  return refreshBranchFileChangeCache(BRANCH_ARTIFACT_ID, {
    organizationId: ORGANIZATION_ID,
  });
}

describe("branch file-change persistence cap guard", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getInstallationOctokit.mockResolvedValue({
      marker: "installation-octokit",
    });
    compareBranchFileChanges.mockResolvedValue({
      status: "success",
      value: {
        files: [
          {
            filename: "apps/api/app/branches/file-cache-service.ts",
            status: "modified",
            additions: 2,
            deletions: 1,
            changes: 3,
          },
        ],
        capped: false,
      },
    });
  });

  afterEach(() => {
    vi.doUnmock("@repo/github");
    vi.doUnmock("@repo/database");
    vi.doUnmock("@repo/github/installation-auth");
    vi.doUnmock("@repo/observability/log");
    vi.resetModules();
  });

  it("persists a refresh under the shipped provider compare limit", async () => {
    mockRefreshDependencies();

    await expect(refresh()).resolves.toEqual({
      ok: true,
      value: { throttled: false, fileCount: 1, patchBytes: 0 },
    });
    expect(mockTx.branchFileChange.createMany).toHaveBeenCalled();
  });

  it("refuses the refresh when the provider compare limit outruns the bounded reads, and writes nothing", async () => {
    mockRefreshDependencies(OVER_BOUND_PROVIDER_LIMIT);

    await expect(refresh()).rejects.toThrow(
      `Branch file-change persistence cap ${OVER_BOUND_PROVIDER_LIMIT} exceeds the strictest completeness bound (${NARROWEST_BRANCH_FILE_CHANGE_READ_BOUND} rows)`
    );
    expect(mockTx.branchFileChange.createMany).not.toHaveBeenCalled();
  });

  // The refusal must land before `startBranchSync`. Nothing in the refresh
  // settles a branch on a throw, so a token acquired first is held for the whole
  // BRANCH_VIEW_IN_FLIGHT_STALE_MS lease with no terminal state ever written.
  // `branchDetail.updateMany` is the only write in that acquisition — and the
  // only write `markCacheRefreshFailed` would use to settle it — so zero calls
  // pins both halves: no token taken, and no `Failed` stamped over a real
  // cache's status for a build-time misconfiguration.
  it("refuses before acquiring the sync token, leaving no branch in flight", async () => {
    mockRefreshDependencies(OVER_BOUND_PROVIDER_LIMIT);

    await expect(refresh()).rejects.toThrow(
      "exceeds the strictest completeness bound"
    );
    expect(mockDb.branchDetail.updateMany).not.toHaveBeenCalled();
    expect(compareBranchFileChanges).not.toHaveBeenCalled();
  });
});
