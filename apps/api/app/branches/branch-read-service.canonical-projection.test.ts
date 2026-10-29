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
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBranchCanonicalDivergenceThrottle } from "./branch-canonical-pull-request";

const logWarn = vi.hoisted(() => vi.fn());
vi.mock("@repo/observability/log", () => ({
  log: { warn: logWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * ISS-6949 — capture what `attachCanonicalDetailMetrics` is handed at call time,
 * so the ORDERING inside `getBranchDetail` is pinned. A reorder that ran the
 * metrics attacher before `attachCanonicalCloudDetailCost` would leave
 * `attributedCostUsd` absent, and `resolveAttributedBranchCost` would silently
 * fall back to the REPLICATED over-count already on `estimatedCostUsd` — a wrong
 * number rather than a decline, which no attacher-level test can see because
 * those hand the attacher a detail whose cost fields are already populated.
 */
const detailMetricAttachCostSnapshots: {
  estimatedCostUsd: number | null;
  attributedCostUsd: number | null | undefined;
}[] = [];

vi.mock("./branch-canonical-metric-projection", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("./branch-canonical-metric-projection")
    >();
  return {
    ...actual,
    attachCanonicalDetailMetrics: (
      ...args: Parameters<typeof actual.attachCanonicalDetailMetrics>
    ) => {
      const [detail] = args;
      detailMetricAttachCostSnapshots.push({
        estimatedCostUsd: detail.estimatedCostUsd,
        attributedCostUsd: detail.attributedCostUsd,
      });
      return actual.attachCanonicalDetailMetrics(...args);
    },
  };
});

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
  mockBranchCandidateIds,
  mockBranchCandidatePage,
  mockDetailCandidateSnapshots,
  now,
  organizationId,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import { mockWithDbCall, mockWithDbTx } from "../../__tests__/utils/db-helpers";
import { branchReadService } from "./branch-read-service";

afterEach(() => {
  vi.useRealTimers();
});

describe("branchReadService canonical PR arbitration monitors", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    // ISS-8902: the divergence/ambiguity emission budget is MODULE-level state
    // that `vi.clearAllMocks()` does not touch. This file also freezes the clock
    // below, so the 60s window never rolls on its own — without this reset the
    // second case in file order to drive a divergence for the same
    // (organizationId, branchArtifactId) would be silently suppressed and fail
    // its warn assertion with nothing pointing at a throttle.
    resetBranchCanonicalDivergenceThrottle();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
    mockWithDbTx(mockDb);
    mockDb.commitDetail.findMany.mockResolvedValue([]);
  });

  // ISS-8522: two equally suitable, equally authoritative candidates are NOT
  // silently resolved. The detail read keeps the pointer's projection and
  // reports the tie, so the reconciler can revisit it.
  it("reports the ambiguity and keeps the pointer when the tie-break cannot decide", async () => {
    const pointerRow = makeCurrentPullRequestDetail({
      id: "pr-detail-1",
      number: 7,
      githubId: "gh-7",
      prState: GitHubPRState.Merged,
      mergedAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    const olderMerged = makeCurrentPullRequestDetail({
      id: "pr-detail-2",
      number: 8,
      githubId: "gh-8",
      htmlUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/8",
      prState: GitHubPRState.Merged,
      mergedAt: new Date("2026-07-02T00:00:00.000Z"),
    });
    const row = makeBranchRow({
      currentPullRequestDetail: pointerRow,
      pullRequestDetails: [pointerRow, olderMerged],
    });
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findFirst.mockResolvedValue(row);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    await branchReadService.getBranchDetail(organizationId, branchId);

    const signal = {
      event: "branch_canonical_pull_request_ambiguity",
      organizationId,
      branchArtifactId: branchId,
      pointerId: "pr-detail-1",
      ownedSetSelectedId: "pr-detail-2",
    };
    expect(logWarn).toHaveBeenCalledWith(
      "branch canonical pull request selection is ambiguous",
      signal
    );
  });
});

describe("branchReadService canonical cloud projection", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    detailMetricAttachCostSnapshots.length = 0;
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
          repositoryFullName: "closedloop-ai/closedloop-ai",
        },
        membership: { sessionIds: [], qualifyingSessionCount: 0 },
        tags: {
          availability: BranchTagAvailability.Available,
          items: [{ id: "tag-1", name: "Canonical", color: "blue" }],
        },
        pullRequests: {
          associatedCount: 1,
          selected: { id: "closedloop-ai/closedloop-ai#7" },
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
          id: "closedloop-ai/closedloop-ai#7",
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
    // One page for `listBranches`, then the four `getBranchDetail` slots.
    // Three total left the FOURTH read — the Product gate — on the permissive
    // fallback, so this case gave the gate ordering no regression protection at
    // all (see the warning on `mockDetailCandidateSnapshots`).
    mockBranchCandidatePage(mockDb, [branchId], 1, candidateActivity);
    mockBranchCandidatePage(mockDb, [branchId], 1, candidateActivity);
    mockBranchCandidatePage(mockDb, [branchId], 1, candidateActivity);
    mockBranchCandidateIds(mockDb, [branchId], candidateActivity);
    mockBranchCandidateIds(mockDb, [branchId], candidateActivity);
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
    // ISS-8821: no linked session, so there is no earliest activity evidence to
    // measure from. Pinned as `null` rather than left unasserted, which is how
    // the shipped defect — `firstActivityT` filled from the LAST-active instant
    // — survived beside the `lastActivityT` assertion above.
    expect(detail?.leadTime.firstActivityT).toBeNull();
    expect(list.items[0]?.canonicalActivityEvidence).not.toMatchObject({
      latestAtom: { sourceEventId: "later-row-query-atom" },
    });
    // ISS-8016: the list select must NOT load the `activityAtoms` relation. It
    // used to, and every fetched row was discarded by
    // `applyBranchCandidateActivitySnapshot` — 610 bound params and no LIMIT for
    // a value nothing read. This assertion replaces the one that pinned that
    // dead read in place; the evidence contract itself is asserted above, and
    // the `later-row-query-atom` expectation is what proves the candidate atom
    // still wins.
    const listSelect = mockDb.artifact.findMany.mock.calls.at(-1)?.[0]?.select;
    expect(listSelect?.branch?.select?.activityAtoms).toBeUndefined();
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
    const baseSessionLink = makeSessionLink(branchId, sessionId, "4.00");
    const sessionLink = {
      ...baseSessionLink,
      source: {
        ...baseSessionLink.source,
        status: SESSION_STATUS.ACTIVE,
      },
    };
    // Queued rather than left on the permissive fallback: an exhausted queue
    // answers every candidate read with an eligible single row, so the Product
    // gate's slot went unexercised and a reorder past it went unnoticed.
    mockDetailCandidateSnapshots(mockDb, [branchId]);
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    mockDb.artifactLink.findMany.mockImplementation((args) => {
      if (args.select?.source?.select?.session) {
        return Promise.resolve([sessionLink, sessionLink]);
      }
      if (args.select?.branchParticipation) {
        return Promise.resolve([
          {
            targetId: branchId,
            sourceId: sessionId,
            branchParticipation: null,
            metadata: null,
          },
        ]);
      }
      return Promise.resolve([]);
    });

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );
    const projection = detail?.canonicalProjection;

    expect(mockDb.artifactLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          targetId: true,
          metadata: true,
        }),
      })
    );
    expect(mockDb.artifactLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          source: expect.objectContaining({
            select: expect.objectContaining({
              session: expect.any(Object),
            }),
          }),
        }),
      })
    );
    expect(mockDb.artifactLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          sourceId: true,
          targetId: true,
          branchParticipation: true,
        }),
      })
    );

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
          rawStatus: SESSION_STATUS.ACTIVE,
        },
      ],
    });
    expect(detail?.sessions).toHaveLength(1);
    expect(detail?.estimatedCostUsd).toBe(4);
    expect(detail?.attributedCostUsd).toBe(4);
    // ISS-6949: the attributed cost is already on the detail when the metric
    // attacher reads it. `toBe(4)` rather than `toBeDefined()` so a reorder
    // cannot pass by leaving the replicated fallback in place.
    expect(detailMetricAttachCostSnapshots).toEqual([
      { estimatedCostUsd: 4, attributedCostUsd: 4 },
    ]);
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

  it("ISS-8821: anchors detail firstActivityT on the earliest linked session start, not the last-active instant", async () => {
    // Three instants, all different, so neither the shipped defect (first = the
    // last-active instant) nor a max-instead-of-min mistake can satisfy this.
    const earliestStart = new Date("2026-07-03T01:00:00.000Z");
    const laterStart = new Date("2026-07-03T02:30:00.000Z");
    const lastActiveAt = new Date("2026-07-03T06:00:00.000Z");
    const activityAtom = {
      version: BranchActivityAtomVersion.V1,
      source: BranchActivitySource.GitHead,
      sourceEventId: "iss-8821-head-sha",
      occurredAt: lastActiveAt,
      attributionKind: BranchActivityAttributionKind.Branch,
      pullRequestDetailId: null,
      completeness: BranchActivityEvidenceCompleteness.Complete,
    };
    const row = makeBranchRow({ activityAtoms: [activityAtom] });
    const candidateActivity = new Map([[branchId, activityAtom]]);
    mockBranchCandidateIds(mockDb, [branchId], candidateActivity);
    mockBranchCandidateIds(mockDb, [branchId], candidateActivity);
    mockBranchCandidateIds(mockDb, [branchId], candidateActivity);
    mockBranchCandidateIds(mockDb, [branchId], candidateActivity);
    mockDb.artifact.findFirst.mockResolvedValue(row);
    mockDb.artifactLink.findMany.mockImplementation((args) => {
      if (args.select?.source?.select?.session) {
        return Promise.resolve([
          // Deliberately NOT in chronological order, so a fixture that happens
          // to be sorted cannot stand in for the minimum.
          makeSessionLink(branchId, "later-session", "1.00", null, null, null, {
            sessionStartedAt: laterStart,
          }),
          makeSessionLink(
            branchId,
            "earliest-session",
            "1.00",
            null,
            null,
            null,
            { sessionStartedAt: earliestStart }
          ),
        ]);
      }
      return Promise.resolve([]);
    });

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    expect(detail?.leadTime.firstActivityT).toBe(earliestStart.toISOString());
    expect(detail?.leadTime.lastActivityT).toBe(lastActiveAt.toISOString());
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
    // Same reason as above: the Product gate's candidate read has to come from
    // the queue, not the permissive fallback an exhausted queue supplies.
    mockDetailCandidateSnapshots(mockDb, [branchId]);
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
        repositoryFullName: "closedloop-ai/closedloop-ai",
        pullRequestNumber: 7,
      }
    );

    expect(detail?.associatedPullRequests?.selectedId).toBe(
      "closedloop-ai/closedloop-ai#7"
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
    // A second eligible Branch in the org, so the global even-split divisor's
    // slot carries a value the gate's slot cannot coincide with.
    const globalDivisorBranchId = "22222222-2222-4222-8222-222222222222";
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
    // One page for `listBranches`, then the four `getBranchDetail` slots. The
    // extra `mockBranchCandidateIds` that used to sit between them shifted every
    // detail slot by one: the divisor pager ate the gate's row and
    // `globalEligibleBranchIds` was never consumed at all, which only passed
    // because both were `[branchId]`. `globalDivisorBranchId` differs now, so
    // that shift reds instead of coinciding.
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDetailCandidateSnapshots(mockDb, [globalDivisorBranchId]);
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
      replicatedUsd: 2.5,
      attributedUsd: 2.5,
    });
    expect(detail?.estimatedCostUsd).toBe(2.5);
    expect(detail?.attributedCostUsd).toBe(2.5);
  });

  it("ISS-10364: folds a long-silent run and an unrecognized spelling to Active in the canonical list membership", async () => {
    // COUNTERFACTUAL. This pinned Stale and Unknown surviving onto branch
    // membership. The operator retired both words on 2026-09-23, so the two
    // inputs are kept exactly as they were — a row silent 48h past a 24h
    // cutoff, and a spelling this build does not model — and only the verdict
    // moves. A slice that restores either fold has to edit this assertion.
    const staleLinkBase = makeSessionLink(
      branchId,
      "stale-session",
      "0",
      null,
      { linkKind: SessionArtifactLinkKind.SessionBranch },
      BranchParticipationKind.Wrote,
      {
        sessionEndedAt: null,
        sessionStartedAt: new Date(now.getTime() - 72 * 60 * 60 * 1000),
      }
    );
    const staleLink = {
      ...staleLinkBase,
      source: {
        ...staleLinkBase.source,
        status: SESSION_STATUS.ACTIVE,
        session: {
          ...staleLinkBase.source.session,
          awaitingInputSince: null,
          endsWithError: null,
          lastActivityAt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
        },
      },
    };
    const unknownLinkBase = makeSessionLink(
      branchId,
      "unknown-session",
      "0",
      null,
      { linkKind: SessionArtifactLinkKind.SessionBranch },
      BranchParticipationKind.Wrote
    );
    const unknownLink = {
      ...unknownLinkBase,
      source: {
        ...unknownLinkBase.source,
        status: "future-session-status",
        session: {
          ...unknownLinkBase.source.session,
          awaitingInputSince: null,
          endsWithError: null,
          lastActivityAt: now,
        },
      },
    };
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow()]);
    mockDb.artifactLink.findMany.mockResolvedValue([staleLink, unknownLink]);

    const list = await branchReadService.listBranches(organizationId, {
      limit: 10,
      offset: 0,
    });

    expect(
      list.items[0]?.canonicalProjection?.common.membership.sessions?.map(
        (session) => session.displayedStatus
      )
    ).toEqual([SESSION_STATUS.ACTIVE, SESSION_STATUS.ACTIVE]);
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
    mockDetailCandidateSnapshots(mockDb, [branchId]);
    mockDb.artifact.findFirst.mockResolvedValue(makeBranchRow());
    mockDb.artifactLink.findMany.mockResolvedValue([reviewedLink]);

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    expect(detail?.dataState).toBe(BranchDataState.NoSessions);
    expect(detail?.canonicalProjection).toMatchObject({
      common: {
        membership: { sessionIds: [], qualifyingSessionCount: 0, sessions: [] },
      },
      list: {
        dataState: BranchDataState.NoSessions,
        cost: { replicatedUsd: null, attributedUsd: null },
      },
    });
    expect(detail?.estimatedCostUsd).toBeNull();
    expect(detail?.attributedCostUsd).toBeNull();
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
