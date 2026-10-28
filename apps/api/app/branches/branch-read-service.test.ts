import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SessionPrLinkAudience,
  sessionPrLinkKindWhere,
} from "@/lib/session-pr-links";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ChecksStatus: { UNKNOWN: "UNKNOWN" },
  });
});

const sessionDetailReadMocks = vi.hoisted(() => ({
  readAgentSessionDetailInputs: vi.fn(),
  projectAgentSessionDetail: vi.fn(),
}));

vi.mock("@/app/agent-sessions/service/session-detail-read", () => ({
  readAgentSessionDetailInputs:
    sessionDetailReadMocks.readAgentSessionDetailInputs,
  projectAgentSessionDetail: sessionDetailReadMocks.projectAgentSessionDetail,
}));

import { BranchHeadShaSource } from "@repo/api/src/types/artifact";
import {
  BRANCH_CONTRIBUTOR_USER_ID_PARAM,
  BranchDataState,
  BranchKpiState,
  BranchLifecycleBoundaryKind,
  BranchLifecyclePhase,
  BranchLinkedArtifactEvidenceKind,
  BranchParticipationKind,
  BranchStatus,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import { BranchAssociatedPullRequestCompletenessState } from "@repo/api/src/types/branch-associated-pull-request";
import { ReviewDecision } from "@repo/api/src/types/branch-checks";
import {
  BranchPhaseAttributionCompleteness,
  BranchPhaseAttributionCompletenessReason,
  BranchVisibleLifecyclePhase,
} from "@repo/api/src/types/branch-phase-attribution";
import { GitHubPRState } from "@repo/api/src/types/github";
import {
  ArtifactRefRelation,
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { ArtifactType } from "@repo/database";
import { rollupBranchActivity } from "@repo/lib/branches/activity-rollup";
import {
  branchCandidateSql,
  branchId,
  branchProjectId,
  collectSqlValues,
  contributorUserId,
  createMockDb,
  makeBranchRow,
  makeCurrentPullRequestDetail,
  makeReview,
  makeSessionLink,
  makeSuccessfulReviewSessionLink,
  mockBranchCandidateIds,
  mockBranchCandidatePage,
  mockCandidateSnapshotRow,
  mockDetailCandidateSnapshots,
  now,
  organizationId,
  renderSql,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import { mockWithDbCall, mockWithDbTx } from "../../__tests__/utils/db-helpers";
import { branchListQuerySchema } from "./branch-list-query";
import { branchReadService } from "./branch-read-service";

const ROLE_ATTRIBUTION_PATTERN = /role|author|reviewer/i;
const OLD_BRANCH_CANDIDATE_PAGE_LIMIT_PATTERN = /\bLIMIT\s+500\b/;

describe("branchReadService", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ now });
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
    mockWithDbTx(mockDb);
    mockDb.commitDetail.findMany.mockResolvedValue([]);
    return () => vi.useRealTimers();
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
      repository: ["closedloop-ai/closedloop-ai"],
      status: ["open"],
    });

    expect(branchCandidateSql(mockDb)).toContain(
      "prd.branch_artifact_id = a.id"
    );
    expect(mockDb.artifact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          branch: { isNot: null },
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
          AND: expect.arrayContaining([
            {
              OR: expect.arrayContaining([
                sessionPrLinkKindWhere(SessionPrLinkAudience.Metric),
                {
                  metadata: {
                    path: ["linkKind"],
                    equals: SessionArtifactLinkKind.SessionBranch,
                  },
                },
              ]),
            },
            {
              OR: expect.arrayContaining([
                { branchParticipation: BranchParticipationKind.Wrote },
                { branchParticipation: null },
              ]),
            },
          ]),
          source: {
            organizationId,
            session: { isNot: null },
            type: ArtifactType.SESSION,
          },
          target: { organizationId, type: ArtifactType.BRANCH },
        }),
      })
    );
    expect(response.items[0]).toMatchObject({
      id: branchId,
      dataState: BranchDataState.Ready,
      estimatedCostUsd: 1.25,
      projectId: branchProjectId,
      sessionIds: ["session-artifact-1"],
      canonicalLastActiveAt: expect.any(Object),
    });
  });

  it("omits metadata-reviewed legacy links from default list usage", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow()]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makeSessionLink(
        branchId,
        "review-session",
        "1.25",
        "reviewer-user",
        reviewedBranchMetadata()
      ),
    ]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
      repository: ["closedloop-ai/closedloop-ai"],
      status: ["open"],
    });

    expect(response.items[0]).toMatchObject({
      id: branchId,
      estimatedCostUsd: null,
      sessionIds: [],
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
      repository: ["closedloop-ai/closedloop-ai"],
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

    // The attribution predicate keys on persisted session artifact links —
    // never on the session's role/author — so review/VQA/rework sessions are
    // attributed exactly like the first implementation session, and the display
    // predicate (the candidate-id visibility gate) does not narrow it.
    const linkWhere =
      mockDb.artifactLink.findMany.mock.calls.at(-1)?.[0]?.where;
    expect(linkWhere).toMatchObject({
      AND: expect.arrayContaining([
        {
          OR: expect.arrayContaining([
            sessionPrLinkKindWhere(SessionPrLinkAudience.Metric),
            {
              metadata: {
                path: ["linkKind"],
                equals: SessionArtifactLinkKind.SessionBranch,
              },
            },
          ]),
        },
        {
          OR: expect.arrayContaining([
            { branchParticipation: BranchParticipationKind.Wrote },
            { branchParticipation: null },
          ]),
        },
      ]),
    });
    expect(JSON.stringify(linkWhere)).not.toMatch(ROLE_ATTRIBUTION_PATTERN);
  });

  it("accepts shared branch query keys and rejects unsupported statuses", () => {
    expect(
      branchListQuerySchema.parse({
        endDate: "2026-07-03T23:59:59.000Z",
        projectId: "project-1",
        repo: "closedloop-ai/closedloop-ai",
        search: "feature",
        startDate: "2026-07-03T00:00:00.000Z",
        status: BranchStatus.Open,
        [BRANCH_CONTRIBUTOR_USER_ID_PARAM]: contributorUserId,
      })
    ).toMatchObject({
      contributorUserId,
      endDate: new Date("2026-07-03T23:59:59.000Z"),
      projectId: ["project-1"],
      repo: ["closedloop-ai/closedloop-ai"],
      search: "feature",
      startDate: new Date("2026-07-03T00:00:00.000Z"),
      status: [BranchStatus.Open],
    });
    expect(
      branchListQuerySchema.safeParse({ status: BranchStatus.Blocked }).success
    ).toBe(false);
    expect(
      branchListQuerySchema.safeParse({
        [BRANCH_CONTRIBUTOR_USER_ID_PARAM]: "user-1",
      }).success
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
    expect(sql).toContain("session_activity.last_activity_at\n  ) IS NULL");
    expect(sql).toContain("session_activity.last_activity_at\n  ) >=");
    expect(sql).toContain("session_activity.last_activity_at\n  ) <=");
    expect(sql).not.toContain("b.last_activity_at");
    expect(sql).not.toContain("COALESCE(b.last_activity_at, a.created_at)");
    expect(sql).toContain("DESC NULLS LAST");
    expect(sql).toContain("pr.title ILIKE");
    expect(sql).toContain("pr.id =");
    expect(sql).toContain("prd.branch_artifact_id = a.id");
    expect(sql).not.toContain("is_current");
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

  it("filters contributor branches through active-write participation links", async () => {
    mockDb.artifact.findMany.mockResolvedValue([]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
      contributorUserId,
    });

    const sql = branchCandidateSql(mockDb);
    expect(sql).toContain("FROM artifact_links al");
    expect(sql).toContain("session_detail sd");
    expect(sql).toContain("al.branch_participation");
    expect(sql).toContain("branchParticipation");
    expect(sql).toContain("branchLifecycleEvents");
    expect(sql).toContain("relationTypes");
    expect(branchCandidateValues(mockDb)).toEqual(
      expect.arrayContaining([
        contributorUserId,
        BranchParticipationKind.Wrote,
        BranchParticipationKind.Reviewed,
        SessionPrRelationType.Created,
        SessionPrRelationType.Reviewed,
        ArtifactRefRelation.Created,
        ArtifactRefRelation.Output,
        BranchLifecycleBoundaryKind.ReviewFeedback,
      ])
    );
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
    expect(sql).toContain("pr.id =");
    expect(sql).not.toContain("is_current");
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

  // FEA-3552: the branch detail's `openedAt` (the timeline's "PR opened" dot
  // anchor) now comes from the persisted `PullRequestDetail.githubCreatedAt`, NOT
  // the old hardcoded null. A distinct createdAt < mergedAt gives the rail both an
  // Opened dot (at createdAt) and a separate Merged dot (at mergedAt).
  it("surfaces the persisted PR createdAt as openedAt on the branch detail", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          githubCreatedAt: new Date("2026-07-03T04:00:00.000Z"),
          mergedAt: new Date("2026-07-03T09:13:00.000Z"),
        }),
      })
    );
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    expect(detail?.openedAt).toBe("2026-07-03T04:00:00.000Z");
    expect(detail?.mergedAt).toBe("2026-07-03T09:13:00.000Z");
  });

  // FEA-4229: a merged branch whose own file-cache never synced (no fileChanges)
  // must NOT render the Value-per-$ card as a bare dash. When the connected PR
  // detail carries diff stats, the detail backfills additions/deletions from the
  // PR so Value-per-$ can compute. (This is the detail view only — the analytics
  // median stays on the file-cache basis, covered above.)
  it("backfills detail LOC from the merged PR diff stats when the file cache is un-enriched", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({
        status: GitHubPRState.Merged,
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          prState: GitHubPRState.Merged,
          mergedAt: new Date("2026-07-03T09:13:00.000Z"),
          additions: 35,
          deletions: 7,
          changedFiles: 4,
        }),
        // No branch file-cache rows → the fold yields null LOC (the repro).
        fileChanges: [],
      })
    );
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    expect(detail?.additions).toBe(35);
    expect(detail?.deletions).toBe(7);
    expect(detail?.filesChanged).toBe(4);
  });

  // FEA-4268 list↔detail LOC reconciliation lives in the focused sibling
  // `branch-list-loc-reconciliation.test.ts`; the LOC precedence permutations are
  // pure-helper unit tests in `branch-loc.test.ts`.

  // FEA-3552: back-compat — a historical PR row with no persisted createdAt keeps
  // openedAt null (no fabricated opened dot), never falling back to merge time.
  it("leaves openedAt null when the PR row has no persisted createdAt", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          githubCreatedAt: null,
          mergedAt: new Date("2026-07-03T09:13:00.000Z"),
        }),
      })
    );
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    expect(detail?.openedAt).toBeNull();
    expect(detail?.mergedAt).toBe("2026-07-03T09:13:00.000Z");
  });

  // The branch-detail per-branch cost is EVEN-SPLIT across the branches each
  // session touched, matching the desktop producer so the branch-detail cost +
  // Value-per-$ cards read identically on both surfaces. `getBranchDetail` makes
  // two artifactLink.findMany reads: (1) this branch's session usage, (2) the
  // sessions' GLOBAL branch counts (the even-split divisor) — sequenced here.
  it("even-splits the detail cost by the session's global branch count", async () => {
    const otherBranchId = "22222222-2222-4222-8222-222222222222";
    mockDetailCandidateSnapshots(mockDb, [branchId, otherBranchId]);
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    mockDb.artifactLink.findMany
      // (1) usage: session s1 links to THIS branch, full captured cost $1.00.
      .mockResolvedValueOnce([makeSessionLink(branchId, "s1", "1.00")])
      // (2) branch counts: s1 wrote to this branch AND one other → divisor 2.
      .mockResolvedValueOnce([
        { sourceId: "s1", targetId: branchId },
        { sourceId: "s1", targetId: otherBranchId },
      ]);

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    expect(detail?.estimatedCostUsd).toBeCloseTo(1, 10);
    expect(detail?.attributedCostUsd).toBeCloseTo(0.5, 10);

    // The divisor read keys on the same session-link kinds as the usage query by
    // SOURCE session, org-scoped, with NO single-branch targetId filter (it must
    // see every branch the session touched).
    const countWhere = mockDb.artifactLink.findMany.mock.calls[1]?.[0]?.where;
    expect(countWhere).toMatchObject({
      organizationId,
      sourceId: { in: ["s1"] },
      AND: expect.arrayContaining([
        {
          OR: expect.arrayContaining([
            sessionPrLinkKindWhere(SessionPrLinkAudience.Metric),
            {
              metadata: {
                path: ["linkKind"],
                equals: SessionArtifactLinkKind.SessionBranch,
              },
            },
          ]),
        },
        {
          OR: expect.arrayContaining([
            { branchParticipation: BranchParticipationKind.Wrote },
            { branchParticipation: null },
          ]),
        },
      ]),
    });
    expect(countWhere).not.toHaveProperty("targetId");
  });

  it("does not count metadata-reviewed legacy links in the even-split divisor", async () => {
    const reviewedBranchId = "22222222-2222-4222-8222-222222222222";
    mockDetailCandidateSnapshots(mockDb, [branchId, reviewedBranchId]);
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    mockDb.artifactLink.findMany
      .mockResolvedValueOnce([makeSessionLink(branchId, "s1", "1.00")])
      .mockResolvedValueOnce([
        {
          sourceId: "s1",
          targetId: branchId,
          branchParticipation: BranchParticipationKind.Wrote,
          metadata: { linkKind: SessionArtifactLinkKind.SessionBranch },
        },
        {
          sourceId: "s1",
          targetId: reviewedBranchId,
          branchParticipation: null,
          metadata: reviewedBranchMetadata(),
        },
      ]);

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    expect(detail?.estimatedCostUsd).toBeCloseTo(1, 10);
    expect(detail?.attributedCostUsd).toBeCloseTo(1, 10);
  });

  it("even-splits cost across pure session_branch links when no PR link exists", async () => {
    const siblingBranchId = "22222222-2222-4222-8222-222222222222";
    mockDetailCandidateSnapshots(mockDb, [branchId, siblingBranchId]);
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    mockDb.artifactLink.findMany
      .mockResolvedValueOnce([
        makeSessionLink(branchId, "s1", "1.00", null, {
          linkKind: SessionArtifactLinkKind.SessionBranch,
        }),
      ])
      .mockResolvedValueOnce([
        { sourceId: "s1", targetId: branchId },
        { sourceId: "s1", targetId: siblingBranchId },
      ]);

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    expect(detail?.estimatedCostUsd).toBeCloseTo(1, 10);
    expect(detail?.attributedCostUsd).toBeCloseTo(0.5, 10);
    expect(
      mockDb.artifactLink.findMany.mock.calls[1]?.[0]?.where
    ).toMatchObject({
      organizationId,
      source: { organizationId, type: ArtifactType.SESSION },
      target: { organizationId, type: ArtifactType.BRANCH },
    });
  });

  it("keeps the full session cost when the session touched only this branch", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    mockDb.artifactLink.findMany
      .mockResolvedValueOnce([makeSessionLink(branchId, "s1", "1.00")])
      // s1 wrote to this branch only → divisor 1, cost unchanged.
      .mockResolvedValueOnce([{ sourceId: "s1", targetId: branchId }]);

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    expect(detail?.estimatedCostUsd).toBeCloseTo(1, 10);
    expect(detail?.attributedCostUsd).toBeCloseTo(1, 10);
  });

  // ISS-8148 (PRD-683 D7): candidates are publication-gated; every
  // candidate-fed sibling joins the 1/N split. Candidate eligibility itself is
  // pinned by `branch-candidate-read.test.ts`; this pins the arithmetic.
  it("counts every denominator-candidate sibling in the even-split divisor", async () => {
    const sessionOnlySiblingId = "22222222-2222-4222-8222-222222222222";
    mockDetailCandidateSnapshots(mockDb, [branchId, sessionOnlySiblingId]);
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    mockDb.artifactLink.findMany
      // (1) usage: s1 links to THIS branch, full captured cost $1.00.
      .mockResolvedValueOnce([makeSessionLink(branchId, "s1", "1.00")])
      // (2) divisor: s1 wrote to this Product Branch and one unpublished sibling.
      .mockResolvedValueOnce([
        { sourceId: "s1", targetId: branchId },
        { sourceId: "s1", targetId: sessionOnlySiblingId },
      ]);

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    expect(detail?.estimatedCostUsd).toBeCloseTo(1, 10);
    expect(detail?.attributedCostUsd).toBeCloseTo(0.5, 10);

    // The divisor read's target must be scoped to a non-deleted BRANCH only — no
    // push-evidence / current-PR co-requirement that would exclude session-only
    // siblings.
    const countWhere = mockDb.artifactLink.findMany.mock.calls[1]?.[0]?.where;
    expect(countWhere?.target).toEqual({
      organizationId,
      type: ArtifactType.BRANCH,
      branch: { isNot: null },
    });
  });

  it("projects phaseSegments from linked-session lifecycle metadata", async () => {
    const pullRequest = makeCurrentPullRequestDetail({
      githubCreatedAt: new Date("2026-07-03T05:01:00.000Z"),
    });
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({
        currentPullRequestDetail: pullRequest,
        pullRequestDetails: [pullRequest],
      })
    );
    mockDb.artifactLink.findMany
      .mockResolvedValueOnce([
        makeSessionLink(
          branchId,
          "s1",
          "1.00",
          null,
          {
            linkKind: SessionArtifactLinkKind.SessionPr,
            method: "git_push",
            branchLifecycleEvents: [
              {
                kind: BranchLifecycleBoundaryKind.PrRaised,
                observedAt: "2026-07-03T05:01:00.000Z",
                evidenceId: "desktop-artifact-link:pr",
              },
              {
                kind: BranchLifecycleBoundaryKind.ReviewFeedback,
                observedAt: "2026-07-03T05:02:00.000Z",
                evidenceId: "desktop-artifact-link:review",
              },
              {
                kind: BranchLifecycleBoundaryKind.BranchWrite,
                observedAt: "2026-07-03T05:03:00.000Z",
                evidenceId: "desktop-artifact-link:push",
              },
            ],
          },
          BranchParticipationKind.Wrote,
          { sessionEndedAt: new Date("2026-07-03T05:04:00.000Z") }
        ),
      ])
      .mockResolvedValueOnce([{ sourceId: "s1", targetId: branchId }]);
    mockDb.agentSessionActivitySegment.findMany.mockResolvedValue([
      activitySegmentRow("s1", "plan", "05:00:00", "05:01:30"),
      activitySegmentRow("s1", "other", "05:01:30", "05:02:30"),
      activitySegmentRow("s1", "idle", "05:02:30", "05:04:00"),
    ]);
    mockDb.agentSessionTokenEvent.findMany.mockResolvedValue([
      phaseTokenEvent("s1", "05:01:00", 0.2),
      phaseTokenEvent("s1", "05:02:00", 0.3),
      phaseTokenEvent("s1", "05:03:00", 0.5),
    ]);

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    expect(
      detail?.sessions[0]?.phaseSegments?.map((segment) => segment.phase)
    ).toEqual([
      BranchLifecyclePhase.Build,
      BranchLifecyclePhase.Review,
      BranchLifecyclePhase.Rework,
    ]);
    expect(detail?.lifecyclePhaseStacks).toEqual([
      expect.objectContaining({
        phase: BranchLifecyclePhase.Build,
        sessionCount: 1,
      }),
      expect.objectContaining({
        phase: BranchLifecyclePhase.Review,
        sessionCount: 1,
      }),
      expect.objectContaining({
        phase: BranchLifecyclePhase.Rework,
        sessionCount: 1,
      }),
    ]);
    expect(
      detail?.phaseAttribution?.segments.map((segment) => segment.phase)
    ).toEqual([
      BranchVisibleLifecyclePhase.Build,
      BranchVisibleLifecyclePhase.Review,
      BranchVisibleLifecyclePhase.Rework,
    ]);
    expect(detail?.phaseAttribution?.coverage).toEqual({
      completeness: BranchPhaseAttributionCompleteness.Complete,
      subtotalUsd: 1,
    });
  });

  it("projects phaseSegments from pure session_branch lifecycle metadata", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    mockDb.artifactLink.findMany
      .mockResolvedValueOnce([
        makeSessionLink(branchId, "s1", "1.00", null, {
          linkKind: SessionArtifactLinkKind.SessionBranch,
          branchLifecycleEvents: [
            {
              kind: BranchLifecycleBoundaryKind.BranchWrite,
              observedAt: "2026-07-03T05:01:00.000Z",
              evidenceId: "desktop-artifact-link:branch",
            },
          ],
        }),
      ])
      .mockResolvedValueOnce([{ sourceId: "s1", targetId: branchId }]);

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    expect(
      detail?.sessions[0]?.phaseSegments?.map((segment) => segment.phase)
    ).toEqual([BranchLifecyclePhase.Build]);
  });

  it("keeps successful reviewed participation out of Branch spend", async () => {
    mockDetailCandidateSnapshots(mockDb, [branchId]);
    const reviewedLink = makeSuccessfulReviewSessionLink(branchId);
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          githubCreatedAt: new Date(0),
        }),
      })
    );
    mockDb.artifactLink.findMany
      .mockResolvedValueOnce([reviewedLink])
      .mockResolvedValueOnce([reviewedLink]);
    mockDb.agentSessionActivitySegment.findMany.mockResolvedValue([
      {
        agentSessionId: "review-session",
        phase: "other",
        startMs: 0,
        endMs: 100,
        confidence: 0.9,
      },
    ]);
    mockDb.agentSessionTokenEvent.findMany.mockResolvedValue([
      {
        agentSessionId: "review-session",
        externalEventId: "review-spend",
        eventCreatedAt: new Date(50),
        estimatedCost: { toString: () => "1.00" },
        inputTokens: 100n,
        outputTokens: 50n,
        cacheReadTokens: 0n,
        cacheWriteTokens: 0n,
      },
    ]);

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    expect(detail?.sessions).toEqual([]);
    expect(detail?.estimatedCostUsd).toBeNull();
    expect(detail?.attributedCostUsd).toBeNull();
    expect(detail?.owner).toBeNull();
    expect(detail?.associatedPullRequests).toMatchObject({
      selectedId: "closedloop-ai/closedloop-ai#7",
      completeness: {
        state: BranchAssociatedPullRequestCompletenessState.Complete,
      },
    });
    expect(detail?.lifecyclePhaseStacks ?? []).toEqual([]);
    expect(detail?.phaseAttribution).toBeUndefined();
    expect(mockDb.agentSessionActivitySegment.findMany).not.toHaveBeenCalled();
    expect(mockDb.agentSessionTokenEvent.findMany).not.toHaveBeenCalled();
  });

  it("projects current PR review authors as reviewed-only participants", async () => {
    const pullRequestDetail = makeCurrentPullRequestDetail({
      number: 42,
      reviews: [
        makeReview({
          githubReviewId: "review-1",
          authorLogin: "reviewer-one",
          authorAvatarUrl: "https://avatars.example/reviewer-one.png",
          htmlUrl:
            "https://github.com/closedloop-ai/closedloop-ai/pull/42#pullrequestreview-1",
          submittedAt: new Date("2026-07-03T06:00:00.000Z"),
        }),
        makeReview({
          githubReviewId: "review-dismissed",
          authorLogin: "dismissed-reviewer",
          state: ReviewDecision.Dismissed,
          submittedAt: new Date("2026-07-03T06:05:00.000Z"),
        }),
      ],
    });
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({
        currentPullRequestDetail: pullRequestDetail,
      })
    );
    mockDb.pullRequestDetail.findUnique.mockResolvedValue(pullRequestDetail);
    mockDb.artifactLink.findMany.mockResolvedValueOnce([]);

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    expect(detail?.reviewedParticipants).toEqual([
      {
        login: "reviewer-one",
        avatarUrl: "https://avatars.example/reviewer-one.png",
        participation: BranchParticipationKind.Reviewed,
        state: ReviewDecision.Approved,
        submittedAt: "2026-07-03T06:00:00.000Z",
        providerReviewId: "review-1",
        providerUrl:
          "https://github.com/closedloop-ai/closedloop-ai/pull/42#pullrequestreview-1",
        prNumber: 42,
      },
    ]);
    expect(detail?.sessions).toEqual([]);
    expect(detail?.estimatedCostUsd).toBeNull();
    expect(detail?.attributedCostUsd).toBeNull();
    expect(detail?.owner).toBeNull();
    expect(detail?.lifecyclePhaseStacks).toBeUndefined();
  });

  it("projects backfilled PR review rows through the owned PR fallback", async () => {
    const pullRequestDetail = makeCurrentPullRequestDetail({
      reviews: [
        makeReview({
          githubReviewId: "backfilled-review",
          authorLogin: "historical-reviewer",
          state: ReviewDecision.Commented,
          htmlUrl:
            "https://github.com/closedloop-ai/closedloop-ai/pull/7#pullrequestreview-2",
          submittedAt: new Date("2026-07-03T07:00:00.000Z"),
        }),
      ],
    });
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({
        currentPullRequestDetail: null,
        pullRequestDetails: [pullRequestDetail],
      })
    );
    mockDb.pullRequestDetail.findUnique.mockResolvedValue(pullRequestDetail);
    mockDb.artifactLink.findMany.mockResolvedValueOnce([]);

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    expect(detail?.reviewedParticipants).toEqual([
      expect.objectContaining({
        login: "historical-reviewer",
        participation: BranchParticipationKind.Reviewed,
        state: ReviewDecision.Commented,
        providerReviewId: "backfilled-review",
        prNumber: 7,
      }),
    ]);
    expect(detail?.sessions).toEqual([]);
    expect(detail?.estimatedCostUsd).toBeNull();
    expect(detail?.attributedCostUsd).toBeNull();
    expect(detail?.owner).toBeNull();
  });

  it("preserves canonical attributed zero with raw priced-zero parity", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    mockDb.artifactLink.findMany
      .mockResolvedValueOnce([
        makeSessionLink(branchId, "s1", "0", null, null, null, {}, "max_20x"),
      ])
      .mockResolvedValueOnce([{ sourceId: "s1", targetId: branchId }]);

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    expect(detail?.estimatedCostUsd).toBe(0);
    expect(detail?.attributedCostUsd).toBe(0);
    expect(detail?.lifecyclePhaseStacks).toBeUndefined();
    expect(detail?.phaseAttribution?.coverage).toMatchObject({
      completeness: BranchPhaseAttributionCompleteness.Unavailable,
    });
  });

  // FEA-2276: attributed segment cost must be even-split by the SAME per-session
  // branch-count divisor the branch total uses. A shared session's raw per-turn
  // spend counted whole would exceed the even-split total and clamp the residual.
  it("stamps each session's branch count so the activity rollup even-splits attributed cost", async () => {
    const otherBranchId = "22222222-2222-4222-8222-222222222222";
    mockDetailCandidateSnapshots(mockDb, [branchId, otherBranchId]);
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    mockDb.artifactLink.findMany
      // (1) usage: session s1 links to THIS branch, full captured cost $1.00.
      .mockResolvedValueOnce([makeSessionLink(branchId, "s1", "1.00")])
      // (2) branch counts: s1 wrote to this branch AND one other → divisor 2.
      .mockResolvedValueOnce([
        { sourceId: "s1", targetId: branchId },
        { sourceId: "s1", targetId: otherBranchId },
      ]);
    // One implement span covering the single $1.00 turn.
    mockDb.agentSessionActivitySegment.findMany.mockResolvedValue([
      {
        agentSessionId: "s1",
        phase: "implement",
        startMs: 0,
        endMs: 100,
        confidence: 0.9,
      },
    ]);
    mockDb.agentSessionTokenEvent.findMany.mockResolvedValue([
      {
        agentSessionId: "s1",
        eventCreatedAt: new Date(50),
        estimatedCost: { toString: () => "1.00" },
        inputTokens: 100,
        outputTokens: 50,
      },
    ]);

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    expect(detail?.sessions[0]?.branchCount).toBe(2);
    expect(detail?.estimatedCostUsd).toBeCloseTo(1, 10);
    expect(detail?.attributedCostUsd).toBeCloseTo(0.5, 10);
    const rollup = rollupBranchActivity(detail!);
    expect(
      rollup.activities.find((a) => a.phase === "implement")?.costUsd
    ).toBeCloseTo(0.5, 10);
    expect(rollup.unattributed.costUsd).toBe(0);
  });

  it("org-scopes and caps both activity-segment reads on getBranchDetail", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    mockDb.artifactLink.findMany
      .mockResolvedValueOnce([makeSessionLink(branchId, "s1", "1.00")])
      .mockResolvedValueOnce([{ sourceId: "s1", targetId: branchId }]);

    await branchReadService.getBranchDetail(organizationId, branchId);

    const segArgs =
      mockDb.agentSessionActivitySegment.findMany.mock.calls[0]?.[0];
    expect(segArgs?.where?.session?.artifact?.organizationId).toBe(
      organizationId
    );
    expect(segArgs?.where?.agentSessionId?.in).toContain("s1");
    expect(typeof segArgs?.take).toBe("number");

    const eventArgs = mockDb.agentSessionTokenEvent.findMany.mock.calls
      .map(([args]) => args)
      .find((args) => typeof args?.take === "number");
    expect(eventArgs?.where?.session?.artifact?.organizationId).toBe(
      organizationId
    );
    expect(eventArgs?.where?.agentSessionId?.in).toContain("s1");
    expect(typeof eventArgs?.take).toBe("number");
  });

  it("propagates activity hydration cap into phase completeness", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({ currentPullRequestDetail: null, pullRequestDetails: [] })
    );
    mockDb.artifactLink.findMany
      .mockResolvedValueOnce([
        makeSessionLink(branchId, "s1", "1.00", null, {
          linkKind: SessionArtifactLinkKind.SessionBranch,
          branchLifecycleEvents: [
            {
              kind: BranchLifecycleBoundaryKind.BranchWrite,
              observedAt: new Date(50).toISOString(),
            },
          ],
        }),
      ])
      .mockResolvedValueOnce([{ sourceId: "s1", targetId: branchId }]);
    mockDb.agentSessionActivitySegment.findMany.mockResolvedValue([
      {
        agentSessionId: "s1",
        phase: "other",
        startMs: 0,
        endMs: 100,
        confidence: 0.9,
      },
    ]);
    mockDb.agentSessionTokenEvent.findMany.mockResolvedValue(
      Array.from({ length: 10_000 }, (_, index) => ({
        agentSessionId: "s1",
        eventCreatedAt: new Date(50),
        estimatedCost: { toString: () => "0.0001" },
        inputTokens: index === 0 ? 1n : 0n,
        outputTokens: 0n,
        cacheReadTokens: 0n,
        cacheWriteTokens: 0n,
      }))
    );

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    expect(detail?.phaseAttribution?.segments[0]?.phase).toBe(
      BranchVisibleLifecyclePhase.Build
    );
    expect(detail?.phaseAttribution?.coverage).toEqual({
      completeness: BranchPhaseAttributionCompleteness.Partial,
      reason: BranchPhaseAttributionCompletenessReason.CoverageCapped,
      subtotalUsd: 1,
    });
  });

  it("excludes malformed spend rows instead of netting them into a plausible subtotal", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({ currentPullRequestDetail: null, pullRequestDetails: [] })
    );
    mockDb.artifactLink.findMany
      .mockResolvedValueOnce([
        makeSessionLink(branchId, "s1", "2.00", null, {
          linkKind: SessionArtifactLinkKind.SessionBranch,
          branchLifecycleEvents: [
            {
              kind: BranchLifecycleBoundaryKind.BranchWrite,
              observedAt: new Date(50).toISOString(),
            },
          ],
        }),
      ])
      .mockResolvedValueOnce([{ sourceId: "s1", targetId: branchId }]);
    mockDb.agentSessionActivitySegment.findMany.mockResolvedValue([
      {
        agentSessionId: "s1",
        phase: "implement",
        startMs: 0,
        endMs: 100,
        confidence: 0.9,
      },
    ]);
    mockDb.agentSessionTokenEvent.findMany.mockResolvedValue([
      {
        agentSessionId: "s1",
        externalEventId: "valid-spend",
        eventCreatedAt: new Date(50),
        estimatedCost: { toString: () => "2.00" },
        inputTokens: 100n,
        outputTokens: 50n,
        cacheReadTokens: 0n,
        cacheWriteTokens: 0n,
      },
      {
        agentSessionId: "s1",
        externalEventId: "invalid-spend",
        eventCreatedAt: new Date(50),
        estimatedCost: { toString: () => "-1.00" },
        inputTokens: -10n,
        outputTokens: 0n,
        cacheReadTokens: 0n,
        cacheWriteTokens: 0n,
      },
    ]);

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    expect(detail?.phaseAttribution?.segments[0]).toMatchObject({
      estimatedCostUsd: 2,
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(detail?.phaseAttribution?.coverage).toEqual({
      completeness: BranchPhaseAttributionCompleteness.Partial,
      reason: BranchPhaseAttributionCompletenessReason.PricingIncomplete,
      subtotalUsd: 2,
    });
  });

  // FEA-3457: the cloud/web branch detail must render the PRD-486 commit rail
  // from the persisted CommitDetail SSOT, not the previously-hardcoded [].
  it("populates the detail commit rail from the CommitDetail SSOT (oldest-first)", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    mockDb.artifactLink.findMany.mockResolvedValue([]);
    // Returned newest-first from the read; a null-committedAt row can't be
    // positioned on the rail and is dropped rather than fabricated.
    mockDb.commitDetail.findMany.mockResolvedValue([
      {
        sha: "sha-late",
        committedAt: new Date("2026-07-02T00:00:00Z"),
        message: "later",
      },
      {
        sha: "sha-early",
        committedAt: new Date("2026-07-01T00:00:00Z"),
        message: null,
      },
      { sha: "sha-unpositioned", committedAt: null, message: "no time" },
    ]);

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    expect(detail?.commits).toEqual([
      {
        sha: "sha-early",
        committedAt: "2026-07-01T00:00:00.000Z",
        message: "",
      },
      {
        sha: "sha-late",
        committedAt: "2026-07-02T00:00:00.000Z",
        message: "later",
      },
    ]);
    expect(mockDb.commitDetail.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { branchArtifactId: branchId },
      })
    );
  });

  it("derives linkedArtifacts from the branch name (deduped, canonical slugs)", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({ branchName: "fea-3457-fix/pln-988-and-fea-3457-again" })
    );
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    expect(detail?.linkedArtifacts).toEqual([
      {
        slug: "FEA-3457",
        evidence: { kind: BranchLinkedArtifactEvidenceKind.BranchNameSlug },
      },
      {
        slug: "PLN-988",
        evidence: { kind: BranchLinkedArtifactEvidenceKind.BranchNameSlug },
      },
    ]);
  });

  it("returns no linkedArtifacts for a slug-less branch name", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({ branchName: "just-a-feature" })
    );
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    expect(detail?.linkedArtifacts).toEqual([]);
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

  it("composes dual-evidence Product membership with status and search filters", async () => {
    mockDb.artifact.findMany.mockResolvedValue([]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
      search: "feature",
      status: [BranchStatus.Open],
    });

    const sql = branchCandidateSql(mockDb);
    expect(sql).toContain("session_detail sd");
    expect(sql).toContain("al.branch_participation = wrote");
    expect(sql).toContain("b.first_pushed_at IS NOT NULL");
    expect(sql).toContain("FROM pull_request_detail published_pr");
    // The status/search predicates still compose on top via the owned-current-PR
    // EXISTS (status filter) and the ILIKE columns (search).
    expect(sql).toContain("pr.pr_state NOT IN");
    expect(sql).toContain("a.name ILIKE");
    expect(sql).toContain("pr.id =");
    expect(sql).not.toContain("is_current");
  });

  it("uses the same dual-evidence candidate gate for usage and analytics reads", async () => {
    // Both reads aggregate over the full filtered corpus via
    // getBranchCandidateIds, so each issues a single candidate-id query. They must
    // inherit the same strict Wrote + publication gate the list uses.
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
    expect(sql).toContain("session_detail sd");
    expect(sql).toContain("al.branch_participation = wrote");
    expect(sql).toContain("b.first_pushed_at IS NOT NULL");
    expect(sql).toContain("FROM pull_request_detail published_pr");
  });

  it("applies the contributor predicate to usage and analytics candidate reads", async () => {
    mockBranchCandidateIds(mockDb, []);
    mockBranchCandidateIds(mockDb, []);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    await branchReadService.getBranchUsage(organizationId, {
      limit: 10,
      offset: 0,
      contributorUserId,
    });
    await branchReadService.getBranchAnalytics(organizationId, {
      limit: 10,
      offset: 0,
      contributorUserId,
    });

    const sql = branchCandidateSql(mockDb);
    expect(sql).toContain("FROM artifact_links al");
    expect(sql).toContain("session_detail sd");
    expect(branchCandidateValues(mockDb)).toEqual(
      expect.arrayContaining([contributorUserId])
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
    expect(sql).not.toMatch(OLD_BRANCH_CANDIDATE_PAGE_LIMIT_PATTERN);
    expect(sql).not.toContain("OFFSET 0");
    expect(branchCandidateValues(mockDb)).not.toEqual(
      expect.arrayContaining([7, 14])
    );
    expect(mockDb.artifact.findMany).not.toHaveBeenCalled();
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
    mockBranchCandidateIds(mockDb, []);
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
      // FEA-3457: byActor is now a per-owner rollup grouped over the corpus's
      // DISTINCT sessions. An empty corpus has no sessions, so it emits NO
      // buckets — matching the desktop producer (rollupActors returns [] for
      // zero rows), not the prior fabricated single null bucket.
      byActor: [],
    });
    expect(mockDb.artifactLink.findMany).not.toHaveBeenCalled();
  });

  // FEA-3457 (reopened): the cloud branch read must resolve each branch's
  // dominant linked-session owner to a display name (mirroring the desktop
  // producer), org-scoped and batched (no per-branch N+1). Previously owner was
  // hardcoded null on both the list and byActor paths.

  // FEA-3334: the shared medianPrSize card sizes each branch from the branch
  // file-cache LOC, NOT the PR's reported line counts. Here the PR reports 42,
  // while the file cache reports 20, proving the PR counts are ignored.
  it("medians the branch file-cache LOC, not the PR's reported line counts", async () => {
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

    expect(response.medianPrSize.value).toBe(20);
    expect(response.canonicalMetrics).toMatchObject({ cohortSize: 1 });
    expect(mockDb.artifact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          branch: { isNot: null },
          id: { in: [branchId] },
          organizationId,
          type: ArtifactType.BRANCH,
        },
      })
    );
  });

  it("sizes from branch LOC when the PR LOC fields are still null", async () => {
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

  it("sizes from branch LOC when the PR LOC fields are partial", async () => {
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

  // FEA-3334: an un-enriched merged branch (no file-cache rows → UNKNOWN LOC) is
  // EXCLUDED from the median, not folded in as 0 — even when its PR reports line
  // counts. Folding it in as 0 would drag the median toward 0 and disagree with
  // the desktop producer (enriched-only filter) and getDelivery (enriched-PR
  // median) for the same corpus. Here the enriched branch medians to 40; the
  // un-enriched merged branch (PR reports 200 + 50) must not pull it toward 0.
  it("excludes un-enriched merged branches from the median instead of counting them as 0", async () => {
    const enrichedId = branchId;
    const unenrichedId = "44444444-4444-4444-8444-444444444444";
    mockBranchCandidateIds(mockDb, [enrichedId, unenrichedId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        id: enrichedId,
        status: GitHubPRState.Merged,
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          branchArtifactId: enrichedId,
          prState: GitHubPRState.Merged,
          closedAt: now,
          mergedAt: now,
        }),
        fileChanges: [{ additions: 25, deletions: 15, path: "a.ts" }],
      }),
      makeBranchRow({
        id: unenrichedId,
        status: GitHubPRState.Merged,
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          branchArtifactId: unenrichedId,
          prState: GitHubPRState.Merged,
          closedAt: now,
          mergedAt: now,
          additions: 200,
          deletions: 50,
        }),
        fileChanges: [],
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const response = await branchReadService.getBranchAnalytics(
      organizationId,
      { limit: 10, offset: 0 }
    );

    expect(response.medianPrSize.value).toBe(40);
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
        fileChanges: [{ additions: 80, deletions: 20, path: "a.ts" }],
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const response = await branchReadService.getBranchAnalytics(
      organizationId,
      { limit: 1, offset: 0 }
    );

    expect(response.medianPrSize.value).toBe(100);
    const initialCandidateSql = renderSql(mockDb.$queryRaw.mock.calls[0]?.[0]);
    expect(initialCandidateSql).not.toMatch(
      OLD_BRANCH_CANDIDATE_PAGE_LIMIT_PATTERN
    );
    expect(initialCandidateSql).not.toContain("OFFSET 0");
  });

  it("reports merge rate as merged over DECIDED PRs, excluding still-open PRs (FEA-2943)", async () => {
    // Aligns the cloud producer with desktop `projectBranchAnalytics`
    // (`merged / decided`, FEA-2942): the denominator is branches whose latest PR
    // reached a terminal outcome (MERGED or CLOSED), NOT every branch. A merged +
    // a closed-unmerged + a still-open PR ⇒ merged=1 over decided=2 (the open PR is
    // excluded) ⇒ 50%. Under the old all-branches denominator this same corpus read
    // 33% (1/3), so the two Branches-page surfaces disagreed for identical data.
    const closedBranchId = "22222222-2222-4222-8222-222222222222";
    const openBranchId = "44444444-4444-4444-8444-444444444444";
    mockBranchCandidateIds(mockDb, [branchId, closedBranchId, openBranchId]);
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
        id: closedBranchId,
        status: GitHubPRState.Closed,
        firstPushedAt: now,
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          branchArtifactId: closedBranchId,
          prState: GitHubPRState.Closed,
          closedAt: now,
          mergedAt: null,
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
    // counted. Its prState is null, so it is also outside the merge RATE's
    // decided denominator (FEA-2943) — the rate folds only over PRs with a
    // terminal MERGED/CLOSED state.
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
        // Both Branches are candidate ids (mocked above), so both enter the KPI
        // fold; analytics row hydration keeps only the relation-present type guard.
        // This branch's prState is null, so it lands in the corpus yet is excluded
        // from the decided-denominator/mergedPrCount populations (both prState-based).
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
    // Merge RATE (FEA-2943): numerator and denominator are both prState-based —
    // mergedPrCount=1 over decidedCount=1 (only the MERGED-PR branch; the
    // prState-null status-merged branch is neither merged nor decided) ⇒ 100%.
    expect(response.mergeRate).toMatchObject({
      value: 100,
      state: BranchKpiState.Available,
    });
  });

  it("counts a stale-open-but-merged PR ONLY as merged, never active (FEA-4333)", async () => {
    // The double-classification bug: `deriveBranchMergedState` treats a PR as merged
    // when `mergedAt` is present even if the connected `prState` is stale ("OPEN"),
    // but `activePrCount` used to count raw `prState === "OPEN"` INDEPENDENTLY — so
    // the SAME stale-open-but-merged PR incremented BOTH mutually-exclusive KPIs.
    // Now every PR-lifecycle KPI classifies through one merge-evidence-first signal,
    // so this PR (prState OPEN + mergedAt set) is merged only, and a genuinely-open
    // PR (prState OPEN + mergedAt null) is active only.
    const staleOpenMergedId = "22222222-2222-4222-8222-222222222222";
    const genuinelyOpenId = "33333333-3333-4333-8333-333333333333";
    mockBranchCandidateIds(mockDb, [staleOpenMergedId, genuinelyOpenId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        id: staleOpenMergedId,
        // Artifact status still "OPEN" and connected prState still OPEN — only the
        // non-null mergedAt proves the merge. Merge evidence must win.
        status: GitHubPRState.Open,
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          branchArtifactId: staleOpenMergedId,
          prState: GitHubPRState.Open,
          mergedAt: now,
        }),
      }),
      makeBranchRow({
        id: genuinelyOpenId,
        status: GitHubPRState.Open,
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          branchArtifactId: genuinelyOpenId,
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

    // Exactly one merged, exactly one active — the stale-open-but-merged PR is NOT
    // double-counted. Mutual exclusivity: active + merged = 2 over a 2-branch corpus.
    expect(response.mergedCount).toMatchObject({
      value: 1,
      state: BranchKpiState.Available,
    });
    expect(response.activePrCount).toMatchObject({
      value: 1,
      state: BranchKpiState.Available,
    });
    // The merged branch's canonical status is Merged (mergedAt wins), so only the
    // genuinely-open branch is an active branch too.
    expect(response.activeBranchCount).toMatchObject({
      value: 1,
      state: BranchKpiState.Available,
    });
    // Merge rate: 1 merged over 1 decided (the merged PR; the open PR is not
    // decided) ⇒ 100%.
    expect(response.mergeRate).toMatchObject({
      value: 100,
      state: BranchKpiState.Available,
    });
  });

  it("reads the branch corpus with the narrowed analytics select", async () => {
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
    // Only repository identity (needed by the shared selector) is retained;
    // installation/check/detail-heavy fields remain absent.
    expect(select?.branch?.select?.repository?.select).toEqual({
      fullName: true,
      githubRepoId: true,
    });
    expect(select?.branch?.select?.checksStatus).toBeUndefined();
    expect(select?.pullRequestDetails?.select?.body).toBeUndefined();
    expect(select?.pullRequestDetails?.select?.repository?.select).toEqual({
      fullName: true,
      githubRepoId: true,
    });
    // KPI inputs the narrowed select still needs, incl. the ISS-10298 fold gate's.
    expect(select?.status).toBe(true);
    expect(select?.pullRequestDetails?.select?.prState).toBe(true);
    expect(select?.branch?.select?.fileCacheHeadSha).toBe(true);
    expect(select?.branch?.select?.firstPushedAt).toBe(true);
  });

  it("routes full session-link chunks through raw SQL instead of one unbounded IN", async () => {
    const chunkSize = 1000;
    const ids = Array.from({ length: 1001 }, (_, index) => `branch-${index}`);
    mockDb.$queryRaw.mockImplementation((query) => {
      const rows = renderSql(query).includes(
        "INNER JOIN session_detail session"
      )
        ? []
        : ids.map((id) => mockCandidateSnapshotRow(id, 0));
      return Promise.resolve(rows);
    });
    mockDb.artifact.findMany.mockResolvedValue(
      ids.map((id) => makeBranchRow({ id }))
    );
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    await branchReadService.getBranchUsage(organizationId, {
      limit: 10,
      offset: 0,
    });

    const rawSessionUsageQuery = mockDb.$queryRaw.mock.calls
      .map((call) => call[0])
      .find((query) =>
        renderSql(query).includes("INNER JOIN session_detail session")
      );
    expect(rawSessionUsageQuery).toBeDefined();
    const rawValues = collectSqlValues(rawSessionUsageQuery);
    expect(rawValues).toContain(ids[0]);
    expect(rawValues).toContain(ids[chunkSize - 1]);
    expect(rawValues).not.toContain(ids[chunkSize]);
    expect(mockDb.artifactLink.findMany).toHaveBeenCalledTimes(1);
    expect(mockDb.artifactLink.findMany).toHaveBeenCalledWith(
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
      activePrCount: { value: null, state: BranchKpiState.Unavailable },
      mergedCount: { value: null, state: BranchKpiState.Unavailable },
      activeBranchCount: { value: null, state: BranchKpiState.Unavailable },
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

  // Value per $ = total CHURN ÷ even-split enriched spend. Both halves
  // are pinned numerically here because this producer previously had only
  // null-case coverage, which is how it drifted from the desktop producer
  // (apps/desktop/src/main/branch-analytics-projection.ts) unnoticed — it divided
  // by per-branch-ATTRIBUTION spend (a session counted once per branch it
  // touched) over a numerator that included un-enriched branches. These two cases
  // mirror the desktop suite's fixtures 1:1 (apps/desktop/test/
  // shared-branches-api.test.ts), so the shared card cannot report different
  // numbers on the two surfaces again.
  // A session that touched N branches must contribute its cost and tokens ONCE.
  // The sibling "rolls up sessions of every role and contributor" test puts four
  // DISTINCT sessions on ONE branch, so it never exercised the shared-session
  // case and the per-branch attribution sum went unnoticed: `usageByBranch` maps
  // each branch to the FULL usage of every session that touched it, so folding
  // the map multiplied every shared session by its branch count.
  it("counts a session spanning multiple branches once in usage totals", async () => {
    const secondBranchId = "22222222-2222-4222-8222-222222222222";
    const branchIds = [branchId, secondBranchId];
    const rows = [
      makeBranchRow(),
      makeBranchRow({ id: secondBranchId, repositoryFullName: "acme/web" }),
    ];
    // ONE session ($1.25, 10/20/30/40 tokens) linked to BOTH branches.
    const links = branchIds.map((id) =>
      makeSessionLink(id, "session-1", "1.25")
    );

    mockBranchCandidateIds(mockDb, branchIds);
    mockDb.artifact.findMany.mockResolvedValue(rows);
    mockDb.artifactLink.findMany.mockResolvedValue(links);

    mockBranchCandidateIds(mockDb, branchIds);
    mockDb.artifact.findMany.mockResolvedValue(rows);
    mockDb.artifactLink.findMany.mockResolvedValue(links);

    const usage = await branchReadService.getBranchUsage(organizationId, {
      limit: 50,
      offset: 0,
    });

    // The usage summary shares the same map and had the same defect: tokens and
    // cost are the session's own, not doubled.
    expect(usage.totalEstimatedCost).toBeCloseTo(1.25, 10);
    expect(usage.totalInputTokens).toBe(10);
    expect(usage.totalOutputTokens).toBe(20);
    expect(usage.totalCacheReadTokens).toBe(30);
    expect(usage.totalCacheWriteTokens).toBe(40);
  });

  // ISS-4632 — a null/unavailable-spend case must render safely: no
  // divide-by-zero, no Infinity, the KPI is Unavailable.
  it("renders Value per $ as Unavailable (not Infinity) when the enriched spend is zero", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        fileChanges: [{ additions: 200, deletions: 50, path: "a.ts" }],
      }),
    ]);
    // A priced-zero session — churn exists but there is no spend to divide by.
    mockDb.artifactLink.findMany.mockResolvedValue([
      makeSessionLink(branchId, "session-1", "0"),
    ]);

    const response = await branchReadService.getBranchAnalytics(
      organizationId,
      { limit: 10, offset: 0 }
    );

    expect(response.locPerDollar).toMatchObject({
      value: null,
      state: BranchKpiState.Unavailable,
    });
    expect(Number.isFinite(response.locPerDollar.value ?? 0)).toBe(true);
  });
});

