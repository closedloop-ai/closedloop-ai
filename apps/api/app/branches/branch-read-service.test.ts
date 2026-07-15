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

import { BranchHeadShaSource } from "@repo/api/src/types/artifact";
import {
  BranchDataState,
  BranchKpiState,
  BranchRefreshReason,
  BranchRefreshStatus,
  BranchStatus,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github";
import { GitHubFetchTrigger } from "@repo/api/src/types/github-read-model";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { ArtifactType, GitHubInstallationStatus } from "@repo/database";
import {
  GitHubProviderResultStatus,
  getSinglePullRequestWithProviderResult,
} from "@repo/github";
import { resolveMockPullRequestDetails } from "../../__tests__/fixtures/branch-pull-request-details";
import {
  getMockWithDb,
  mockWithDbCall,
  mockWithDbTx,
} from "../../__tests__/utils/db-helpers";
import {
  branchListQuerySchema,
  branchReadService,
  branchTraceQuerySchema,
} from "./branch-read-service";
import { BRANCH_CURRENT_PULL_REQUEST_DETAIL_CANDIDATE_LIMIT } from "./branch-remote-evidence";

const branchId = "11111111-1111-4111-8111-111111111111";
const organizationId = "org-1";
const now = new Date("2026-07-03T05:00:00.000Z");
// FEA-3119: the session-link attribution predicate must never key on a
// session's role/author/reviewer — only on the session_pr write-evidence link.
const ROLE_ATTRIBUTION_PATTERN = /role|author|reviewer/i;

describe("branchReadService", () => {
  const mockWithDb = getMockWithDb();
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
    mockWithDbTx(mockDb);
    syncServiceMocks.refreshTombstonedBranchPullRequest.mockResolvedValue({
      status: "failed",
      reason: "no_eligible_session_reference",
    });
  });

  it("lists org-scoped branches and double-scopes session links", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow()]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      {
        targetId: branchId,
        sourceId: "session-artifact-1",
        source: {
          session: {
            artifactId: "session-artifact-1",
            externalSessionId: "session-1",
            harness: "codex",
            sessionStartedAt: now,
            sessionEndedAt: null,
            estimatedCost: { toString: () => "1.25" },
            inputTokens: 10n,
            outputTokens: 20n,
            cacheReadTokens: 30n,
            cacheWriteTokens: 40n,
          },
        },
      },
    ]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
      repository: ["closedloop-ai/symphony-alpha"],
      status: ["open"],
    });

    expect(branchCandidateSql(mockDb)).toContain(
      "pr.repository_id IS NOT DISTINCT FROM b.repository_id"
    );
    expect(mockDb.artifact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          branch: { deletedAt: null },
          id: { in: [branchId] },
          organizationId,
          type: ArtifactType.BRANCH,
        },
      })
    );
    expect(mockDb.artifactLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId,
          targetId: { in: [branchId] },
          metadata: {
            path: ["linkKind"],
            equals: SessionArtifactLinkKind.SessionPr,
          },
          source: { organizationId, type: ArtifactType.SESSION },
          target: { organizationId, type: ArtifactType.BRANCH },
        }),
      })
    );
    expect(response.items[0]).toMatchObject({
      id: branchId,
      dataState: BranchDataState.Ready,
      estimatedCostUsd: 1.25,
      sessionIds: ["session-artifact-1"],
    });
  });

  it("dedups repeated session ids per branch without a linear scan", async () => {
    const sessionLink = {
      targetId: branchId,
      sourceId: "session-artifact-1",
      source: {
        session: {
          artifactId: "session-artifact-1",
          externalSessionId: "session-1",
          harness: "codex",
          sessionStartedAt: now,
          sessionEndedAt: null,
          estimatedCost: { toString: () => "1.25" },
          inputTokens: 10n,
          outputTokens: 20n,
          cacheReadTokens: 30n,
          cacheWriteTokens: 40n,
        },
      },
    };
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow()]);
    // Two links resolving to the same session id must collapse to one entry in
    // sessionIds (regression guard for the O(1) Set-based dedup, FEA-2544).
    mockDb.artifactLink.findMany.mockResolvedValue([sessionLink, sessionLink]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
      repository: ["closedloop-ai/symphony-alpha"],
      status: ["open"],
    });

    expect(response.items[0]).toMatchObject({
      id: branchId,
      sessionIds: ["session-artifact-1"],
    });
  });

  // FEA-3119 (PRD-525 P3, DoD #7/#8): the branch usage rollup must include
  // implementation + code-review + VQA + rework sessions from EVERY contributor
  // who touched the branch id, with NO session dropped and NONE double-counted.
  // Attribution keys on the branch-id write-evidence link (linkKind =
  // session_pr), NOT on the session's role or contributor, so every such linked
  // session is summed. This mock-DB proof covers the Branches-page rollup path
  // (getSessionUsageByBranch); the real-DB attribution-lens proof lives in
  // __tests__/integration/agent-session-attribution.test.ts.
  it("rolls up sessions of every role and contributor without drop or double-count", async () => {
    // Four sessions touching the one branch: implementation + VQA (contributor
    // one) and code-review + rework (contributor two). Each contributes a flat
    // 10/20/30/40 tokens and 1.25 cost, so the branch total is a sum sensitive
    // to any dropped or double-counted session.
    const attributedSessions = [
      { sessionId: "session-impl", role: "implementation", author: "alice" },
      { sessionId: "session-review", role: "code-review", author: "bob" },
      { sessionId: "session-vqa", role: "vqa", author: "alice" },
      { sessionId: "session-rework", role: "rework", author: "bob" },
    ];
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow()]);
    mockDb.artifactLink.findMany.mockResolvedValue(
      attributedSessions.map((session) => ({
        targetId: branchId,
        sourceId: session.sessionId,
        source: {
          session: {
            artifactId: session.sessionId,
            externalSessionId: session.sessionId,
            harness: "codex",
            sessionStartedAt: now,
            sessionEndedAt: null,
            estimatedCost: { toString: () => "1.25" },
            inputTokens: 10n,
            outputTokens: 20n,
            cacheReadTokens: 30n,
            cacheWriteTokens: 40n,
          },
        },
      }))
    );

    const response = await branchReadService.getBranchUsage(organizationId, {
      limit: 50,
      offset: 0,
    });

    // No drop / no double-count: exactly four sessions summed.
    expect(response.totalEstimatedCost).toBeCloseTo(5, 10);
    expect(response.totalInputTokens).toBe(40);
    expect(response.totalOutputTokens).toBe(80);
    expect(response.totalCacheReadTokens).toBe(120);
    expect(response.totalCacheWriteTokens).toBe(160);

    // The attribution predicate keys ONLY on the session_pr write-evidence link
    // — never on the session's role/author — so review/VQA/rework sessions are
    // attributed exactly like the first implementation session, and the display
    // predicate (the candidate-id visibility gate) does not narrow it.
    const linkWhere =
      mockDb.artifactLink.findMany.mock.calls.at(-1)?.[0]?.where;
    expect(linkWhere).toMatchObject({
      metadata: {
        path: ["linkKind"],
        equals: SessionArtifactLinkKind.SessionPr,
      },
    });
    expect(JSON.stringify(linkWhere)).not.toMatch(ROLE_ATTRIBUTION_PATTERN);
  });

  it("accepts shared branch query keys and rejects unsupported statuses", () => {
    expect(
      branchListQuerySchema.parse({
        endDate: "2026-07-03T23:59:59.000Z",
        projectId: "project-1",
        repo: "closedloop-ai/symphony-alpha",
        search: "feature",
        startDate: "2026-07-03T00:00:00.000Z",
        status: BranchStatus.Open,
      })
    ).toMatchObject({
      endDate: new Date("2026-07-03T23:59:59.000Z"),
      projectId: ["project-1"],
      repo: ["closedloop-ai/symphony-alpha"],
      search: "feature",
      startDate: new Date("2026-07-03T00:00:00.000Z"),
      status: [BranchStatus.Open],
    });
    expect(
      branchListQuerySchema.safeParse({ status: BranchStatus.Blocked }).success
    ).toBe(false);
  });

  it("rejects branch list filters that are not implemented by branch predicates", () => {
    expect(branchListQuerySchema.safeParse({ owner: "alice" }).success).toBe(
      false
    );
    expect(branchListQuerySchema.safeParse({ userId: "user-1" }).success).toBe(
      false
    );
    expect(branchListQuerySchema.safeParse({ teamId: "team-1" }).success).toBe(
      false
    );
  });

  it("defaults trace expansion to fifty rows and caps at one hundred rows", () => {
    expect(branchTraceQuerySchema.parse({}).limit).toBe(50);
    expect(branchTraceQuerySchema.parse({ limit: 100 }).limit).toBe(100);
    expect(branchTraceQuerySchema.safeParse({ limit: 101 }).success).toBe(
      false
    );
  });

  describe("getBranchTrace", () => {
    function mockLinkedSessions(ids: string[]) {
      mockDb.artifact.findFirst.mockResolvedValue(
        makeBranchRow({ firstPushedAt: now })
      );
      mockDb.artifactLink.findMany.mockResolvedValue(
        ids.map((id) => ({
          sourceId: id,
          source: { session: { artifactId: id } },
        }))
      );
      // Each session hydrates through findSessionDetail; empty turnItems yields
      // exactly one synthesized sessionstart, staggered by start time so the
      // k-way merge order is deterministic.
      const byId = new Map(
        ids.map((id, index) => [
          id,
          {
            id,
            name: `session ${id}`,
            primaryModel: null,
            model: null,
            harness: "claude",
            startedAt: new Date(now.getTime() + index * 60_000),
            turnItems: [],
          },
        ])
      );
      agentSessionsServiceMocks.findSessionDetail.mockImplementation(
        ({ id }: { id: string }) => Promise.resolve(byId.get(id) ?? null)
      );
    }

    it("interleaves one sessionstart per linked session, chronologically", async () => {
      mockLinkedSessions(["sess-a", "sess-b", "sess-c"]);

      const response = await branchReadService.getBranchTrace(
        organizationId,
        branchId,
        { limit: 50, offset: 0 }
      );

      expect(response?.viewerScope).toBe(BranchViewerScope.Organization);
      expect(
        response?.items.map((item) => [item.type, item.sessionId])
      ).toEqual([
        ["sessionstart", "sess-a"],
        ["sessionstart", "sess-b"],
        ["sessionstart", "sess-c"],
      ]);
      expect(response?.hasMore).toBe(false);
      expect(agentSessionsServiceMocks.findSessionDetail).toHaveBeenCalledWith({
        id: "sess-a",
        organizationId,
      });
    });

    it("pages the merged items by offset/limit and reports hasMore", async () => {
      mockLinkedSessions(["sess-a", "sess-b", "sess-c"]);

      const response = await branchReadService.getBranchTrace(
        organizationId,
        branchId,
        { limit: 1, offset: 1 }
      );

      expect(response?.items).toHaveLength(1);
      expect(response?.items[0]).toMatchObject({
        type: "sessionstart",
        sessionId: "sess-b",
      });
      expect(response?.hasMore).toBe(true);
    });

    it("returns null without hydrating sessions when the branch is not visible", async () => {
      mockDb.artifact.findFirst.mockResolvedValue(null);

      const response = await branchReadService.getBranchTrace(
        organizationId,
        branchId,
        { limit: 50, offset: 0 }
      );

      expect(response).toBeNull();
      expect(
        agentSessionsServiceMocks.findSessionDetail
      ).not.toHaveBeenCalled();
    });
  });

  it("filters search and date windows through supported scoped branch predicates", async () => {
    mockDb.artifact.findMany.mockResolvedValue([]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
      search: "branches-api",
      startDate: new Date("2026-07-01T00:00:00.000Z"),
      endDate: new Date("2026-07-03T00:00:00.000Z"),
    });

    const sql = branchCandidateSql(mockDb);
    expect(sql).toContain("b.last_activity_at >=");
    expect(sql).toContain("b.last_activity_at <=");
    expect(sql).toContain("pr.title ILIKE");
    expect(sql).toContain(
      "pr.repository_id IS NOT DISTINCT FROM b.repository_id"
    );
  });

  it("applies project filters to branch list predicates", async () => {
    mockDb.artifact.findMany.mockResolvedValue([]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
      projectId: ["project-1", "project-2"],
    });

    expect(branchCandidateSql(mockDb)).toContain("a.project_id IN");
  });

  it("filters draft status through the same PR draft field used by row mapping", async () => {
    mockDb.artifact.findMany.mockResolvedValue([]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
      status: [BranchStatus.Draft],
    });

    const sql = branchCandidateSql(mockDb);
    expect(sql).toContain("pr.is_draft = TRUE");
    expect(sql).toContain(
      "pr.repository_id IS NOT DISTINCT FROM b.repository_id"
    );
  });

  it("unions repeated status filters using emitted BranchRow status semantics", async () => {
    mockDb.artifact.findMany.mockResolvedValue([]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
      status: [BranchStatus.Draft, BranchStatus.Open],
    });

    const sql = branchCandidateSql(mockDb);
    expect(sql).toContain(" OR ");
    expect(sql).toContain("pr.is_draft = TRUE");
    expect(sql).toContain("pr.pr_state NOT IN");
  });

  it("filters merged status from connected PR evidence before stale artifact status", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        status: GitHubPRState.Open,
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          prState: GitHubPRState.Merged,
          mergedAt: now,
        }),
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
      status: [BranchStatus.Merged],
    });

    const sql = branchCandidateSql(mockDb);
    expect(sql).toContain("pr.pr_state =");
    expect(sql).toContain("pr.merged_at IS NOT NULL");
    expect(response.items[0]?.status).toBe(BranchStatus.Merged);
  });

  it("treats connected non-merged PR evidence as open when artifact status is stale merged", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        status: GitHubPRState.Merged,
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          prState: GitHubPRState.Open,
          mergedAt: null,
        }),
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
      status: [BranchStatus.Open],
    });

    expect(response.items[0]?.status).toBe(BranchStatus.Open);
  });

  it("treats connected closed PR evidence as closed when artifact status is stale open", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        status: GitHubPRState.Open,
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          prState: GitHubPRState.Closed,
          closedAt: now,
          mergedAt: null,
        }),
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
      status: [BranchStatus.Closed],
    });

    const sql = branchCandidateSql(mockDb);
    expect(sql).toContain("pr.pr_state =");
    expect(sql).toContain("pr.merged_at IS NULL");
    expect(response.items[0]?.status).toBe(BranchStatus.Closed);
  });

  it("keeps stale artifact-closed rows in the closed filter when PR evidence is open", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        status: GitHubPRState.Closed,
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          prState: GitHubPRState.Open,
          mergedAt: null,
        }),
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
      status: [BranchStatus.Closed],
    });

    expect(response.items[0]?.status).toBe(BranchStatus.Closed);
  });

  it("emits initial-load data states for list and detail DTOs", async () => {
    const awaitingSyncBranchId = "22222222-2222-4222-8222-222222222222";
    const noSessionsBranchId = "33333333-3333-4333-8333-333333333333";
    mockBranchCandidatePage(mockDb, [
      branchId,
      awaitingSyncBranchId,
      noSessionsBranchId,
    ]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        id: branchId,
        currentPullRequestDetail: null,
        headSha: null,
        headShaSource: null,
      }),
      makeBranchRow({
        id: awaitingSyncBranchId,
        syncStatus: "syncing",
        lastSyncCompletedAt: null,
      }),
      makeBranchRow({
        id: noSessionsBranchId,
      }),
    ]);
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({
        id: noSessionsBranchId,
      })
    );
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const listResponse = await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
    });
    const detailResponse = await branchReadService.getBranchDetail(
      organizationId,
      noSessionsBranchId
    );

    expect(listResponse.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: awaitingSyncBranchId,
          dataState: BranchDataState.AwaitingSync,
        }),
        expect.objectContaining({
          id: noSessionsBranchId,
          dataState: BranchDataState.NoSessions,
        }),
      ])
    );
    expect(detailResponse).toMatchObject({
      id: noSessionsBranchId,
      dataState: BranchDataState.NoSessions,
    });
  });

  it("treats pushed branches without sessions as present but without sessions", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        currentPullRequestDetail: null,
        firstPushedAt: now,
        headSha: "pushed-head",
        headShaSource: BranchHeadShaSource.PushWebhook,
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
    });

    expect(response.items[0]).toMatchObject({
      id: branchId,
      dataState: BranchDataState.NoSessions,
      prNumber: null,
      sessionIds: [],
    });
  });

  it("keys visibility on set-once push state, never head-sha evidence", async () => {
    mockBranchCandidatePage(mockDb, []);
    mockDb.artifact.findMany.mockResolvedValue([]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
    });

    // FR12: the candidate predicate gates on the explicit set-once push-state
    // column, never the volatile head_sha/head_sha_source (the stale_push trap).
    // A synced-but-unpushed head — incl. an explicit-sync head — has no
    // first_pushed_at, so it never surfaces.
    const sql = branchCandidateSql(mockDb);
    expect(sql).toContain("b.first_pushed_at IS NOT NULL");
    expect(sql).not.toContain("head_sha");

    mockDb.artifact.findFirst.mockResolvedValue(null);

    await expect(
      branchReadService.getBranchDetail(organizationId, branchId)
    ).resolves.toBeNull();

    const detailWhere = mockDb.artifact.findFirst.mock.calls[0]?.[0]?.where as {
      AND?: [
        {
          OR?: [unknown, { branch?: { firstPushedAt?: { not?: null } } }];
        },
      ];
    };
    expect(detailWhere.AND?.[0]?.OR?.[1]?.branch?.firstPushedAt).toEqual({
      not: null,
    });
  });

  it("surfaces a non-App branch (no installation repo) once it has push state", async () => {
    // PRD-510 D2/FR8 + FR12: a desktop-pushed branch in a non-App repo has no
    // github_installation_repositories row (repositoryId null). The candidate
    // scan no longer inner-joins that table, and visibility keys on
    // firstPushedAt, so the branch surfaces with its D2 repositoryFullName even
    // though no installation repo exists.
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        currentPullRequestDetail: null,
        repositoryId: null,
        repositoryFullName: "octocat/private-fork",
        firstPushedAt: now,
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
    });

    // The candidate FROM clause must not join the installation-repo table, or
    // the non-App branch would be dropped.
    expect(branchCandidateSql(mockDb)).not.toContain(
      "github_installation_repositories"
    );
    expect(response.items).toHaveLength(1);
    expect(response.items[0]).toMatchObject({
      id: branchId,
      repoFullName: "octocat/private-fork",
      prNumber: null,
    });
  });

  it("excludes a synced-but-unpushed branch with no current PR", async () => {
    // PRD-510 D3: a synced row means "observed", not "pushed". Without push
    // state or a current PR, the branch is filtered out of every list/aggregate.
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        currentPullRequestDetail: null,
        firstPushedAt: null,
        headSha: "observed-head",
        headShaSource: BranchHeadShaSource.ExplicitSync,
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
    });

    expect(response.items).toEqual([]);
  });

  it("ignores stale current PR pointers when push state makes a branch visible", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          branchArtifactId: branchId,
          repositoryId: "repo-2",
          number: 42,
          title: "Foreign PR",
        }),
        firstPushedAt: now,
        headSha: "pushed-head",
        headShaSource: BranchHeadShaSource.PushWebhook,
        pullRequestDetails: [],
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
    });

    expect(response.items[0]).toMatchObject({
      dataState: BranchDataState.NoSessions,
      prNumber: null,
      prTitle: null,
      prUrl: null,
      sessionIds: [],
    });
  });

  it("uses branch-owned current PR rows when the current pointer is stale", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          branchArtifactId: branchId,
          repositoryId: "repo-2",
          number: 42,
          title: "Foreign PR",
        }),
        pullRequestDetails: [
          makeCurrentPullRequestDetail({
            id: "foreign-fallback-pr-detail",
            repositoryId: "repo-2",
            number: 99,
            title: "Foreign fallback PR",
          }),
          makeCurrentPullRequestDetail({
            id: "owned-pr-detail",
            number: 17,
            title: "Owned PR",
          }),
        ],
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
    });

    expect(response.items[0]).toMatchObject({
      dataState: BranchDataState.NoSessions,
      prNumber: 17,
      prTitle: "Owned PR",
    });
    expect(mockDb.artifact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          pullRequestDetails: expect.objectContaining({
            orderBy: [
              { repositoryId: "asc" },
              { number: "desc" },
              { id: "asc" },
            ],
            take: BRANCH_CURRENT_PULL_REQUEST_DETAIL_CANDIDATE_LIMIT,
          }),
        }),
      })
    );
  });

  it("keeps remote branch evidence composed with status and search filters", async () => {
    mockDb.artifact.findMany.mockResolvedValue([]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
      search: "feature",
      status: [BranchStatus.Open],
    });

    const sql = branchCandidateSql(mockDb);
    expect(sql).toContain("b.first_pushed_at IS NOT NULL");
    expect(sql).toContain("pr.pr_state NOT IN");
    expect(sql).toContain("a.name ILIKE");
    expect(sql).toContain(
      "pr.repository_id IS NOT DISTINCT FROM b.repository_id"
    );
  });

  it("uses the pushed-only predicate for usage and analytics reads", async () => {
    // Both reads aggregate over the full filtered corpus via
    // getBranchCandidateIds, so each issues a single candidate-id query.
    mockBranchCandidateIds(mockDb, []);
    mockBranchCandidateIds(mockDb, []);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    await branchReadService.getBranchUsage(organizationId, {
      limit: 10,
      offset: 0,
    });
    await branchReadService.getBranchAnalytics(organizationId, {
      limit: 10,
      offset: 0,
    });

    const sql = branchCandidateSql(mockDb);
    expect(sql).toContain("b.first_pushed_at IS NOT NULL");
    expect(sql).toContain(
      "pr.repository_id IS NOT DISTINCT FROM b.repository_id"
    );
  });

  it("aggregates usage over the full filtered set without paginating", async () => {
    // FEA-2539: a usage summary covers the entire filtered corpus, so it takes
    // the full-set getBranchCandidateIds path (no LIMIT/OFFSET) rather than the
    // paginated list page. Otherwise orgs with more than one page of branches
    // undercount their token/cost totals and totalBranches.
    const secondBranchId = "22222222-2222-4222-8222-222222222222";
    mockBranchCandidateIds(mockDb, [branchId, secondBranchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({ id: branchId }),
      makeBranchRow({ id: secondBranchId }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const response = await branchReadService.getBranchUsage(organizationId, {
      limit: 7,
      offset: 14,
    });

    const sql = branchCandidateSql(mockDb);
    expect(sql).not.toContain("LIMIT");
    expect(sql).not.toContain("OFFSET");
    expect(branchCandidateValues(mockDb)).not.toEqual(
      expect.arrayContaining([7, 14])
    );
    expect(mockDb.artifact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          branch: { deletedAt: null },
          id: { in: [branchId, secondBranchId] },
          organizationId,
          type: ArtifactType.BRANCH,
        },
      })
    );
    expect(mockDb.artifactLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          targetId: { in: [branchId, secondBranchId] },
        }),
      })
    );
    expect(response.totalBranches).toBe(2);
  });

  it("returns zero usage totals for an empty corpus", async () => {
    mockDb.artifact.findMany.mockResolvedValue([]);

    const response = await branchReadService.getBranchUsage(organizationId, {
      limit: 10,
      offset: 0,
    });

    expect(response).toMatchObject({
      viewerScope: BranchViewerScope.Organization,
      totalBranches: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalEstimatedCost: 0,
      apiEstimatedCost: 0,
      subscriptionEstimatedCost: 0,
      byActor: [
        {
          owner: null,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          estimatedCostUsd: 0,
        },
      ],
    });
    expect(mockDb.artifactLink.findMany).not.toHaveBeenCalled();
  });

  it("calculates median PR size from additions plus deletions", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        status: GitHubPRState.Merged,
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          prState: GitHubPRState.Merged,
          closedAt: now,
          mergedAt: now,
          additions: 35,
          deletions: 7,
        }),
        fileChanges: [
          { additions: 10, deletions: 5, path: "a.ts" },
          { additions: 2, deletions: 3, path: "b.ts" },
        ],
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const response = await branchReadService.getBranchAnalytics(
      organizationId,
      { limit: 10, offset: 0 }
    );

    expect(response.medianPrSize.value).toBe(42);
    expect(mockDb.artifact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          branch: { deletedAt: null },
          id: { in: [branchId] },
          organizationId,
          type: ArtifactType.BRANCH,
        },
      })
    );
  });

  it("falls back to branch LOC when migrated PR LOC fields are still null", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        status: GitHubPRState.Merged,
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          prState: GitHubPRState.Merged,
          closedAt: now,
          mergedAt: now,
          additions: null,
          deletions: null,
        }),
        fileChanges: [
          { additions: 10, deletions: 5, path: "a.ts" },
          { additions: 2, deletions: 3, path: "b.ts" },
        ],
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const response = await branchReadService.getBranchAnalytics(
      organizationId,
      { limit: 10, offset: 0 }
    );

    expect(response.medianPrSize.value).toBe(20);
  });

  it("falls back to branch LOC when migrated PR LOC fields are partial", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        status: GitHubPRState.Merged,
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          prState: GitHubPRState.Merged,
          closedAt: now,
          mergedAt: now,
          additions: 35,
          deletions: null,
        }),
        fileChanges: [
          { additions: 10, deletions: 5, path: "a.ts" },
          { additions: 2, deletions: 3, path: "b.ts" },
        ],
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const response = await branchReadService.getBranchAnalytics(
      organizationId,
      { limit: 10, offset: 0 }
    );

    expect(response.medianPrSize.value).toBe(20);
  });

  it("calculates median PR size from the full filtered corpus, not the requested page", async () => {
    const pagedOpenBranchId = "22222222-2222-4222-8222-222222222222";
    const hiddenMergedBranchId = "33333333-3333-4333-8333-333333333333";
    mockBranchCandidateIds(mockDb, [pagedOpenBranchId, hiddenMergedBranchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        id: pagedOpenBranchId,
        status: GitHubPRState.Open,
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          branchArtifactId: pagedOpenBranchId,
          prState: GitHubPRState.Open,
          additions: 5,
          deletions: 5,
        }),
      }),
      makeBranchRow({
        id: hiddenMergedBranchId,
        status: GitHubPRState.Merged,
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          branchArtifactId: hiddenMergedBranchId,
          prState: GitHubPRState.Merged,
          mergedAt: now,
          additions: 80,
          deletions: 20,
        }),
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const response = await branchReadService.getBranchAnalytics(
      organizationId,
      { limit: 1, offset: 0 }
    );

    expect(response.medianPrSize.value).toBe(100);
    expect(branchCandidateSql(mockDb)).not.toContain("LIMIT");
    expect(branchCandidateSql(mockDb)).not.toContain("OFFSET");
  });

  it("reports merge rate as a percentage for summary card consumers", async () => {
    const openBranchId = "22222222-2222-4222-8222-222222222222";
    mockBranchCandidateIds(mockDb, [branchId, openBranchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        id: branchId,
        status: GitHubPRState.Merged,
        firstPushedAt: now,
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          prState: GitHubPRState.Merged,
          mergedAt: now,
        }),
      }),
      makeBranchRow({
        id: openBranchId,
        status: GitHubPRState.Open,
        firstPushedAt: now,
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          branchArtifactId: openBranchId,
          prState: GitHubPRState.Open,
          mergedAt: null,
        }),
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const response = await branchReadService.getBranchAnalytics(
      organizationId,
      { limit: 10, offset: 0 }
    );

    expect(response.mergeRate).toMatchObject({
      value: 50,
      state: BranchKpiState.Available,
    });
  });

  it('counts "Merged PRs" by latest MERGED PR state for cross-surface parity (FEA-3089)', async () => {
    // A branch merged with NO connected MERGED PR state (local-status merge, no
    // owned PR → prState null) derives status === Merged, but its latest PR state
    // is not MERGED. The shared BranchAnalytics card's "Merged PRs" count must
    // match the desktop producer, which counts prState === "MERGED" (FEA-2997),
    // so this branch is excluded from mergedCount while a truly MERGED PR is
    // counted. It still contributes to the STATUS-based merge rate numerator.
    const mergedPrBranchId = "22222222-2222-4222-8222-222222222222";
    const statusMergedNoPrBranchId = "33333333-3333-4333-8333-333333333333";
    mockBranchCandidateIds(mockDb, [
      mergedPrBranchId,
      statusMergedNoPrBranchId,
    ]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        id: mergedPrBranchId,
        status: GitHubPRState.Merged,
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          branchArtifactId: mergedPrBranchId,
          prState: GitHubPRState.Merged,
          mergedAt: now,
        }),
      }),
      makeBranchRow({
        id: statusMergedNoPrBranchId,
        status: GitHubPRState.Merged,
        currentPullRequestDetail: null,
        // FR12 push-state visibility (firstPushedAt): without it, this branch
        // has neither an owned current PR nor push evidence, so
        // hasVisibleBranchAnalyticsRow filters it out before the KPI fold — the
        // test would then pass vacuously over a single visible branch. Making it
        // visible is what lets branchCount reach 2 and actually distinguishes
        // mergedStatusCount (2) from mergedPrCount (1).
        firstPushedAt: now,
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const response = await branchReadService.getBranchAnalytics(
      organizationId,
      { limit: 10, offset: 0 }
    );

    // Only the branch with a MERGED latest PR state is a "Merged PR".
    expect(response.mergedCount).toMatchObject({
      value: 1,
      state: BranchKpiState.Available,
    });
    // The merge RATE numerator stays status-based over the whole corpus: both
    // branches are status === Merged, so the rate is 100% (unchanged behavior).
    expect(response.mergeRate).toMatchObject({
      value: 100,
      state: BranchKpiState.Available,
    });
  });

  it("reads the branch corpus with the narrowed analytics select", async () => {
    // FEA-2741: analytics KPIs only need branch status, the owned current PR's
    // state/size, and per-branch LOC — not the repository/installation/checks or
    // the full pull-request-detail tree. Materializing the heavy branch select
    // for the entire filtered corpus just to feed aggregates is the regression
    // this guards against.
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({ status: GitHubPRState.Merged }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    await branchReadService.getBranchAnalytics(organizationId, {
      limit: 10,
      offset: 0,
    });

    const select = mockDb.artifact.findMany.mock.calls.at(-1)?.[0]?.select;
    // The heavy relation tree must be absent from the analytics read.
    expect(select?.branch?.select?.repository).toBeUndefined();
    expect(select?.branch?.select?.checksStatus).toBeUndefined();
    expect(select?.pullRequestDetails?.select?.htmlUrl).toBeUndefined();
    expect(select?.pullRequestDetails?.select?.body).toBeUndefined();
    // The KPI inputs the narrowed select still needs must remain present.
    expect(select?.status).toBe(true);
    expect(select?.pullRequestDetails?.select?.prState).toBe(true);
    expect(select?.branch?.select?.fileChanges?.select?.additions).toBe(true);
    expect(select?.branch?.select?.firstPushedAt).toBe(true);
  });

  it("chunks the full-corpus session-link lookup instead of one unbounded IN", async () => {
    // FEA-2538: the analytics read passes the entire filtered branch set to
    // getSessionUsageByBranch. It must bound the `targetId IN (...)` list by
    // querying in chunks (SESSION_USAGE_BRANCH_ID_CHUNK_SIZE = 1000) rather
    // than a single unbounded findMany, while still aggregating over all ids.
    const chunkSize = 1000;
    const ids = Array.from(
      { length: chunkSize + 1 },
      (_, index) => `branch-${index}`
    );
    mockBranchCandidateIds(mockDb, ids);
    mockDb.artifact.findMany.mockResolvedValue(
      ids.map((id) => makeBranchRow({ id }))
    );
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    await branchReadService.getBranchAnalytics(organizationId, {
      limit: 10,
      offset: 0,
    });

    expect(mockDb.artifactLink.findMany).toHaveBeenCalledTimes(2);
    expect(mockDb.artifactLink.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          targetId: { in: ids.slice(0, chunkSize) },
        }),
      })
    );
    expect(mockDb.artifactLink.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          targetId: { in: ids.slice(chunkSize) },
        }),
      })
    );
  });

  it("returns unavailable analytics KPIs for an empty corpus", async () => {
    mockBranchCandidateIds(mockDb, []);
    mockDb.artifact.findMany.mockResolvedValue([]);

    const response = await branchReadService.getBranchAnalytics(
      organizationId,
      { limit: 10, offset: 0 }
    );

    expect(response).toMatchObject({
      viewerScope: BranchViewerScope.Organization,
      medianPrSize: { value: null, state: BranchKpiState.Unavailable },
      mergeRate: { value: null, state: BranchKpiState.Unavailable },
      locPerDollar: { value: null, state: BranchKpiState.Unavailable },
      totalSpendUsd: { value: null, state: BranchKpiState.Unavailable },
      mergedCount: { value: 0, state: BranchKpiState.Available },
      activeBranchCount: { value: 0, state: BranchKpiState.Available },
    });
    expect(mockDb.artifactLink.findMany).not.toHaveBeenCalled();
  });

  it("keeps zero-denominator analytics KPIs unavailable", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        fileChanges: [{ additions: 10, deletions: 5, path: "a.ts" }],
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const response = await branchReadService.getBranchAnalytics(
      organizationId,
      { limit: 10, offset: 0 }
    );

    expect(response.locPerDollar).toMatchObject({
      value: null,
      state: BranchKpiState.Unavailable,
    });
    expect(response.totalSpendUsd).toMatchObject({
      value: null,
      state: BranchKpiState.Unavailable,
    });
  });

  it("rejects encoded branch ids before database or provider work", async () => {
    const response = await branchReadService.refreshBranch(
      organizationId,
      "closedloop-ai%2Fsymphony-alpha::feature",
      { userId: "user-1", authMethod: "api_key" }
    );

    expect(response.reason).toBe(BranchRefreshReason.InvalidBranchId);
    expect(mockWithDb).not.toHaveBeenCalled();
    expect(getSinglePullRequestWithProviderResult).not.toHaveBeenCalled();
  });

  it("returns not applicable without budget or provider work when no current PR exists", async () => {
    // Visible via push state (firstPushedAt) but carrying no current PR — the
    // exact branch a refresh should short-circuit as NotApplicable.
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({ currentPullRequestDetail: null, firstPushedAt: now })
    );

    const response = await branchReadService.refreshBranch(
      organizationId,
      branchId,
      { userId: "user-1", authMethod: "session" }
    );

    expect(response.reason).toBe(BranchRefreshReason.NoCurrentPullRequest);
    expect(mockDb.oAuthRateLimit.findUnique).not.toHaveBeenCalled();
    expect(getSinglePullRequestWithProviderResult).not.toHaveBeenCalled();
  });

  it("does not refresh tombstoned branch repositories", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({ repositoryRemovedAt: new Date("2026-07-05T12:00:00Z") })
    );
    mockDb.artifactLink.findMany.mockResolvedValue([]);
    mockDb.oAuthRateLimit.findUnique.mockResolvedValue(null);
    mockDb.oAuthRateLimit.create.mockResolvedValue({});

    const response = await branchReadService.refreshBranch(
      organizationId,
      branchId,
      { userId: "user-1", authMethod: "session" }
    );

    expect(response).toMatchObject({
      status: BranchRefreshStatus.Failed,
      reason: BranchRefreshReason.NotFound,
      branch: { id: branchId, prState: GitHubPRState.Open },
    });
    expect(mockDb.oAuthRateLimit.create).toHaveBeenCalledTimes(2);
    expect(mockDb.pullRequestDetail.updateMany).not.toHaveBeenCalled();
    expect(getSinglePullRequestWithProviderResult).not.toHaveBeenCalled();
    expect(
      syncServiceMocks.refreshTombstonedBranchPullRequest
    ).toHaveBeenCalledWith({
      actorUserId: "user-1",
      branchArtifactId: branchId,
      organizationId,
      trigger: GitHubFetchTrigger.UserAction,
    });
  });

  it("does not invoke tombstoned sync when refresh budget is exhausted", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({ repositoryRemovedAt: new Date("2026-07-05T12:00:00Z") })
    );
    mockDb.oAuthRateLimit.findUnique.mockResolvedValue({
      id: "actor-bucket",
      windowExpiresAt: new Date(now.getTime() + 30_000),
      requestCount: 5,
    });
    mockDb.oAuthRateLimit.updateMany.mockResolvedValue({ count: 0 });

    const response = await branchReadService.refreshBranch(
      organizationId,
      branchId,
      { userId: "user-1", authMethod: "session" }
    );

    expect(response).toMatchObject({
      status: BranchRefreshStatus.Retryable,
      reason: BranchRefreshReason.BudgetExhausted,
      retryAfterSeconds: 30,
    });
    expect(
      syncServiceMocks.refreshTombstonedBranchPullRequest
    ).not.toHaveBeenCalled();
    expect(getSinglePullRequestWithProviderResult).not.toHaveBeenCalled();
  });

  it("does not stamp API-key tombstoned refreshes as user actions", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({ repositoryRemovedAt: new Date("2026-07-05T12:00:00Z") })
    );
    mockDb.oAuthRateLimit.findUnique.mockResolvedValue(null);
    mockDb.oAuthRateLimit.create.mockResolvedValue({});

    await branchReadService.refreshBranch(organizationId, branchId, {
      userId: "user-1",
      authMethod: "api_key",
    });

    expect(
      syncServiceMocks.refreshTombstonedBranchPullRequest
    ).toHaveBeenCalledWith({
      actorUserId: "user-1",
      branchArtifactId: branchId,
      organizationId,
      trigger: GitHubFetchTrigger.Unknown,
    });
  });

  it("maps tombstoned owner-token rate limits to retryable refresh", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({ repositoryRemovedAt: new Date("2026-07-05T12:00:00Z") })
    );
    mockDb.artifactLink.findMany.mockResolvedValue([]);
    mockDb.oAuthRateLimit.findUnique.mockResolvedValue(null);
    mockDb.oAuthRateLimit.create.mockResolvedValue({});
    syncServiceMocks.refreshTombstonedBranchPullRequest.mockResolvedValueOnce({
      status: "retryable",
      reason: "provider_rate_limited",
      retryAfterSeconds: 45,
    });

    const response = await branchReadService.refreshBranch(
      organizationId,
      branchId,
      { userId: "user-1", authMethod: "session" }
    );

    expect(response).toMatchObject({
      status: BranchRefreshStatus.Retryable,
      reason: BranchRefreshReason.ProviderRateLimited,
      retryAfterSeconds: 45,
    });
    expect(mockDb.oAuthRateLimit.create).toHaveBeenCalledTimes(2);
    expect(getSinglePullRequestWithProviderResult).not.toHaveBeenCalled();
  });

  it("claims the current PR before provider work and settles only allowed fields", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    mockDb.oAuthRateLimit.findUnique.mockResolvedValue(null);
    mockDb.oAuthRateLimit.create.mockResolvedValue({});
    mockDb.pullRequestDetail.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    mockDb.artifactLink.findMany.mockResolvedValue([]);
    vi.mocked(getSinglePullRequestWithProviderResult).mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: {
        githubId: "pr-gh-1",
        number: 7,
        title: "Refresh me",
        htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/7",
        headBranch: "feature",
        baseBranch: "main",
        state: GitHubPRState.Merged,
        mergedAt: "2026-07-03T05:01:00.000Z",
        closedAt: "2026-07-03T05:01:00.000Z",
        authorLogin: "octocat",
        isDraft: false,
        headSha: "def",
        baseSha: "abc",
        mergeCommitSha: "merge-sha",
        additions: 33,
        deletions: 7,
        changedFiles: 4,
      },
    });

    const response = await branchReadService.refreshBranch(
      organizationId,
      branchId,
      { userId: "user-1", authMethod: "session" }
    );

    expect(response.status).toBe("refreshed");
    expect(mockDb.oAuthRateLimit.create).toHaveBeenCalledTimes(2);
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          id: "pr-detail-1",
          branchArtifactId: branchId,
          repository: {
            removedAt: null,
            installation: {
              organizationId,
              status: GitHubInstallationStatus.ACTIVE,
            },
          },
          OR: [
            { lastRefreshAttemptAt: null },
            { lastRefreshAttemptAt: { lt: new Date(now.getTime() - 30_000) } },
          ],
        }),
        data: { lastRefreshAttemptAt: now },
      })
    );
    expect(getSinglePullRequestWithProviderResult).toHaveBeenCalledWith(
      "installation-1",
      "closedloop-ai",
      "symphony-alpha",
      7
    );
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: {
          prState: GitHubPRState.Merged,
          mergedAt: new Date("2026-07-03T05:01:00.000Z"),
          closedAt: new Date("2026-07-03T05:01:00.000Z"),
          isDraft: false,
          additions: 33,
          deletions: 7,
          changedFiles: 4,
          lastVerifiedAt: now,
        },
      })
    );
    expect(mockDb.artifact.updateMany).not.toHaveBeenCalled();
    expect(mockDb.branchDetail.updateMany).not.toHaveBeenCalled();
    expect(mockDb.branchStatusCheck.deleteMany).not.toHaveBeenCalled();
  });

  it("returns provider rate-limit as retryable stale DTO without settlement writes", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    mockDb.oAuthRateLimit.findUnique.mockResolvedValue(null);
    mockDb.oAuthRateLimit.create.mockResolvedValue({});
    mockDb.pullRequestDetail.updateMany.mockResolvedValueOnce({ count: 1 });
    vi.mocked(getSinglePullRequestWithProviderResult).mockResolvedValue({
      status: GitHubProviderResultStatus.ProviderRateLimit,
      retryAfterSeconds: 45,
    });

    const response = await branchReadService.refreshBranch(
      organizationId,
      branchId,
      { userId: "user-1", authMethod: "session" }
    );

    expect(response).toMatchObject({
      status: BranchRefreshStatus.Retryable,
      reason: BranchRefreshReason.ProviderRateLimited,
      retryAfterSeconds: 45,
      branch: { id: branchId, prState: GitHubPRState.Open },
    });
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenCalledTimes(1);
    expect(mockDb.artifact.updateMany).not.toHaveBeenCalled();
    expect(mockDb.branchDetail.updateMany).not.toHaveBeenCalled();
    expect(mockDb.branchStatusCheck.deleteMany).not.toHaveBeenCalled();
  });

  it("returns provider unavailable as retryable stale DTO without settlement writes", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    mockDb.oAuthRateLimit.findUnique.mockResolvedValue(null);
    mockDb.oAuthRateLimit.create.mockResolvedValue({});
    mockDb.pullRequestDetail.updateMany.mockResolvedValueOnce({ count: 1 });
    vi.mocked(getSinglePullRequestWithProviderResult).mockResolvedValue({
      status: GitHubProviderResultStatus.ProviderUnavailable,
    });

    const response = await branchReadService.refreshBranch(
      organizationId,
      branchId,
      { userId: "user-1", authMethod: "session" }
    );

    expect(response).toMatchObject({
      status: BranchRefreshStatus.Retryable,
      reason: BranchRefreshReason.ProviderUnavailable,
      branch: { id: branchId, prState: GitHubPRState.Open },
    });
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenCalledTimes(1);
    expect(mockDb.artifact.updateMany).not.toHaveBeenCalled();
    expect(mockDb.branchDetail.updateMany).not.toHaveBeenCalled();
  });

  it("returns guarded write failure when provider settlement loses its scoped write", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    mockDb.oAuthRateLimit.findUnique.mockResolvedValue(null);
    mockDb.oAuthRateLimit.create.mockResolvedValue({});
    mockDb.pullRequestDetail.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    vi.mocked(getSinglePullRequestWithProviderResult).mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: {
        githubId: "pr-gh-1",
        number: 7,
        title: "Refresh me",
        htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/7",
        headBranch: "feature",
        baseBranch: "main",
        state: GitHubPRState.Merged,
        mergedAt: "2026-07-03T05:01:00.000Z",
        closedAt: "2026-07-03T05:01:00.000Z",
        authorLogin: "octocat",
        isDraft: false,
        headSha: "def",
        baseSha: "abc",
        mergeCommitSha: "merge-sha",
      },
    });

    const response = await branchReadService.refreshBranch(
      organizationId,
      branchId,
      { userId: "user-1", authMethod: "session" }
    );

    expect(response).toMatchObject({
      status: BranchRefreshStatus.Failed,
      reason: BranchRefreshReason.GuardedWriteFailed,
      branch: { id: branchId },
    });
    expect(mockDb.artifact.updateMany).not.toHaveBeenCalled();
    expect(mockDb.branchDetail.updateMany).not.toHaveBeenCalled();
  });

  it("claims null and stale refresh windows but rejects fresh claims before provider work", async () => {
    mockDb.artifact.findFirst.mockResolvedValueOnce(
      makeBranchRow({
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          lastRefreshAttemptAt: null,
        }),
      })
    );
    mockDb.oAuthRateLimit.findUnique.mockResolvedValue(null);
    mockDb.oAuthRateLimit.create.mockResolvedValue({});
    mockDb.pullRequestDetail.updateMany.mockResolvedValueOnce({ count: 1 });
    vi.mocked(getSinglePullRequestWithProviderResult).mockResolvedValueOnce({
      status: GitHubProviderResultStatus.ProviderUnavailable,
    });

    await branchReadService.refreshBranch(organizationId, branchId, {
      userId: "user-1",
      authMethod: "session",
    });

    mockDb.artifact.findFirst.mockResolvedValueOnce(
      makeBranchRow({
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          lastRefreshAttemptAt: new Date(now.getTime() - 30_001),
        }),
      })
    );
    mockDb.pullRequestDetail.updateMany.mockResolvedValueOnce({ count: 1 });
    vi.mocked(getSinglePullRequestWithProviderResult).mockResolvedValueOnce({
      status: GitHubProviderResultStatus.ProviderUnavailable,
    });

    await branchReadService.refreshBranch(organizationId, branchId, {
      userId: "user-1",
      authMethod: "session",
    });

    mockDb.artifact.findFirst.mockResolvedValueOnce(
      makeBranchRow({
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          lastRefreshAttemptAt: new Date(now.getTime() - 29_999),
        }),
      })
    );
    mockDb.pullRequestDetail.updateMany.mockResolvedValueOnce({ count: 0 });

    const freshResponse = await branchReadService.refreshBranch(
      organizationId,
      branchId,
      { userId: "user-1", authMethod: "session" }
    );

    expect(freshResponse).toMatchObject({
      status: BranchRefreshStatus.Retryable,
      reason: BranchRefreshReason.AlreadyRefreshing,
      retryAfterSeconds: 30,
    });
    expect(getSinglePullRequestWithProviderResult).toHaveBeenCalledTimes(2);
    expect(mockDb.pullRequestDetail.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { lastRefreshAttemptAt: null },
            { lastRefreshAttemptAt: { lt: new Date(now.getTime() - 30_000) } },
          ],
        }),
      })
    );
  });

  it("does not consume org budget when actor budget is exhausted", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    mockDb.oAuthRateLimit.findUnique.mockResolvedValue({
      id: "actor-bucket",
      windowExpiresAt: new Date(now.getTime() + 30_000),
      requestCount: 5,
    });
    mockDb.oAuthRateLimit.updateMany.mockResolvedValue({ count: 0 });

    const response = await branchReadService.refreshBranch(
      organizationId,
      branchId,
      { userId: "user-1", authMethod: "session" }
    );

    expect(response).toMatchObject({
      status: BranchRefreshStatus.Retryable,
      reason: BranchRefreshReason.BudgetExhausted,
      retryAfterSeconds: 30,
    });
    expect(mockDb.oAuthRateLimit.findUnique).toHaveBeenCalledTimes(1);
    expect(mockDb.oAuthRateLimit.findUnique).toHaveBeenCalledWith({
      where: {
        bucket_subject: {
          bucket: "branch_refresh:actor",
          subject: "org-1:session:user-1",
        },
      },
    });
    expect(getSinglePullRequestWithProviderResult).not.toHaveBeenCalled();
  });

  it("recovers refresh budget creation races in a fresh transaction", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    mockDb.oAuthRateLimit.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "actor-bucket",
        windowExpiresAt: new Date(now.getTime() + 30_000),
        requestCount: 1,
      })
      .mockResolvedValueOnce(null);
    mockDb.oAuthRateLimit.create
      .mockRejectedValueOnce(
        Object.assign(new Error("race"), { code: "P2002" })
      )
      .mockResolvedValueOnce({});
    mockDb.oAuthRateLimit.updateMany.mockResolvedValue({ count: 1 });
    mockDb.pullRequestDetail.updateMany.mockResolvedValue({ count: 0 });

    const response = await branchReadService.refreshBranch(
      organizationId,
      branchId,
      { userId: "user-1", authMethod: "session" }
    );

    expect(response).toMatchObject({
      status: BranchRefreshStatus.Retryable,
      reason: BranchRefreshReason.AlreadyRefreshing,
    });
    expect(mockWithDb.tx).toHaveBeenCalledTimes(3);
    expect(mockDb.oAuthRateLimit.create).toHaveBeenCalledTimes(2);
    expect(getSinglePullRequestWithProviderResult).not.toHaveBeenCalled();
  });
});

