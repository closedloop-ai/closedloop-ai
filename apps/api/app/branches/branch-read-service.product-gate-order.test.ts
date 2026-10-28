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

vi.mock("./tier2-targeted-branch-refresh", () => ({
  isTier2BranchPullRequestRefreshInFlight: vi.fn(() => false),
  refreshResponseFromTier2Outcome: vi.fn(),
  refreshTier2BranchPullRequestOnRead: vi.fn(),
  refreshTier2TargetedBranchPullRequest: vi.fn(),
  shouldRefreshTier2BranchPullRequestOnRead: vi.fn(() => false),
}));

import {
  branchId,
  createMockDb,
  makeBranchRow,
  makeSessionLink,
  mockBranchCandidateIds,
  organizationId,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import { mockWithDbCall, mockWithDbTx } from "../../__tests__/utils/db-helpers";
import { branchReadService } from "./branch-read-service";

/**
 * ISS-7140: the Product gate depends only on (organizationId, branchId), so it
 * is resolved alongside the detail's parallel identity/commit/PR reads rather
 * than after the projection. An ineligible Branch must therefore return null
 * BEFORE the global even-split divisor pager, the activity-segment read, and
 * the phase-attribution projection spend work the handler then discards.
 *
 * This lives in a sibling file because `branch-read-service.test.ts` is
 * grandfathered and shrink-only.
 */
describe("branchReadService detail Product gate ordering", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
    mockWithDbTx(mockDb);
    mockDb.commitDetail.findMany.mockResolvedValue([]);
  });

  function seedLinkedSessionDetail() {
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    mockDb.artifactLink.findMany
      // (1) usage: session s1 links to this branch.
      .mockResolvedValueOnce([makeSessionLink(branchId, "s1", "1.00")])
      // (2) the divisor's branch-count read, reached only past the gate.
      .mockResolvedValueOnce([{ sourceId: "s1", targetId: branchId }]);
  }

  it("returns null before the divisor pager and activity reads when the gate fails", async () => {
    // The two candidate reads inside findBranchArtifact, then the gate.
    mockBranchCandidateIds(mockDb, [branchId]);
    mockBranchCandidateIds(mockDb, [branchId]);
    mockBranchCandidateIds(mockDb, []);
    seedLinkedSessionDetail();

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    expect(detail).toBeNull();
    // Only the identity/usage read ran; the divisor's branch-count read did not.
    expect(mockDb.artifactLink.findMany).toHaveBeenCalledTimes(1);
    expect(mockDb.agentSessionActivitySegment.findMany).not.toHaveBeenCalled();
  });

  it("still runs the divisor pager and activity reads when the gate passes", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);
    mockBranchCandidateIds(mockDb, [branchId]);
    mockBranchCandidateIds(mockDb, [branchId]);
    mockBranchCandidateIds(mockDb, [branchId]);
    seedLinkedSessionDetail();

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    expect(detail).not.toBeNull();
    expect(mockDb.artifactLink.findMany).toHaveBeenCalledTimes(2);
    expect(mockDb.agentSessionActivitySegment.findMany).toHaveBeenCalled();
  });
});
