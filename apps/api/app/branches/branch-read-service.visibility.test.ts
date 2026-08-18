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

// FEA-4311 corpus-visibility/membership cases, split out of the grandfathered
// `branch-read-service.test.ts` (shrink-only) into this focused sibling so
// editing the oversized file does not grow it further. The responsibility here is
// the CORPUS MEMBERSHIP gate: a Branch record is derived from branches observed in
// agent sessions (PRD-510), so a valid linked session is admissible provenance ON
// ITS OWN — a session-observed branch must surface on the list/detail BEFORE any
// push/PR, while a branch with NO valid session (even one carrying remote head
// evidence) stays out of the corpus (FEA-4225 preserved). These drive the same
// `branchReadService.listBranches`/`getBranchDetail` reads off the shared
// `branch-read-service.test-helpers` harness.
describe("branchReadService corpus membership visibility (FEA-4311)", () => {
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

  // FEA-4311: the former "treats pushed branches without sessions as present but
  // without sessions" case was removed. It injected a candidate id (bypassing the
  // membership SQL) for a pushed, ZERO-session branch and asserted it surfaces as
  // NoSessions — a state the candidate SQL (`branchLinkedSessionExistsSql`) now
  // makes production-unreachable: a zero-session branch never becomes a candidate,
  // regardless of push/head-sha evidence. The authoritative exclusion is proven at
  // the candidate-SQL boundary by "keys corpus membership on a linked session …"
  // and "excludes a synced-but-unpushed branch with no linked session" below.

  it("keys corpus membership on a linked session, never head-sha or set-once push evidence (FEA-4311)", async () => {
    mockBranchCandidatePage(mockDb, []);
    mockDb.artifact.findMany.mockResolvedValue([]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
    });

    // FEA-4311: the candidate predicate gates on a VALID LINKED SESSION (the
    // session→branch usage-link EXISTS over session_detail), NOT on remote
    // evidence — so a session-observed branch surfaces BEFORE any push/PR. Remote
    // evidence (first_pushed_at) is no longer part of the corpus membership gate,
    // and the volatile head_sha/head_sha_source (the stale_push trap) never was.
    const sql = branchCandidateSql(mockDb);
    expect(sql).toContain("session_detail sd");
    expect(sql).toContain("al.branch_participation");
    expect(sql).not.toContain("b.first_pushed_at IS NOT NULL");
    expect(sql).not.toContain("head_sha");

    mockDb.artifact.findFirst.mockResolvedValue(null);

    await expect(
      branchReadService.getBranchDetail(organizationId, branchId)
    ).resolves.toBeNull();

    // FEA-4311: the by-id detail lookup scope no longer carries a remote-evidence
    // AND — membership is decided by the shared branchHasLinkedSession twin, so a
    // session-observed, not-yet-pushed branch is readable at its detail URL.
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

  it("excludes a synced-but-unpushed branch with no linked session (FEA-4311: session gate is authoritative)", async () => {
    // PRD-510 D3: a synced row means "observed", not "pushed". FEA-4311 makes a
    // VALID LINKED SESSION the corpus membership gate, so a synced-but-unpushed
    // branch with no session (and no push/PR) is excluded by the candidate SQL —
    // which returns no id — rather than by a redundant in-memory push filter. The
    // empty candidate page models that SQL gate; the hydration read never runs.
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