function createMockDb() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    artifact: {
      count: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    artifactLink: {
      findMany: vi.fn(),
    },
    branchDetail: {
      updateMany: vi.fn(),
    },
    branchStatusCheck: {
      deleteMany: vi.fn(),
    },
    commentThread: {
      findMany: vi.fn(),
    },
    oAuthRateLimit: {
      findUnique: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    pullRequestDetail: {
      updateMany: vi.fn(),
    },
  };
}

function mockBranchCandidatePage(
  mockDb: ReturnType<typeof createMockDb>,
  ids: string[],
  total = ids.length
) {
  mockDb.$queryRaw
    .mockResolvedValueOnce([{ count: BigInt(total) }])
    .mockResolvedValueOnce(ids.map((id) => ({ id })));
}

function mockBranchCandidateIds(
  mockDb: ReturnType<typeof createMockDb>,
  ids: string[]
) {
  mockDb.$queryRaw.mockResolvedValueOnce(ids.map((id) => ({ id })));
}

function branchCandidateSql(mockDb: ReturnType<typeof createMockDb>): string {
  return mockDb.$queryRaw.mock.calls
    .map((call) => renderSql(call[0]))
    .join("\n");
}

function branchCandidateValues(
  mockDb: ReturnType<typeof createMockDb>
): unknown[] {
  return mockDb.$queryRaw.mock.calls.flatMap((call) =>
    collectSqlValues(call[0])
  );
}

