import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ChecksStatus: { UNKNOWN: "UNKNOWN" },
  });
});

vi.mock("@repo/github", async () => {
  const actual =
    await vi.importActual<typeof import("@repo/github")>("@repo/github");
  return {
    ...actual,
    getSinglePullRequestWithProviderResult: vi.fn(),
  };
});

const syncServiceMocks = vi.hoisted(() => ({
  refreshTombstonedBranchPullRequest: vi.fn(),
}));

vi.mock("@/app/integrations/github/sync-service", () => ({
  GitHubServerSyncReason: {
    AlreadyRefreshing: "already_refreshing",
    CredentialDecryptionFailed: "credential_decryption_failed",
    CredentialExpired: "credential_expired",
    CredentialInsufficientScope: "credential_insufficient_scope",
    CredentialRevoked: "credential_revoked",
    CrossUserDenied: "cross_user_denied",
    GuardedWriteFailed: "guarded_write_failed",
    InvalidRepositoryFullName: "invalid_repository_full_name",
    NoActiveRepository: "no_active_repository",
    NoCredential: "no_credential",
    NoCurrentPullRequest: "no_current_pull_request",
    NoEligibleSessionReference: "no_eligible_session_reference",
    NoTombstonedRepository: "no_tombstoned_repository",
    ProviderRateLimited: "provider_rate_limited",
    ProviderUnavailable: "provider_unavailable",
    Success: "success",
    Unsupported: "unsupported",
    Unknown: "unknown",
  },
  GitHubServerSyncStatus: {
    Failed: "failed",
    NotApplicable: "not_applicable",
    Refreshed: "refreshed",
    Retryable: "retryable",
  },
  githubServerSyncService: {
    refreshTombstonedBranchPullRequest:
      syncServiceMocks.refreshTombstonedBranchPullRequest,
  },
}));

const agentSessionsServiceMocks = vi.hoisted(() => ({
  findSessionDetail: vi.fn(),
}));

vi.mock("@/app/agent-sessions/service", () => ({
  agentSessionsService: {
    findSessionDetail: agentSessionsServiceMocks.findSessionDetail,
  },
}));

import { GitHubPRState } from "@repo/api/src/types/github";
import {
  branchId,
  createMockDb,
  makeBranchRow,
  makeCurrentPullRequestDetail,
  mockBranchCandidatePage,
  now,
  organizationId,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import { mockWithDbCall, mockWithDbTx } from "../../__tests__/utils/db-helpers";
import { branchReadService } from "./branch-read-service";

// FEA-4268: the Branches LIST row must show the SAME available changed-LOC the
// detail reports, while the client-side analytics KPIs stay on the file-cache
// basis. This regression lives in a focused sibling file (not the grandfathered
// branch-read-service.test.ts) per the root AGENTS.md shrink-only rule.
describe("branchReadService — FEA-4268 list↔detail LOC reconciliation", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
    mockWithDbTx(mockDb);
    mockDb.commitDetail.findMany.mockResolvedValue([]);
    syncServiceMocks.refreshTombstonedBranchPullRequest.mockResolvedValue({
      status: "failed",
      reason: "no_eligible_session_reference",
    });
  });

  // The production repro was a branch whose own file-cache never synced (empty
  // `fileChanges`) but whose connected PR carried +41/−0 diff stats: the detail
  // resolved the PR backfill and showed 41 lines changed while the list read raw
  // file-cache totals and rendered "—" (a dash). Both DISPLAY surfaces now share
  // the `resolveDetailLoc` precedence, so the list row and the detail reconcile.
  it("reconciles list DISPLAY LOC with detail LOC by backfilling the list from the merged PR diff stats", async () => {
    const prWithDiffStats = makeCurrentPullRequestDetail({
      prState: GitHubPRState.Merged,
      mergedAt: new Date("2026-07-27T09:13:00.000Z"),
      additions: 41,
      deletions: 0,
      changedFiles: 3,
    });
    const branchRow = makeBranchRow({
      status: GitHubPRState.Merged,
      currentPullRequestDetail: prWithDiffStats,
      // No branch file-cache rows → sumFileChanges yields null LOC (the repro):
      // without the backfill the list row would render additions/deletions null.
      fileChanges: [],
    });
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([branchRow]);
    mockDb.artifact.findFirst.mockResolvedValue(branchRow);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const listResponse = await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
    });
    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    const listRow = listResponse.items.find((item) => item.id === branchId);
    expect(listRow).toBeDefined();
    // The list row's DISPLAYED LOC now carries the PR-backfilled value instead of
    // null…
    expect(listRow?.additions).toBe(41);
    expect(listRow?.deletions).toBe(0);
    expect(listRow?.filesChanged).toBe(3);
    // …and reconciles with the detail for the same branch (the FEA-4268 contract).
    expect(listRow?.additions).toBe(detail?.additions);
    expect(listRow?.deletions).toBe(detail?.deletions);
    expect(listRow?.filesChanged).toBe(detail?.filesChanged);

    // …but the FILE-CACHE analytics basis stays null (un-enriched), so the
    // client-side Median-PR-size / Value-per-$ KPIs do NOT treat this PR-backfilled
    // row as file-cache-enriched — preserving parity with the server's
    // `analyticsPullRequestSize` and the desktop producer.
    expect(listRow?.analyticsAdditions).toBeNull();
    expect(listRow?.analyticsDeletions).toBeNull();
  });

  // When the branch's OWN file-cache is enriched, display and analytics agree —
  // both read the file-cache totals (no PR backfill is consulted).
  it("keeps the analytics basis equal to the displayed LOC when the branch file-cache is enriched", async () => {
    const branchRow = makeBranchRow({
      status: GitHubPRState.Merged,
      fileChanges: [
        { path: "a.ts", additions: 12, deletions: 3 },
        { path: "b.ts", additions: 8, deletions: 1 },
      ],
    });
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([branchRow]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const listResponse = await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
    });
    const listRow = listResponse.items.find((item) => item.id === branchId);
    expect(listRow).toBeDefined();
    expect(listRow?.additions).toBe(20);
    expect(listRow?.deletions).toBe(4);
    // Analytics basis matches the display value when the file-cache is enriched.
    expect(listRow?.analyticsAdditions).toBe(20);
    expect(listRow?.analyticsDeletions).toBe(4);
  });
});
