import { BRANCH_EVALUATION_NOW_PARAM } from "@repo/api/src/types/branch";
import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import {
  BRANCH_LIST_MAX_FILTER_VALUE_LENGTH,
  BRANCH_LIST_MAX_FILTER_VALUES,
  BranchListPageMode,
} from "@repo/api/src/types/branch-list-contract";
import {
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import { log } from "@repo/observability/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

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
  mockBranchCandidatePage,
  now,
  organizationId,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import { mockWithDbCall, mockWithDbTx } from "../../__tests__/utils/db-helpers";
import {
  BRANCH_LAST_ACTIVE_COHORT_INVALID_EVENT,
  resetBranchLastActiveCohortThrottle,
} from "./branch-last-active-cohort";
import { branchListQuerySchema } from "./branch-list-query";
import { branchReadService } from "./branch-read-service";

describe("branchReadService exact cohort analytics", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    // The cohort detector's emission throttle is module-scoped and keyed on
    // (org, issue signature); the suite pins the clock, so without this the two
    // call-site cases below would share one window and the second would be
    // suppressed rather than actually exercising its wiring.
    resetBranchLastActiveCohortThrottle();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
    mockWithDbTx(mockDb);
    mockDb.commitDetail.findMany.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("captures the actual operation instant independently of the date upper bound", async () => {
    mockBranchCandidatePage(mockDb, []);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 20,
      offset: 0,
      startDate: new Date("2026-07-01T00:00:00.000Z"),
      endDate: new Date("2026-07-03T23:59:59.999Z"),
    });

    expect(response.lastActiveCohort?.evaluationNow).toBe(now.toISOString());
  });

  // ISS-7387 — the wiring half, driven through the live path rather than the
  // detector. `cohortKey` serializes the applied filters and
  // `branchListQuerySchema` admits 100 values of 200 characters per key, so a
  // maxed-out filter set already serializes past the cohort schema's 16 KiB
  // bound; the client then drops the whole cohort with no signal (PR #5492).
  // Deleting the call in `branchReadService` leaves the detector's own suite
  // green, which is what this case exists to stop.
  it("reports a cohort the maxed-out filter set made invalid", async () => {
    mockBranchCandidatePage(mockDb, [], 2);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 20,
      offset: 0,
      repo: maxedOutRepoFilter(),
    });

    expect(log.warn).toHaveBeenCalledWith(
      BRANCH_LAST_ACTIVE_COHORT_INVALID_EVENT,
      expect.objectContaining({
        organizationId,
        issues: expect.arrayContaining([
          expect.objectContaining({ path: "cohortKey" }),
        ]),
      })
    );
    // Detection only — the field still ships, and the client still degrades it.
    expect(response.lastActiveCohort?.total).toBe(2);
  });

  // The service builds the cohort at TWO call sites — the server-pagination
  // branch and the default branch — and the case above only reaches the second.
  // That matters rather than being tidiness: web and Desktop both request
  // `BranchListPageMode.Server`, so the legacy branch the case above drives is
  // the one production does NOT take (#5529 review, whitlockk). Reverting the
  // server-branch wrapper to the bare constructor leaves every other case in
  // this file green.
  it("reports the same invalid cohort on the server-pagination path", async () => {
    mockBranchCandidateIds(mockDb, []);

    await branchReadService.listBranches(organizationId, {
      limit: 20,
      offset: 0,
      pageMode: BranchListPageMode.Server,
      repo: maxedOutRepoFilter(),
    });

    // Named down to the offending field, not just "some warn happened": the
    // assertion has to fail for the RIGHT reason if this branch stops
    // detecting, rather than be satisfied by an unrelated org-scoped warning.
    expect(log.warn).toHaveBeenCalledWith(
      BRANCH_LAST_ACTIVE_COHORT_INVALID_EVENT,
      expect.objectContaining({
        organizationId,
        issues: expect.arrayContaining([
          expect.objectContaining({ path: "cohortKey" }),
        ]),
      })
    );
  });

  it("says nothing about a cohort built from an ordinary filter set", async () => {
    mockBranchCandidatePage(mockDb, [], 2);

    await branchReadService.listBranches(organizationId, {
      limit: 20,
      offset: 0,
      repo: ["closedloop-ai/closedloop-ai"],
    });

    expect(log.warn).not.toHaveBeenCalledWith(
      BRANCH_LAST_ACTIVE_COHORT_INVALID_EVENT,
      expect.any(Object)
    );
  });

  it("ignores an evaluationNow supplied on the wire without refusing the read", () => {
    // ISS-10350: the continuation clock is server-internal — a client-supplied
    // one is never honored. It is still ACCEPTED (whitlockk review): the shared
    // `BranchQueryFilters` type declares the key and the HTTP/desktop data
    // sources serialize that type wholesale, so refusing it would answer a
    // version-skewed caller's entire Branches list with a 400.
    const parsed = branchListQuerySchema.safeParse({
      [BRANCH_EVALUATION_NOW_PARAM]: new Date().toISOString(),
    });

    expect(parsed.success).toBe(true);
    // The key is dropped, not carried: nothing downstream can pick it back up.
    expect(parsed.data).not.toHaveProperty(BRANCH_EVALUATION_NOW_PARAM);
    // Positive control on the same schema — `.strict()` still refuses an
    // unknown key, so the assertion above is a deliberate exemption and not a
    // boundary that stopped checking.
    expect(
      branchListQuerySchema.safeParse({ notAParameter: "x" }).success
    ).toBe(false);
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

  it("rejects malformed exact cohort requests before database work", async () => {
    // ISS-11117 made this method `async` (the metric projection moved after the
    // read snapshot so the Pensero read can be the outermost transaction), so
    // the schema's refusal now arrives as a REJECTION rather than a synchronous
    // throw. What the case pins is unchanged and still load-bearing: the
    // refusal happens before any database work.
    await expect(
      branchReadService.getBranchCohortAnalytics(organizationId, {
        branchIds: [],
      })
    ).rejects.toThrow();

    expect(mockDb.$queryRaw).not.toHaveBeenCalled();
    expect(mockDb.artifact.findMany).not.toHaveBeenCalled();
  });
});

/**
 * The largest `repo` filter `branchListQuerySchema` accepts.
 *
 * BOTH bounds come from the contract, and that is load-bearing rather than
 * tidiness: this test calls `listBranches` directly, so nothing here re-validates
 * the fixture against the query schema. With the per-value length written out as
 * a literal, lowering the schema's bound would leave this emitting over-long
 * values — the assertion below would stay green while the scenario it claims to
 * pin (a schema-ADMISSIBLE filter set serializing past `cohortKey`'s 16 KiB
 * bound) had quietly become unreachable.
 */
function maxedOutRepoFilter(): string[] {
  return Array.from(
    { length: BRANCH_LIST_MAX_FILTER_VALUES },
    (_unused, index) =>
      `${index}`.padEnd(BRANCH_LIST_MAX_FILTER_VALUE_LENGTH, "r")
  );
}

function branchCandidateValues(
  mockDb: ReturnType<typeof createMockDb>
): unknown[] {
  return mockDb.$queryRaw.mock.calls.flatMap((call) =>
    collectSqlValues(call[0])
  );
}