function makeBranchRow(
  overrides: {
    id?: string;
    currentPullRequestDetail?: MockPrDetail | null;
    fileChanges?: { additions: number; deletions: number; path: string }[];
    firstPushedAt?: Date | null;
    headSha?: string | null;
    headShaSource?: BranchHeadShaSource | null;
    lastSyncCompletedAt?: Date | null;
    pullRequestDetails?: MockPrDetail[];
    // `null` models a non-App branch (PRD-510 D2/FR8): no installation-repo row,
    // identity carried solely by repositoryFullName.
    repositoryId?: string | null;
    repositoryFullName?: string;
    repositoryRemovedAt?: Date | null;
    status?: string;
    syncStatus?: string;
  } = {}
) {
  const id = overrides.id ?? branchId;
  const repositoryId =
    "repositoryId" in overrides ? overrides.repositoryId : "repo-1";
  const repositoryFullName =
    overrides.repositoryFullName ?? "closedloop-ai/symphony-alpha";
  const currentPullRequestDetail =
    "currentPullRequestDetail" in overrides
      ? overrides.currentPullRequestDetail
      : makeCurrentPullRequestDetail({
          branchArtifactId: id,
          repositoryId: repositoryId ?? undefined,
        });
  const pullRequestDetails = resolveMockPullRequestDetails(
    overrides,
    currentPullRequestDetail
  );
  return {
    id,
    // Top-level Artifact.organizationId — the org SSOT the by-id branch reads
    // assert against (FEA-2734). Defaults to the owning org so resolver mocks
    // pass resolveOrgScope(); cross-org cases override it explicitly.
    organizationId,
    name: "feature",
    status: overrides.status ?? GitHubPRState.Open,
    externalUrl: null,
    createdAt: now,
    branch: {
      artifactId: id,
      repositoryId,
      repositoryFullName,
      branchName: "feature",
      baseBranch: "main",
      headSha: "headSha" in overrides ? overrides.headSha : "abc",
      headShaSource:
        "headShaSource" in overrides
          ? overrides.headShaSource
          : BranchHeadShaSource.PushWebhook,
      // FR12 visibility SSOT — default null (unpushed); tests opt into push
      // visibility explicitly, mirroring the set-once producer stamp.
      firstPushedAt:
        "firstPushedAt" in overrides ? overrides.firstPushedAt : null,
      lastActivityAt: now,
      syncStatus: overrides.syncStatus ?? "idle",
      lastSyncStartedAt: null,
      lastSyncCompletedAt: overrides.lastSyncCompletedAt ?? null,
      lastSyncErrorCode: null,
      checksStatus: "UNKNOWN",
      checksDetailTotalCount: 0,
      currentPullRequestDetailId: currentPullRequestDetail
        ? "pr-detail-1"
        : null,
      repository: repositoryId
        ? {
            id: repositoryId,
            fullName: "closedloop-ai/symphony-alpha",
            name: "symphony-alpha",
            owner: "closedloop-ai",
            removedAt: overrides.repositoryRemovedAt ?? null,
            installation: {
              organizationId,
              installationId: "installation-1",
              status: GitHubInstallationStatus.ACTIVE,
            },
          }
        : null,
      currentPullRequestDetail,
      fileChanges: overrides.fileChanges ?? [],
    },
    pullRequestDetails,
  };
}

