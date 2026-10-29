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

import { BranchActivitySource } from "@repo/api/src/types/branch-activity";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import { log } from "@repo/observability/log";
import {
  branchId,
  createMockDb,
  makeBranchRow,
  makeSessionLink,
  mockBranchCandidateIds,
  mockBranchCandidatePage,
  now,
  organizationId,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import { FIXED_WINDOW_EMISSION_WINDOW_MS } from "@/lib/observability/fixed-window-emission-throttle";
import {
  getMockWithDb,
  mockWithDbCall,
  mockWithDbTx,
} from "../../__tests__/utils/db-helpers";
import {
  BranchListEnrichmentFailureKind,
  BranchListEnrichmentRead,
  branchListEnrichmentFailureThrottle,
  branchListEnrichmentRecoveryThrottle,
} from "./branch-list-enrichment";
import { branchReadService } from "./branch-read-service";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const FAILED_OPEN_EVENT = "[branches-list] enrichment read failed open";
const RECOVERED_EVENT =
  "[branches-list] enrichment failure aborted the snapshot; retried without it";

const PUSH_BEFORE_SHA = "b".repeat(40);
const PUSH_AFTER_SHA = "c".repeat(40);

/**
 * ISS-12346: every analytics read also opens the cohort cost-facts transaction
 * (`readCostMetricFacts`), on its own connection outside the branch snapshot.
 * What these cases pin is how many BRANCH SNAPSHOTS a push-LOC failure buys, so
 * each expectation is that count plus one of these per read.
 */
const COST_FACTS_TX_PER_ANALYTICS_READ = 1;

/**
 * ISS-10009 part 2: the read → attach → project wiring for per-push LOC.
 *
 * The projection is unit-tested against hand-built atoms in
 * `branch-push-loc-projection.test.ts`; this file exists because that suite
 * stays green if the service never issues the read, or issues it and drops the
 * result before projecting.
 */
describe("branchReadService — ISS-10009 per-push LOC wiring", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    // Module-level emission budgets: every case here fails for the same org.
    branchListEnrichmentFailureThrottle.clear();
    branchListEnrichmentRecoveryThrottle.clear();
    mockDb = createMockDb();
    mockWithDbCall(mockDb);
    mockWithDbTx(mockDb);
    mockDb.commitDetail.findMany.mockResolvedValue([]);
    mockDb.artifactLink.findMany.mockResolvedValue([]);
  });

  function seedCohort() {
    mockBranchCandidateIds(mockDb, [branchId]);
    mockBranchCandidateIds(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({
        firstPushedAt: new Date("2026-07-01T00:00:00.000Z"),
        pullRequestDetails: [],
        currentPullRequestDetail: null,
        fileChanges: [{ path: "a.ts", additions: 500, deletions: 100 }],
      }),
    ]);
  }

  it("projects the cohort's captured pushes into the pushed-LOC total", async () => {
    seedCohort();
    mockDb.branchActivityAtom.findMany.mockResolvedValue([
      {
        branchArtifactId: branchId,
        sourceEventId: "delivery-1",
        occurredAt: new Date("2026-07-01T00:00:00.000Z"),
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        beforeSha: PUSH_BEFORE_SHA,
        afterSha: PUSH_AFTER_SHA,
        linesAdded: 13,
        linesRemoved: 4,
      },
    ]);

    const analytics = await branchReadService.getBranchAnalytics(
      organizationId,
      { limit: 50, offset: 0 }
    );

    // 17, the captured push's own delta — NOT the 600-line file cache the same
    // row still carries, which is what the retired snapshot arm would report.
    expect(analytics.canonicalMetrics?.totalLocPushed?.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 17,
    });
  });

  it("scopes the push read to the cohort's branches and the push lane", async () => {
    seedCohort();
    mockDb.branchActivityAtom.findMany.mockResolvedValue([]);

    await branchReadService.getBranchAnalytics(organizationId, {
      limit: 50,
      offset: 0,
    });

    const where = mockDb.branchActivityAtom.findMany.mock.calls.map(
      (call) => call[0]?.where
    );
    expect(where).toContainEqual(
      expect.objectContaining({
        organizationId,
        branchArtifactId: { in: [branchId] },
        source: BranchActivitySource.PushLoc,
      })
    );
  });

  it("publishes no pushed-LOC total when capture holds nothing", async () => {
    seedCohort();
    mockDb.branchActivityAtom.findMany.mockResolvedValue([]);

    const analytics = await branchReadService.getBranchAnalytics(
      organizationId,
      { limit: 50, offset: 0 }
    );

    expect(analytics.canonicalMetrics?.totalLocPushed?.current).toEqual({
      state: BranchMetricAvailability.Unavailable,
      value: null,
    });
  });

  // The two call sites `getBranchAnalytics` cannot speak for. All three attach
  // the same evidence, and on an EMPTY capture their output is identical whether
  // the attach ran or not — so only a seeded atom tells the wiring apart from
  // its absence, which is why both cases below seed one.
  it("projects the captured push into the Branch detail's own metrics", async () => {
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findFirst.mockResolvedValue(
      makeBranchRow({
        firstPushedAt: new Date("2026-07-01T00:00:00.000Z"),
        pullRequestDetails: [],
        currentPullRequestDetail: null,
        fileChanges: [{ path: "a.ts", additions: 500, deletions: 100 }],
      })
    );
    mockDb.artifactLink.findMany.mockResolvedValue([
      makeSessionLink(branchId, "session-1", "1"),
    ]);
    mockDb.branchActivityAtom.findMany.mockResolvedValue([capturedPushRow()]);

    const detail = await branchReadService.getBranchDetail(
      organizationId,
      branchId
    );

    expect(pushLocReadScopes()).toContainEqual(
      expect.objectContaining({
        organizationId,
        branchArtifactId: { in: [branchId] },
        source: BranchActivitySource.PushLoc,
      })
    );
    // The detail's LOC/$ is driven by the captured push's own 17 lines over $1 —
    // NOT by the 600-line file cache the same row still carries.
    expect(detail?.canonicalMetrics?.locPerDollar).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 17,
    });
  });

  it("projects the captured push into the exact-id cohort's metrics", async () => {
    seedCohort();
    mockDb.branchActivityAtom.findMany.mockResolvedValue([capturedPushRow()]);

    const cohort = await branchReadService.getBranchCohortAnalytics(
      organizationId,
      { branchIds: [branchId] }
    );

    expect(pushLocReadScopes()).toContainEqual(
      expect.objectContaining({
        organizationId,
        branchArtifactId: { in: [branchId] },
        source: BranchActivitySource.PushLoc,
      })
    );
    expect(cohort.canonicalMetrics?.totalLocPushed?.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 17,
    });
  });

  // ISS-10804. The abort itself is driven against real PostgreSQL in
  // `branch-analytics-push-loc-abort.integration.test.ts`; these two pin which
  // failures buy the second snapshot.
  it("re-runs the analytics snapshot once without a push-LOC read that failed", async () => {
    seedCohort();
    mockDb.branchActivityAtom.findMany.mockRejectedValue(
      Object.assign(new Error("canceling statement due to statement timeout"), {
        code: "P2010",
      })
    );

    const analytics = await branchReadService.getBranchAnalytics(
      organizationId,
      { limit: 50, offset: 0 }
    );

    expect(getMockWithDb().tx).toHaveBeenCalledTimes(
      2 + COST_FACTS_TX_PER_ANALYTICS_READ
    );
    expect(pushLocReadScopes()).toHaveLength(1);
    expect(analytics.canonicalMetrics?.activeBranches.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 1,
    });
    expect(analytics.canonicalMetrics?.totalLocPushed?.current).toEqual({
      state: BranchMetricAvailability.Unavailable,
      value: null,
    });
  });

  // The two ways the snapshot fails through no fault of this read. The 25P02
  // envelope is the one Prisma 7.10's pg adapter raises for a model query on an
  // aborted transaction, measured against a real database.
  it.each([
    {
      name: "expired (P2028)",
      error: Object.assign(
        new Error("Transaction API error: Transaction already closed"),
        { code: "P2028" }
      ),
    },
    {
      name: "already aborted by another read (25P02)",
      error: Object.assign(
        new Error("current transaction is aborted, commands ignored"),
        {
          code: "P2039",
          meta: { driverAdapterError: { cause: { originalCode: "25P02" } } },
        }
      ),
    },
  ])(
    "does not re-run an analytics snapshot $name under the push-LOC read",
    async ({ error }) => {
      seedCohort();
      mockDb.branchActivityAtom.findMany.mockRejectedValue(error);

      await expect(
        branchReadService.getBranchAnalytics(organizationId, {
          limit: 50,
          offset: 0,
        })
      ).rejects.toBe(error);
      expect(getMockWithDb().tx).toHaveBeenCalledTimes(
        1 + COST_FACTS_TX_PER_ANALYTICS_READ
      );
    }
  );

  // #8138 review (tamsinb): a throw that never reached PostgreSQL leaves the
  // snapshot healthy, so it degrades in place instead of buying a second one.
  it("degrades push LOC in place when its read fails without touching the database", async () => {
    seedCohort();
    mockDb.branchActivityAtom.findMany.mockRejectedValue(
      new TypeError("cannot read properties of undefined")
    );
    const errorLog = vi.spyOn(log, "error");

    const analytics = await branchReadService.getBranchAnalytics(
      organizationId,
      { limit: 50, offset: 0 }
    );

    expect(getMockWithDb().tx).toHaveBeenCalledTimes(
      1 + COST_FACTS_TX_PER_ANALYTICS_READ
    );
    expect(analytics.canonicalMetrics?.activeBranches.current).toEqual({
      state: BranchMetricAvailability.Complete,
      value: 1,
    });
    expect(analytics.canonicalMetrics?.totalLocPushed?.current).toEqual({
      state: BranchMetricAvailability.Unavailable,
      value: null,
    });
    expect(errorLog).toHaveBeenCalledWith(
      FAILED_OPEN_EVENT,
      expect.objectContaining({
        organizationId,
        read: BranchListEnrichmentRead.PushLoc,
        failureKind: BranchListEnrichmentFailureKind.ProgrammingError,
      })
    );
  });

  // #8138 review (whitlockk): the analytics routes are polled, so the recovery
  // event is bounded per org and reason like the failed-open one.
  it("bounds the recovery event per org in a window and rolls up the rest", async () => {
    seedCohort();
    mockDb.branchActivityAtom.findMany.mockRejectedValue(
      Object.assign(new Error("canceling statement due to statement timeout"), {
        code: "P2010",
      })
    );
    const errorLog = vi.spyOn(log, "error");
    const readAnalytics = () =>
      branchReadService.getBranchAnalytics(organizationId, {
        limit: 50,
        offset: 0,
      });
    const recoveryLines = () =>
      errorLog.mock.calls.filter(([message]) => message === RECOVERED_EVENT);

    await readAnalytics();
    await readAnalytics();
    await readAnalytics();

    expect(getMockWithDb().tx).toHaveBeenCalledTimes(
      6 + 3 * COST_FACTS_TX_PER_ANALYTICS_READ
    );
    expect(recoveryLines()).toHaveLength(1);

    vi.setSystemTime(now.getTime() + FIXED_WINDOW_EMISSION_WINDOW_MS);
    await readAnalytics();

    expect(recoveryLines().map(([, fields]) => fields)).toEqual([
      expect.objectContaining({ organizationId, occurrences: 1 }),
      expect.objectContaining({
        organizationId,
        unavailableReads: [BranchListEnrichmentRead.PushLoc],
        occurrences: 2,
        aggregated: true,
      }),
      expect.objectContaining({ organizationId, occurrences: 1 }),
    ]);
  });

  function capturedPushRow() {
    return {
      branchArtifactId: branchId,
      sourceEventId: "delivery-1",
      occurredAt: new Date("2026-07-01T00:00:00.000Z"),
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      beforeSha: PUSH_BEFORE_SHA,
      afterSha: PUSH_AFTER_SHA,
      linesAdded: 13,
      linesRemoved: 4,
    };
  }

  function pushLocReadScopes() {
    return mockDb.branchActivityAtom.findMany.mock.calls.map(
      (call) => call[0]?.where
    );
  }
});
