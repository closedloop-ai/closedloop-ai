import { BranchListPageMode } from "@repo/api/src/types/branch-list-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "@/__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ChecksStatus: { UNKNOWN: "UNKNOWN" },
  });
});

import {
  branchId,
  createMockDb,
  makeBranchRow,
  makeSessionLink,
  mockBranchCandidateIds,
  now,
  organizationId,
  renderSql,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import {
  getMockWithDb,
  mockWithDbCall,
  mockWithDbTx,
} from "@/__tests__/utils/db-helpers";
import { branchReadService } from "./branch-read-service";

// ISS-8016 — the Branches analytics read ran the hand-written candidate LATERAL
// TWICE per request: once on the Product predicate for the visible cohort and
// once on the metric-denominator predicate for the divisor cohort. In production
// trace 948e162617ac30f3cd39fc9c87b668ba those two scans were 4,788.8 ms and
// 1,845.5 ms of a 16,251 ms request that then blew the 15,000 ms RepeatableRead
// budget and returned 500. Product eligibility is composed as "denominator AND
// published", so one scan on the denominator predicate that selects the
// publication test as a column yields both cohorts.
//
// These cases execute `getBranchAnalytics` against the raw-SQL mock and COUNT
// the statements carrying the LATERAL. A test that only asserted the response
// shape cannot see a second scan at all.
describe("branchReadService analytics cohort scan (ISS-8016)", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockDb = createMockDb();
    getMockWithDb();
    mockWithDbCall(mockDb);
    mockWithDbTx(mockDb);
    mockDb.commitDetail.findMany.mockResolvedValue([]);
    mockDb.artifact.findMany.mockResolvedValue([makeBranchRow({})]);
    mockDb.artifactLink.findMany.mockResolvedValue([
      makeSessionLink(branchId, "s-1", "4.00"),
    ]);
  });

  // Unconditional, not the last line of a case: if any case throws between the
  // install and a manual restore, the frozen clock leaks into every later file
  // in this worker and the failures surface far from the cause.
  afterEach(() => {
    vi.useRealTimers();
  });

  it("scans the candidate LATERAL once for a date-windowed analytics request", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);

    await branchReadService.getBranchAnalytics(organizationId, {
      limit: 50,
      offset: 0,
      startDate: new Date("2026-07-02T00:00:00.000Z"),
      endDate: new Date("2026-07-03T23:59:59.000Z"),
    });

    expect(lateralScanSql(mockDb)).toHaveLength(1);
  });

  it("scans the candidate LATERAL once for an un-windowed analytics request", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);

    await branchReadService.getBranchAnalytics(organizationId, {
      limit: 50,
      offset: 0,
    });

    expect(lateralScanSql(mockDb)).toHaveLength(1);
  });

  // davetho review: `loadServerBranchAnalyticsRowCohorts` returns early for a
  // server page with no date window, before the collapsed cohort block, so it
  // hands no `denominatorCandidates` forward and the populations read falls
  // back to its own `getBranchMetricDenominatorCandidates`. This case COUNTS
  // the candidate LATERAL on that exact path rather than arguing about it.
  it("scans the candidate LATERAL once for a server page with no date window", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);

    await branchReadService.getBranchAnalytics(organizationId, {
      limit: 50,
      offset: 0,
      pageMode: BranchListPageMode.Server,
    });

    expect(lateralScanSql(mockDb)).toHaveLength(1);
  });

  // ISS-8148 collapsed Product and the metric denominator into one population,
  // so this scan partitions nothing: there is no `productEligible` column, and
  // the publication test appears exactly ONCE, as the denominator's own filter.
  // A second occurrence would mean the retired partition had come back.
  it("reads both cohorts from the denominator predicate with no partition column", async () => {
    mockBranchCandidateIds(mockDb, [branchId]);

    await branchReadService.getBranchAnalytics(organizationId, {
      limit: 50,
      offset: 0,
      startDate: new Date("2026-07-02T00:00:00.000Z"),
    });

    const [sql] = lateralScanSql(mockDb);
    expect(sql).not.toContain('AS "productEligible"');
    expect(occurrences(sql ?? "", "b.first_pushed_at IS NOT NULL")).toBe(1);
  });
});

function lateralScanSql(mockDb: ReturnType<typeof createMockDb>): string[] {
  return mockDb.$queryRaw.mock.calls
    .map((call) => renderSql(call[0]))
    .filter((sql) => sql.includes("FROM branch_activity_atoms atom"));
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