function makeCurrentPullRequestDetail(overrides: Partial<MockPrDetail> = {}) {
  return { ...makeBaseCurrentPullRequestDetail(), ...overrides };
}

function makeBaseCurrentPullRequestDetail(): MockPrDetail {
  return {
    id: "pr-detail-1",
    branchArtifactId: branchId,
    repositoryId: "repo-1",
    isCurrent: true,
    number: 7,
    title: "PR title",
    htmlUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/7",
    body: "body",
    prState: GitHubPRState.Open,
    isDraft: false,
    additions: null,
    deletions: null,
    changedFiles: null,
    reviewDecision: null,
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: null,
    lastVerifiedAt: null,
    lastRefreshAttemptAt: null,
  };
}

type MockPrDetail = {
  id: string;
  branchArtifactId: string;
  repositoryId: string;
  isCurrent: boolean;
  number: number;
  title: string;
  htmlUrl: string;
  body: string;
  prState: GitHubPRState;
  isDraft: boolean;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  reviewDecision: null;
  closedAt: Date | null;
  mergedAt: Date | null;
  mergeCommitSha: string | null;
  lastVerifiedAt: Date | null;
  lastRefreshAttemptAt: Date | null;
};

function renderSql(value: unknown): string {
  if (!isMockSql(value)) {
    return String(value);
  }
  if (value.separator !== undefined) {
    return (value.values ?? [])
      .map((item) => renderSql(item))
      .join(value.separator);
  }
  return value.strings
    .map((sqlPart, index) => {
      const nested = value.values?.[index];
      return nested === undefined ? sqlPart : `${sqlPart}${renderSql(nested)}`;
    })
    .join("");
}

function collectSqlValues(value: unknown): unknown[] {
  if (!isMockSql(value)) {
    return [value];
  }
  return (value.values ?? []).flatMap((item) => collectSqlValues(item));
}

function isMockSql(value: unknown): value is MockSql {
  return (
    typeof value === "object" &&
    value !== null &&
    "strings" in value &&
    Array.isArray((value as { strings?: unknown }).strings)
  );
}

type MockSql = {
  separator?: string;
  strings: readonly string[];
  values?: readonly unknown[];
};
