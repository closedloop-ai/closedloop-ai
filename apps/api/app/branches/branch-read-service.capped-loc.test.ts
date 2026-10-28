import { GitHubPRState } from "@repo/api/src/types/github";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({ ChecksStatus: { UNKNOWN: "UNKNOWN" } });
});

vi.mock("@repo/github", async () => {
  const actual =
    await vi.importActual<typeof import("@repo/github")>("@repo/github");
  return { ...actual, getSinglePullRequestWithProviderResult: vi.fn() };
});

vi.mock("@/app/agent-sessions/service", () => ({
  agentSessionsService: { findSessionDetail: vi.fn() },
}));

import {
  branchId,
  createMockDb,
  makeBranchRow,
  makeCurrentPullRequestDetail,
  mockBranchCandidateIds,
  now,
  organizationId,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import { mockWithDbCall, mockWithDbTx } from "../../__tests__/utils/db-helpers";
import { branchReadService } from "./branch-read-service";

/**
 * ISS-6127: `toBranchAnalyticsMetrics` is the THIRD `currentFileTotals` call
 * site and the highest-stakes one — it feeds Median PR Size and the LOC/$ pair.
 * It was wired to pass `fileCacheCapped` but nothing pinned it, so deleting the
 * argument left the whole suite green. These live in a sibling file because
 * `branch-read-service.test.ts` is grandfathered and shrink-only.
 */
describe("branchReadService analytics with a capped file cache", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
    mockWithDbTx(mockDb);
    mockDb.commitDetail.findMany.mockResolvedValue([]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);
  });

  function mergedBranchWithCache(fileCacheCapped: boolean) {
    return makeBranchRow({
      status: GitHubPRState.Merged,
      currentPullRequestDetail: makeCurrentPullRequestDetail({
        prState: GitHubPRState.Merged,
        closedAt: now,
        mergedAt: now,
      }),
      fileCacheCapped,
      fileChanges: [
        { additions: 10, deletions: 5, path: "a.ts" },
        { additions: 2, deletions: 3, path: "b.ts" },
      ],
    });
  }

  it("excludes a capped branch from medianPrSize, because its LOC is unknown rather than short", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([mergedBranchWithCache(true)]);

    const response = await branchReadService.getBranchAnalytics(
      organizationId,
      { limit: 10, offset: 0 }
    );

    // Ungated this cache sums to 20 — a confident, short number off a
    // truncated read. Dropping the `fileCacheCapped` argument at the call site
    // turns this assertion red; the control below stays green.
    expect(response.medianPrSize.value).toBeNull();
  });

  it("still medians an uncapped branch of the identical shape, so the guard is not vacuous", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([mergedBranchWithCache(false)]);

    const response = await branchReadService.getBranchAnalytics(
      organizationId,
      { limit: 10, offset: 0 }
    );

    expect(response.medianPrSize.value).toBe(20);
  });
});
