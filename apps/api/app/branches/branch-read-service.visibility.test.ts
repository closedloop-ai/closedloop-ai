import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    NoEligibleSessionReference: "no_eligible_session_reference",
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

import { ArtifactType } from "@repo/database";
import {
  branchCandidateSql,
  branchId,
  createMockDb,
  makeBranchRow,
  makeSessionLink,
  mockBranchCandidatePage,
  now,
  organizationId,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import { mockWithDbCall, mockWithDbTx } from "../../__tests__/utils/db-helpers";
import { branchReadService } from "./branch-read-service";

afterEach(() => {
  vi.useRealTimers();
});

// Product Branch corpus-visibility/membership cases, split out of the grandfathered
// `branch-read-service.test.ts` (shrink-only) into this focused sibling so
// editing the oversized file does not grow it further. The responsibility here is
// the CORPUS MEMBERSHIP gate: Product visibility requires both explicit Wrote
// evidence and verified publication for the same canonical Branch. Either class
// alone remains internal evidence and stays out of Product reads. These drive the same
// `branchReadService.listBranches`/`getBranchDetail` reads off the shared
// `branch-read-service.test-helpers` harness.
describe("branchReadService Product corpus membership visibility (ISS-6541)", () => {
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

  // A zero-session Branch never becomes a Product candidate regardless of
  // publication/head evidence; a Session-only Branch also remains internal.

  it("composes explicit Wrote with verified publication and never infers either from head sha", async () => {
    mockBranchCandidatePage(mockDb, []);
    mockDb.artifact.findMany.mockResolvedValue([]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
    });

    const sql = branchCandidateSql(mockDb);
    expect(sql).toContain("session_detail sd");
    expect(sql).toContain("al.branch_participation = wrote");
    expect(sql).toContain("b.first_pushed_at IS NOT NULL");
    expect(sql).toContain("b.push_source IN");
    expect(sql).toContain("FROM pull_request_detail published_pr");
    expect(sql).toContain("published_pr.head_ref_name");
    expect(sql).not.toContain("head_sha");

    mockDb.artifact.findFirst.mockResolvedValue(null);

    await expect(
      branchReadService.getBranchDetail(organizationId, branchId)
    ).resolves.toBeNull();

    // The ORM hydration remains organization scoped; the shared SQL candidate
    // gate has already denied any row missing either evidence class.
    const detailWhere = mockDb.artifact.findFirst.mock.calls[0]?.[0]?.where as {
      AND?: unknown;
      type?: string;
      organizationId?: string;
    };
    expect(detailWhere.AND).toBeUndefined();
    expect(detailWhere.type).toBe(ArtifactType.BRANCH);
    expect(detailWhere.organizationId).toBe(organizationId);
  });

  it("keeps non-App identity eligible through exact public-repository authority", async () => {
    // ISS-5827 preserves the repo-less D2 identity path without making an
    // installation row mandatory: the canonical authority predicate considers
    // an exact organization-scoped PublicRepository observation as well.
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        currentPullRequestDetail: null,
        repositoryId: null,
        repositoryFullName: "octocat/private-fork",
        firstPushedAt: null,
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makeSessionLink(branchId, "s-nonapp", "0.00"),
    ]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
    });

    expect(branchCandidateSql(mockDb)).toContain("public_repositories");
    expect(response.items).toHaveLength(1);
    expect(response.items[0]).toMatchObject({
      id: branchId,
      repoFullName: "octocat/private-fork",
      prNumber: null,
      sessionIds: ["s-nonapp"],
    });
  });

  it("excludes a synced Branch with neither Wrote nor publication evidence", async () => {
    // PRD-510 D3: a synced row means observed, not published. The empty
    // candidate page models the SQL gate; hydration never runs.
    mockBranchCandidatePage(mockDb, []);
    mockDb.artifact.findMany.mockResolvedValue([]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
    });

    expect(response.items).toEqual([]);
    // The membership gate lives in the candidate SQL (session-link EXISTS), so
    // the row-hydration read is never issued for an excluded branch.
    expect(mockDb.artifact.findMany).not.toHaveBeenCalled();
  });
});
