import {
  BranchDataState,
  BranchLifecycleBoundaryKind,
  BranchParticipationKind,
  BranchStatus,
  BranchTagAvailability,
} from "@repo/api/src/types/branch";
import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivityEvidenceReason,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import {
  BranchProjectionEvidenceDelivery,
  BranchProjectionVersion,
} from "@repo/api/src/types/branch-projection";
import { GitHubPRState } from "@repo/api/src/types/github";
import { ReadSource } from "@repo/api/src/types/read-source";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
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
    refreshTombstonedBranchPullRequest: vi.fn(),
  },
}));

vi.mock("@/app/agent-sessions/service", () => ({
  agentSessionsService: { findSessionDetail: vi.fn() },
}));

const heavyEvidenceMocks = vi.hoisted(() => ({
  buildCompleteBranchTrace: vi.fn(),
  findQualifyingBranchTraceSessions: vi.fn(),
}));

vi.mock("./branch-trace-service", () => ({
  branchTraceService: heavyEvidenceMocks,
}));

import {
  branchId,
  createMockDb,
  makeBranchRow,
  makeCurrentPullRequestDetail,
  makeSessionLink,
  mockBranchCandidatePage,
  now,
  organizationId,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import { mockWithDbCall, mockWithDbTx } from "../../__tests__/utils/db-helpers";
import { branchReadService } from "./branch-read-service";

describe("branchReadService canonical cloud projection", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
    mockWithDbTx(mockDb);
    mockDb.commitDetail.findMany.mockResolvedValue([]);
  });

  it("composes list compatibility fields from the additive V1 projection", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        currentPullRequestDetail: makeCurrentPullRequestDetail({
          prState: GitHubPRState.Open,
          additions: 12,
          deletions: 3,
          changedFiles: 2,
        }),
        tagArtifacts: [
          {
            tag: {
              id: "tag-1",
              name: "Canonical",
              color: "blue",
              organizationId,
            },
          },
        ],
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
    });
    const row = response.items[0];
    const projection = row?.canonicalProjection;

    expect(projection).toMatchObject({
      version: BranchProjectionVersion.V1,
      common: {
        identity: {
          artifactId: branchId,
          projectId: "project-1",
          branchName: "feature",
          repositoryFullName: "closedloop-ai/symphony-alpha",
        },
        membership: { sessionIds: [], qualifyingSessionCount: 0 },
        tags: {
          availability: BranchTagAvailability.Available,
          items: [{ id: "tag-1", name: "Canonical", color: "blue" }],
        },
        pullRequests: {
          associatedCount: 1,
          selected: { id: "closedloop-ai/symphony-alpha#7" },
        },
        evidence: {
          comments: { delivery: BranchProjectionEvidenceDelivery.Lazy },
          checks: { delivery: BranchProjectionEvidenceDelivery.Lazy },
          files: { delivery: BranchProjectionEvidenceDelivery.Lazy },
          trace: { delivery: BranchProjectionEvidenceDelivery.Lazy },
        },
        provenance: { source: ReadSource.Cloud },
      },
      list: {
        status: BranchStatus.Open,
        dataState: BranchDataState.NoSessions,
        selectedPullRequest: {
          id: "closedloop-ai/symphony-alpha#7",
        },
        changes: { additions: 12, deletions: 3, filesChanged: 2 },
      },
    });
    expect(row).toMatchObject({
      artifactId: projection?.common.identity.artifactId,
      branchName: projection?.common.identity.branchName,
      repoFullName: projection?.common.identity.repositoryFullName,
      status: projection?.list.status,
      dataState: projection?.list.dataState,
      additions: projection?.list.changes.additions,
      deletions: projection?.list.changes.deletions,
      filesChanged: projection?.list.changes.filesChanged,
    });
    expect(projection?.common.pullRequests).not.toHaveProperty("items");
    expect(projection?.common.evidence.checks).not.toHaveProperty("summary");
    expect(projection?.common.evidence.comments).not.toHaveProperty("summary");
    expect(projection?.common.evidence.files).not.toHaveProperty("summary");
    expect(projection?.common.evidence.trace).not.toHaveProperty("summary");
    expect(heavyEvidenceMocks.buildCompleteBranchTrace).not.toHaveBeenCalled();
    expect(
      heavyEvidenceMocks.findQualifyingBranchTraceSessions
    ).not.toHaveBeenCalled();
  });

  it("projects the same bounded canonical activity evidence on list and detail", async () => {
    const occurredAt = new Date("2026-07-03T04:30:00.000Z");
    const activityAtom = {
      version: BranchActivityAtomVersion.V1,
      source: BranchActivitySource.GitHead,
      sourceEventId: "head-sha-1",
      occurredAt,
      attributionKind: BranchActivityAttributionKind.Branch,
      pullRequestDetailId: null,
      completeness: BranchActivityEvidenceCompleteness.Complete,
    };
    const separatelyHydratedAtom = {
      ...activityAtom,
      sourceEventId: "later-row-query-atom",
      occurredAt: new Date("2026-07-03T04:55:00.000Z"),
    };
    const row = makeBranchRow({
      activityAtoms: [separatelyHydratedAtom],
      currentPullRequestDetail: makeCurrentPullRequestDetail({
        githubCreatedAt: new Date("2026-07-03T04:45:00.000Z"),
      }),
    });
    const candidateActivity = new Map([[branchId, activityAtom]]);
    mockBranchCandidatePage(mockDb, [branchId], 1, candidateActivity);
    mockBranchCandidatePage(mockDb, [branchId], 1, candidateActivity);
    mockDb.artifact.findMany.mockResolvedValue([row]);
    mockDb.artifact.findFirst.mockResolvedValue(row);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const list = await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
    });
    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );
    const expected = {
      completeness: BranchActivityEvidenceCompleteness.Partial,
      latestAtom: {
        version: BranchActivityAtomVersion.V1,
        source: BranchActivitySource.GitHead,
        sourceEventId: "head-sha-1",
        occurredAt: occurredAt.toISOString(),
        attribution: { kind: BranchActivityAttributionKind.Branch },
        completeness: BranchActivityEvidenceCompleteness.Complete,
      },
      reason: BranchActivityEvidenceReason.HistoricalCoverage,
    };

    expect(list.items[0]?.canonicalActivityEvidence).toEqual(expected);
    expect(list.items[0]?.lastActivityAt).toBe(occurredAt.toISOString());
    expect(list.items[0]?.canonicalLastActiveAt?.value).toBe(
      occurredAt.toISOString()
    );
    expect(detail?.canonicalActivityEvidence).toEqual(expected);
    expect(detail?.lastActivityAt).toBe(occurredAt.toISOString());
    expect(detail?.leadTime.lastActivityT).toBe(occurredAt.toISOString());
    expect(list.items[0]?.canonicalActivityEvidence).not.toMatchObject({
      latestAtom: { sourceEventId: "later-row-query-atom" },
    });
    const listSelect = mockDb.artifact.findMany.mock.calls.at(-1)?.[0]?.select;
    expect(listSelect?.branch?.select?.activityAtoms).toMatchObject({
      orderBy: [
        { occurredAt: "desc" },
        { source: "asc" },
        { sourceEventId: "asc" },
      ],
      take: 1,
    });
  });

  it("does not fabricate provenance from the legacy last-activity scalar", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow()]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const list = await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
    });

    expect(list.items[0]?.lastActivityAt).toBe("");
    expect(list.items[0]?.canonicalLastActiveAt).toEqual({
      state: BranchMetricAvailability.Unavailable,
      value: null,
    });
    expect(list.items[0]?.canonicalActivityEvidence).toEqual({
      completeness: BranchActivityEvidenceCompleteness.Unavailable,
      reason: BranchActivityEvidenceReason.NoEvidence,
    });
    const listSelect = mockDb.artifact.findMany.mock.calls.at(-1)?.[0]?.select;
    expect(listSelect?.branch?.select).not.toHaveProperty("lastActivityAt");
  });

  it("finalizes detail membership and lifecycle data from bounded enrichment", async () => {
    const sessionId = "session-artifact-1";
    const sessionLink = makeSessionLink(branchId, sessionId, "4.00");
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    mockDb.artifactLink.findMany
      .mockResolvedValueOnce([sessionLink, sessionLink])
      .mockResolvedValueOnce([
        {
          targetId: branchId,
          sourceId: sessionId,
          branchParticipation: null,
          metadata: null,
        },
      ]);

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );
    const projection = detail?.canonicalProjection;

    expect(projection?.common.membership).toMatchObject({
      sessionIds: [sessionId],
      qualifyingSessionCount: 1,
      sessions: [
        {
          artifactId: sessionId,
          name: `Session ${sessionId}`,
          slug: `session-${sessionId}`,
          navigableRef: `session-${sessionId}`,
          externalSessionId: sessionId,
        },
      ],
    });
    expect(detail?.sessions).toHaveLength(1);
    expect(detail?.estimatedCostUsd).toBe(4);
    expect(detail?.attributedCostUsd).toBe(4);
    expect(projection?.detail).not.toHaveProperty("sessions");
    expect(projection?.list.cost).toEqual({
      replicatedUsd: detail?.estimatedCostUsd,
      attributedUsd: detail?.attributedCostUsd,
    });
    expect(detail?.associatedPullRequests).toBeDefined();
    const associatedPullRequests = detail?.associatedPullRequests;
    if (!associatedPullRequests) {
      throw new Error("Expected detail associated pull requests");
    }
    expect(projection?.common.pullRequests).toMatchObject({
      associatedCount: associatedPullRequests.items.length,
      selected: {
        id: associatedPullRequests.selectedId,
      },
      selectionReason: associatedPullRequests.selectionReason,
      completeness: associatedPullRequests.completeness,
    });
    expect(projection?.common.evidence).toMatchObject({
      comments: { delivery: BranchProjectionEvidenceDelivery.Lazy },
      checks: { delivery: BranchProjectionEvidenceDelivery.Lazy },
      files: { delivery: BranchProjectionEvidenceDelivery.Lazy },
      trace: { delivery: BranchProjectionEvidenceDelivery.Lazy },
    });
  });

  it("anchors a later selected PR cycle to persisted post-boundary push evidence", async () => {
    const historical = makeCurrentPullRequestDetail({
      id: "historical-pr-detail",
      number: 6,
      isCurrent: false,
      prState: GitHubPRState.Closed,
      githubCreatedAt: new Date("2026-06-30T12:00:00.000Z"),
      closedAt: new Date("2026-07-01T12:00:00.000Z"),
      mergedAt: null,
    });
    const selected = makeCurrentPullRequestDetail({
      id: "selected-pr-detail",
      number: 7,
      isCurrent: true,
      prState: GitHubPRState.Merged,
      githubCreatedAt: new Date("2026-07-02T12:00:00.000Z"),
      closedAt: new Date("2026-07-03T04:00:00.000Z"),
      mergedAt: new Date("2026-07-03T04:00:00.000Z"),
    });
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({
        currentPullRequestDetail: selected,
        firstPushedAt: new Date("2026-06-30T10:00:00.000Z"),
        pullRequestDetails: [historical, selected],
      })
    );
    mockDb.pullRequestDetail.findUnique.mockResolvedValue(selected);
    mockDb.artifactLink.findMany
      .mockResolvedValueOnce([
        makeSessionLink(branchId, "cycle-session", "1.00", null, {
          linkKind: SessionArtifactLinkKind.SessionBranch,
          method: "git_push",
          branchLifecycleEvents: [
            {
              kind: BranchLifecycleBoundaryKind.BranchWrite,
              observedAt: "2026-07-01T11:00:00.000Z",
              evidenceId: "push-before-prior-terminal",
            },
            {
              kind: BranchLifecycleBoundaryKind.BranchWrite,
              observedAt: "2026-07-02T10:00:00.000Z",
              evidenceId: "push-in-selected-cycle",
            },
          ],
        }),
      ])
      .mockResolvedValueOnce([
        { sourceId: "cycle-session", targetId: branchId },
      ]);

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId,
      undefined,
      {
        repositoryFullName: "closedloop-ai/symphony-alpha",
        pullRequestNumber: 7,
      }
    );

    expect(detail?.associatedPullRequests?.selectedId).toBe(
      "closedloop-ai/symphony-alpha#7"
    );
    expect(detail?.canonicalMetrics?.leadTimeMs).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 18 * 60 * 60 * 1000,
    });
    expect(detail?.canonicalMetrics?.abandonmentTimeMs.state).toBe(
      BranchMetricAvailability.NotApplicable
    );
  });

  it("keeps list and detail common fields aligned for the same branch", async () => {
    const sessionLink = makeSessionLink(branchId, "shared-session", "2.50");
    const reviewedLink = makeSessionLink(
      branchId,
      "reviewed-session",
      "3.00",
      null,
      undefined,
      BranchParticipationKind.Reviewed
    );
    const row = makeBranchRow({
      tagArtifacts: [
        {
          tag: {
            id: "tag-shared",
            name: "Shared",
            color: "green",
            organizationId,
          },
        },
      ],
    });
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([row]);
    mockDb.artifact.findFirst.mockResolvedValue(row);
    mockDb.artifactLink.findMany.mockResolvedValue([sessionLink, reviewedLink]);

    const list = await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
    });
    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );
    const listCommon = list.items[0]?.canonicalProjection?.common;
    const detailCommon = detail?.canonicalProjection?.common;

    expect(detailCommon).toMatchObject({
      identity: listCommon?.identity,
      membership: {
        sessionIds: listCommon?.membership.sessionIds,
        qualifyingSessionCount: listCommon?.membership.qualifyingSessionCount,
      },
      people: listCommon?.people,
      tags: listCommon?.tags,
      pullRequests: listCommon?.pullRequests,
      lastActiveAt: listCommon?.lastActiveAt,
      evidence: listCommon?.evidence,
      provenance: listCommon?.provenance,
    });
    expect(list.items[0]?.canonicalProjection?.list.cost).toEqual({
      replicatedUsd: 2.5,
      attributedUsd: 2.5,
    });
    expect(detail?.canonicalProjection?.list.cost).toEqual({
      replicatedUsd: 5.5,
      attributedUsd: 5.5,
    });
    expect(detail?.estimatedCostUsd).toBe(5.5);
    expect(detail?.attributedCostUsd).toBe(5.5);
  });

  it("keeps canonical detail state honest for reviewed-only context", async () => {
    const reviewedLink = makeSessionLink(
      branchId,
      "reviewed-session",
      "3.00",
      null,
      undefined,
      BranchParticipationKind.Reviewed
    );
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    mockDb.artifactLink.findMany.mockResolvedValue([reviewedLink]);

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    expect(detail?.dataState).toBe(BranchDataState.Ready);
    expect(detail?.canonicalProjection).toMatchObject({
      common: {
        membership: { sessionIds: [], qualifyingSessionCount: 0, sessions: [] },
      },
      list: {
        dataState: BranchDataState.NoSessions,
        cost: { replicatedUsd: 3, attributedUsd: 3 },
      },
    });
    expect(detail?.estimatedCostUsd).toBe(3);
    expect(detail?.attributedCostUsd).toBe(3);
  });

  it("omits V1 from an early refresh response whose membership was not loaded", async () => {
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({ currentPullRequestDetail: null })
    );

    const response = await branchReadService.refreshBranch(
      organizationId,
      branchId,
      { userId: "user-1", authMethod: "session" }
    );

    expect(response.branch).not.toHaveProperty("canonicalProjection");
  });

  it("keeps list PR output bounded when persisted history exceeds one page", async () => {
    const pullRequestDetails = Array.from({ length: 101 }, (_, index) =>
      makeCurrentPullRequestDetail({
        id: `pr-detail-${index}`,
        number: index + 1,
        isCurrent: index === 0,
        prState: GitHubPRState.Closed,
        closedAt: new Date(now.getTime() + index * 60_000),
      })
    );
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        currentPullRequestDetail: pullRequestDetails[0],
        pullRequestDetails,
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 100,
      offset: 0,
    });
    const pullRequests =
      response.items[0]?.canonicalProjection?.common.pullRequests;

    expect(pullRequests).toMatchObject({
      associatedCount: 101,
      selected: { number: 101 },
    });
    expect(pullRequests).not.toHaveProperty("items");
  });
});
