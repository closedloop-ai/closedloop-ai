import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import {
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
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

import {
  branchId,
  collectSqlValues,
  createMockDb,
  makeBranchRow,
  mockBranchCandidateIds,
  organizationId,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import { mockWithDbCall, mockWithDbTx } from "../../__tests__/utils/db-helpers";
import { branchReadService } from "./branch-read-service";

describe("branchReadService exact cohort analytics", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
    mockWithDbTx(mockDb);
    mockDb.commitDetail.findMany.mockResolvedValue([]);
  });

  it("intersects exact cohort IDs inside the authenticated organization corpus", async () => {
    const absentBranchId = "22222222-2222-4222-8222-222222222222";
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow()]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const response = await branchReadService.getBranchCohortAnalytics(
      organizationId,
      { branchIds: [absentBranchId, branchId] }
    );

    expect(response.matchedBranchIds).toEqual([branchId]);
    expect(response.canonicalMetrics.cohortSize).toBe(1);
    expect(branchCandidateValues(mockDb)).toEqual(
      expect.arrayContaining([organizationId, absentBranchId, branchId])
    );
    expect(mockDb.artifact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId }),
      })
    );
  });

  it("projects an inclusive UTC-day cohort as the requested fixed period", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow()]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const response = await branchReadService.getBranchCohortAnalytics(
      organizationId,
      {
        branchIds: [branchId],
        startDate: "2026-06-14T00:00:00.000Z",
        endDate: "2026-06-20T23:59:59.999Z",
      }
    );

    expect(response.canonicalMetrics.period).toBe(BranchMetricPeriod.SevenDays);
    expect(response.canonicalMetrics.label).toBe(
      BranchMetricComparisonLabel.WeekOverWeek
    );
    expect(response.canonicalMetrics.window).toEqual({
      startAt: "2026-06-14T00:00:00.000Z",
      endAt: "2026-06-21T00:00:00.000Z",
    });
  });

  it("projects cohort Last active from the authorized candidate snapshot", async () => {
    const candidateOccurredAt = new Date("2026-06-18T12:00:00.000Z");
    const candidateAtom = {
      version: BranchActivityAtomVersion.V1,
      source: BranchActivitySource.GitHead,
      sourceEventId: "candidate-head",
      occurredAt: candidateOccurredAt,
      attributionKind: BranchActivityAttributionKind.Branch,
      pullRequestDetailId: null,
      completeness: BranchActivityEvidenceCompleteness.Complete,
    };
    mockBranchCandidateIds(
      mockDb,
      [branchId],
      new Map([[branchId, candidateAtom]])
    );
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        activityAtoms: [
          {
            ...candidateAtom,
            sourceEventId: "later-row-query-head",
            occurredAt: new Date("2099-01-01T00:00:00.000Z"),
          },
        ],
      }),
    ]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);

    const response = await branchReadService.getBranchCohortAnalytics(
      organizationId,
      { branchIds: [branchId] }
    );

    expect(response.canonicalMetrics.lastActiveAt).toMatchObject({
      state: BranchMetricAvailability.Partial,
      value: candidateOccurredAt.toISOString(),
    });
  });

  it("rejects malformed exact cohort requests before database work", () => {
    expect(() =>
      branchReadService.getBranchCohortAnalytics(organizationId, {
        branchIds: [],
      })
    ).toThrow();

    expect(mockDb.$queryRaw).not.toHaveBeenCalled();
    expect(mockDb.artifact.findMany).not.toHaveBeenCalled();
  });
});

function branchCandidateValues(
  mockDb: ReturnType<typeof createMockDb>
): unknown[] {
  return mockDb.$queryRaw.mock.calls.flatMap((call) =>
    collectSqlValues(call[0])
  );
}