function branchCandidateValues(
  mockDb: ReturnType<typeof createMockDb>
): unknown[] {
  return mockDb.$queryRaw.mock.calls.flatMap((call) =>
    collectSqlValues(call[0])
  );
}

function activitySegmentRow(
  agentSessionId: string,
  phase: string,
  startTime: string,
  endTime: string
) {
  return {
    agentSessionId,
    phase,
    startMs: Date.parse(`2026-07-03T${startTime}.000Z`),
    endMs: Date.parse(`2026-07-03T${endTime}.000Z`),
    confidence: 0.9,
  };
}

function phaseTokenEvent(
  agentSessionId: string,
  time: string,
  estimatedCost: number
) {
  return {
    agentSessionId,
    eventCreatedAt: new Date(`2026-07-03T${time}.000Z`),
    estimatedCost: { toString: () => String(estimatedCost) },
    inputTokens: 10n,
    outputTokens: 5n,
    cacheReadTokens: 3n,
    cacheWriteTokens: 1n,
  };
}

function reviewedBranchMetadata() {
  return {
    linkKind: SessionArtifactLinkKind.SessionBranch,
    relationTypes: [SessionPrRelationType.Reviewed],
    branchLifecycleEvents: [
      {
        kind: BranchLifecycleBoundaryKind.ReviewFeedback,
        observedAt: "2026-07-03T09:13:00.000Z",
      },
    ],
  };
}
