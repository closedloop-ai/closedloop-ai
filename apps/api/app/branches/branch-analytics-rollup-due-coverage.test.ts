import type { Prisma } from "@repo/database";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dueRollupOrganizationRow } from "@/__tests__/support/branches/branch-analytics-rollup.test-helpers";
import {
  BRANCH_ANALYTICS_ROLLUP_LAG_CEILING_MS,
  type BranchAnalyticsRollupBatchSummary,
  BranchAnalyticsRollupState,
} from "./branch-analytics-rollup-contract";

// ISS-9713 branch coverage, mirroring branch-analytics-rollup-due.test.ts's
// withDb/withDb.tx mock exactly (a separate file, not an addition to it, so
// the top-level @repo/database mock stays scoped and does not leak into
// branch-analytics-rollup-coverage.test.ts's fake-db-object style).

const mocks = vi.hoisted(() => {
  const withDb = vi.fn();
  const withDbTx = vi.fn();
  const dueQuery = vi.fn();
  const failureRecordExecute = vi.fn();
  return { dueQuery, failureRecordExecute, withDb, withDbTx };
});

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  return {
    ...actual,
    withDb: Object.assign(mocks.withDb, { tx: mocks.withDbTx }),
  };
});

import { refreshDueBranchAnalyticsRollups } from "./branch-analytics-rollup";

const NOW = new Date("2026-09-02T15:00:00.000Z");
// An hour back rather than at NOW: a cursor stamped at the run clock produces
// an age of exactly 0, which the summary contract calls out as the value not to
// report, so a fixture at NOW would quietly sit on that boundary.
const ROLLED_UP_AT = new Date(NOW.getTime() - 60 * 60 * 1000);
// Deliberate literals, not a missing import. BRANCH_ANALYTICS_ROLLUP_DUE_INTERVAL_MS
// is exported by the contract module (ISS-10079 moved it there for the
// integration suite's control query, which must derive the SAME window as
// production to be a control at all) and BRANCH_ANALYTICS_ROLLUP_DEFAULT_ORGANIZATION_LIMIT
// stays module-private. This suite is the PIN on both: importing either would
// make it agree with whatever production says, and a silent change to the
// due-window derivation or to the omitted-limit fallback would stop failing.
const DUE_INTERVAL_MS = 4 * 60 * 1000;
const DEFAULT_ORGANIZATION_LIMIT = 100;
const LAG_CEILING_SECONDS = BRANCH_ANALYTICS_ROLLUP_LAG_CEILING_MS / 1000;

describe("due Branch analytics rollup refresh defaulting and rollup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withDb.mockImplementation((callback) =>
      callback({
        $executeRaw: mocks.failureRecordExecute,
        $queryRaw: mocks.dueQuery,
      })
    );
    mocks.failureRecordExecute.mockResolvedValue(1);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults now to the current clock and probes one past the default organizationLimit of 100 in the due-organization query, then returns an empty summary without entering the per-org refresh loop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.dueQuery.mockResolvedValue([]);

    const summary = await refreshDueBranchAnalyticsRollups({});

    const staleBefore = new Date(NOW.getTime() - DUE_INTERVAL_MS);
    // Every LIMIT in the query is the probe, not the bound: a page of exactly
    // `organizationLimit` rows means nothing was left behind, so only a row
    // past the bound can report truncation. The extra row is sliced off before
    // any organization is refreshed.
    const probeLimit = DEFAULT_ORGANIZATION_LIMIT + 1;
    // ISS-10079 removed the outer re-filter and the LEFT JOIN back to the state
    // table that carried it — both class CTEs have already applied that exact
    // predicate, and it was that join's NULL `as_of` which let one class
    // monopolize the bound. Its three bind parameters disappearing is how a
    // re-introduction of the merged ordering shows up here.
    expect(dueQueryValues()).toEqual([
      BranchAnalyticsRollupState.Fresh,
      staleBefore,
      LAG_CEILING_SECONDS,
      probeLimit,
      probeLimit,
      probeLimit,
    ]);
    expect(summary).toEqual({
      organizations: 0,
      batches: 0,
      sessionsRefreshed: 0,
      upsertedRows: 0,
      completeOrganizations: 0,
      incompleteOrganizations: 0,
      failedOrganizations: 0,
      failureCategories: [],
      failures: [],
      maxLagSeconds: null,
      organizationLimitReached: false,
      budgetExhausted: false,
      oldestDueAsOfAgeMs: null,
      neverRolledUpOrganizations: 0,
    });
    expect(mocks.withDbTx).not.toHaveBeenCalled();
  });

  it("reports a null cron-level maxLagSeconds when the only refreshed organization reports no lag, rather than a measured zero", async () => {
    mocks.dueQuery.mockResolvedValue([
      dueRollupOrganizationRow("org-null-lag", ROLLED_UP_AT),
    ]);
    mocks.withDbTx.mockResolvedValueOnce(
      batchSummary("org-null-lag", true, 1, 1, null)
    );

    const summary = await refreshDueBranchAnalyticsRollups({
      now: NOW,
      organizationLimit: 1,
    });

    expect(summary.maxLagSeconds).toBeNull();
    expect(summary.batches).toBe(1);
  });

  it("keeps the highest reported lag as the maximum and still counts a null-lag organization as a completed batch", async () => {
    mocks.dueQuery.mockResolvedValue([
      dueRollupOrganizationRow("org-null-lag", ROLLED_UP_AT),
      dueRollupOrganizationRow("org-known-lag", ROLLED_UP_AT),
    ]);
    mocks.withDbTx
      .mockResolvedValueOnce(batchSummary("org-null-lag", true, 1, 1, null))
      .mockResolvedValueOnce(batchSummary("org-known-lag", true, 1, 1, 42));

    const summary = await refreshDueBranchAnalyticsRollups({
      now: NOW,
      organizationLimit: 2,
    });

    expect(summary.maxLagSeconds).toBe(42);
    expect(summary.batches).toBe(2);
    expect(summary.failedOrganizations).toBe(0);
    expect(dueQueryValues()).toContain(3);
  });
});

function dueQueryValues(): unknown[] {
  const sql = mocks.dueQuery.mock.calls.at(0)?.at(0) as Prisma.Sql | undefined;
  return sql?.values ?? [];
}

function batchSummary(
  organizationId: string,
  complete: boolean,
  sessionsRefreshed: number,
  upsertedRows: number,
  lagSeconds: number | null
): BranchAnalyticsRollupBatchSummary {
  return {
    organizationId,
    sessionsRefreshed,
    deletedRows: sessionsRefreshed,
    upsertedRows,
    complete,
    lagSeconds,
    sourceWatermarkEventCreatedAt: NOW,
    materializedThroughEventCreatedAt: NOW,
  };
}
