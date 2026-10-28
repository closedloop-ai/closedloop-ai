import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dueRollupOrganizationRow,
  neverRolledUpOrganizationRow,
  unstampedRollupOrganizationRow,
} from "@/__tests__/support/branches/branch-analytics-rollup.test-helpers";
import {
  collectSqlValues,
  normalizeRenderedSql,
  renderSql,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import {
  type BranchAnalyticsRollupBatchSummary,
  BranchAnalyticsRollupFailureCategory,
} from "./branch-analytics-rollup-contract";

const mocks = vi.hoisted(() => {
  const withDb = vi.fn();
  const withDbTx = vi.fn();
  const dueQuery = vi.fn();
  const failureRecordExecute = vi.fn();
  return {
    dueQuery,
    failureRecordExecute,
    withDb,
    withDbTx,
  };
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
const ONE_HOUR_MS = 60 * 60 * 1000;
const ROLLED_UP_AT = new Date(NOW.getTime() - ONE_HOUR_MS);

describe("due Branch analytics rollup refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withDb.mockImplementation((callback) =>
      callback({
        $executeRaw: mocks.failureRecordExecute,
        $queryRaw: mocks.dueQuery,
      })
    );
    mocks.dueQuery.mockResolvedValue([
      dueRollupOrganizationRow("org-a", ROLLED_UP_AT),
      dueRollupOrganizationRow("org-b", ROLLED_UP_AT),
      dueRollupOrganizationRow("org-c", ROLLED_UP_AT),
    ]);
    mocks.failureRecordExecute.mockResolvedValue(1);
  });

  // Unconditional: a case that throws between enabling and restoring would
  // otherwise leak a frozen clock into every later test in this worker.
  afterEach(() => {
    vi.useRealTimers();
  });

  it("isolates organization failures and continues the remaining refreshes", async () => {
    mocks.withDbTx
      .mockResolvedValueOnce(batchSummary("org-a", true, 1, 1, 2))
      .mockRejectedValueOnce(new Error("org-b refresh failed"))
      .mockResolvedValueOnce(batchSummary("org-c", false, 2, 3, 8));

    const summary = await refreshDueBranchAnalyticsRollups({
      sessionLimit: 10,
      now: NOW,
      organizationLimit: 3,
    });

    expect(summary).toEqual({
      organizations: 3,
      batches: 2,
      sessionsRefreshed: 3,
      upsertedRows: 4,
      completeOrganizations: 1,
      incompleteOrganizations: 1,
      failedOrganizations: 1,
      failureCategories: [BranchAnalyticsRollupFailureCategory.Unknown],
      failures: [
        {
          organizationId: "org-b",
          failureCategory: BranchAnalyticsRollupFailureCategory.Unknown,
        },
      ],
      maxLagSeconds: 8,
      // Three due organizations under a bound of three is a FULL page, not a
      // truncated one — every one of them ran.
      organizationLimitReached: false,
      budgetExhausted: false,
      oldestDueAsOfAgeMs: ONE_HOUR_MS,
      neverRolledUpOrganizations: 0,
    });
    expect(mocks.withDbTx).toHaveBeenCalledTimes(3);
    expect(mocks.failureRecordExecute).toHaveBeenCalledOnce();
    const failureSql = renderSql(mocks.failureRecordExecute.mock.calls[0]?.[0]);
    expect(failureSql).toContain("ON CONFLICT (organization_id)");
    expect(failureSql).toContain(
      "branch_analytics_rollup_states.as_of IS NULL"
    );
    expect(failureSql).toContain(
      "branch_analytics_rollup_states.as_of <= EXCLUDED.as_of"
    );
    expect(failureSql).toContain(
      "branch_analytics_rollup_states.last_error_at <= EXCLUDED.last_error_at"
    );
  });

  it("names at most ten failed organizations while counting every one", async () => {
    const dueOrganizationIds = Array.from(
      { length: 12 },
      (_, index) => `org-${index}`
    );
    mocks.dueQuery.mockResolvedValue(
      dueOrganizationIds.map((id) => dueRollupOrganizationRow(id, ROLLED_UP_AT))
    );
    mocks.withDbTx.mockRejectedValue(new Error("refresh failed"));

    const summary = await refreshDueBranchAnalyticsRollups({
      now: NOW,
      organizationLimit: 12,
    });

    expect(summary.failedOrganizations).toBe(12);
    expect(summary.failures.map((failure) => failure.organizationId)).toEqual(
      dueOrganizationIds.slice(0, 10)
    );
  });

  it("stops starting organizations once the run budget is spent and reports it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.withDbTx.mockImplementation(() => {
      // Spend the whole wall-clock budget inside the first organization, so the
      // loop must refuse to START the next one rather than overrun the route.
      vi.setSystemTime(new Date(NOW.getTime() + 181_000));
      return Promise.resolve(batchSummary("org-a", true, 1, 1, 0));
    });

    const summary = await refreshDueBranchAnalyticsRollups({
      now: NOW,
      organizationLimit: 3,
    });

    expect(summary).toMatchObject({
      organizations: 3,
      batches: 1,
      budgetExhausted: true,
      failedOrganizations: 0,
    });
    expect(mocks.withDbTx).toHaveBeenCalledTimes(1);
  });

  it("reports the organization bound reached only when a due organization was left behind", async () => {
    mocks.dueQuery.mockResolvedValue([
      dueRollupOrganizationRow("org-a", ROLLED_UP_AT),
      dueRollupOrganizationRow("org-b", ROLLED_UP_AT),
      dueRollupOrganizationRow("org-c", ROLLED_UP_AT),
      dueRollupOrganizationRow("org-d", ROLLED_UP_AT),
    ]);
    mocks.withDbTx.mockResolvedValue(batchSummary("org-a", true, 1, 1, 0));

    const summary = await refreshDueBranchAnalyticsRollups({
      sessionLimit: 10,
      now: NOW,
      organizationLimit: 3,
    });

    expect(summary).toMatchObject({
      organizations: 3,
      organizationLimitReached: true,
    });
    // The probe row is a signal, never work: only the bound is refreshed.
    expect(mocks.withDbTx).toHaveBeenCalledTimes(3);
    expect(collectSqlValues(mocks.dueQuery.mock.calls[0]?.[0])).toContain(4);
  });

  it("bounds due-organization selection before organization refresh work", async () => {
    mocks.withDbTx.mockResolvedValue(batchSummary("org-a", true, 0, 0, 0));

    await refreshDueBranchAnalyticsRollups({
      sessionLimit: 10,
      now: NOW,
      organizationLimit: 3,
    });

    const dueSql = renderSql(mocks.dueQuery.mock.calls[0]?.[0]);
    expect(dueSql).toContain("due_state_organizations AS MATERIALIZED");
    expect(dueSql).toContain("new_state_organizations AS MATERIALIZED");
    expect(dueSql).toContain("FROM organizations organization");
    expect(dueSql).toContain("ORDER BY organization.created_at ASC");
    expect(dueSql).not.toContain("FROM agent_session_token_events event");
  });

  it("selects the page by interleaving the two organization classes rather than merging them into one NULLS FIRST sequence", async () => {
    mocks.withDbTx.mockResolvedValue(batchSummary("org-a", true, 0, 0, 0));

    await refreshDueBranchAnalyticsRollups({ now: NOW, organizationLimit: 3 });

    // ISS-10079. Every expectation is a literal rather than derived from the
    // query, so a change to the ordering cannot also rewrite what is expected.
    // Postgres does the ordering, so only the DB-backed case in
    // branch-analytics-rollup.integration.test.ts executes it; this pins the
    // statement that case would otherwise be the sole record of.
    const dueSql = normalizeRenderedSql(mocks.dueQuery.mock.calls[0]?.[0]);
    expect(dueSql).toContain(
      "ORDER BY class_rank ASC, class_order ASC, organization_id ASC LIMIT"
    );
    // Which class sits on which side of the tie-break. Without this, swapping
    // the two literals inverts the ordering and the assertion above still
    // matches the rendered text verbatim.
    expect(dueSql).toContain(
      "TRUE AS has_rollup_state, 0 AS class_order, ROW_NUMBER() OVER ( ORDER BY last_attempt_at ASC NULLS FIRST, organization_id ASC ) AS class_rank FROM due_state_organizations"
    );
    expect(dueSql).toContain(
      "FALSE AS has_rollup_state, 1 AS class_order, ROW_NUMBER() OVER ( ORDER BY created_at ASC, organization_id ASC ) AS class_rank FROM new_state_organizations"
    );
    // The defect's shape rather than its old text: the merged sequence needed a
    // join back to the state table to produce the NULL sort key, and the
    // outer ordering must carry no NULL handling of its own. Anchored on
    // neither the retired `active.` alias nor any replacement for it, so
    // reintroducing the merge under a different alias still reddens.
    expect(dueSql).not.toContain("LEFT JOIN branch_analytics_rollup_states");
    expect(dueSql.slice(dueSql.lastIndexOf("FROM ranked_organizations"))).toBe(
      // `LIMIT 4` is the bound of 3 plus the one probe row, rendered inline.
      "FROM ranked_organizations ORDER BY class_rank ASC, class_order ASC, organization_id ASC LIMIT 4"
    );
  });

  it("reports the oldest selected cursor age and the never-rolled-up count so a starved class stops being silent", async () => {
    const oldest = new Date(NOW.getTime() - 3 * ONE_HOUR_MS);
    mocks.dueQuery.mockResolvedValue([
      dueRollupOrganizationRow("org-recent", ROLLED_UP_AT),
      neverRolledUpOrganizationRow("org-never"),
      dueRollupOrganizationRow("org-oldest", oldest),
      // Due, carries state, but was never stamped: urgent, and NOT an age.
      unstampedRollupOrganizationRow("org-unstamped"),
    ]);
    mocks.withDbTx.mockResolvedValue(batchSummary("org-a", true, 0, 0, 0));

    const summary = await refreshDueBranchAnalyticsRollups({
      now: NOW,
      organizationLimit: 4,
    });

    expect(summary.oldestDueAsOfAgeMs).toBe(3 * ONE_HOUR_MS);
    expect(summary.neverRolledUpOrganizations).toBe(1);
  });

  it("reports no cursor age rather than a measured zero when every due organization is unstamped or brand new", async () => {
    mocks.dueQuery.mockResolvedValue([
      neverRolledUpOrganizationRow("org-never"),
      unstampedRollupOrganizationRow("org-unstamped"),
    ]);
    mocks.withDbTx.mockResolvedValue(batchSummary("org-a", true, 0, 0, 0));

    const summary = await refreshDueBranchAnalyticsRollups({
      now: NOW,
      organizationLimit: 2,
    });

    expect(summary.oldestDueAsOfAgeMs).toBeNull();
    expect(summary.neverRolledUpOrganizations).toBe(1);
  });

  it("refuses a cursor dated after the run clock as an age instead of reporting a negative one", async () => {
    mocks.dueQuery.mockResolvedValue([
      dueRollupOrganizationRow(
        "org-skewed",
        new Date(NOW.getTime() + ONE_HOUR_MS)
      ),
    ]);
    mocks.withDbTx.mockResolvedValue(batchSummary("org-a", true, 0, 0, 0));

    const summary = await refreshDueBranchAnalyticsRollups({
      now: NOW,
      organizationLimit: 1,
    });

    expect(summary.oldestDueAsOfAgeMs).toBeNull();
  });
});

function batchSummary(
  organizationId: string,
  complete: boolean,
  sessionsRefreshed: number,
  upsertedRows: number,
  lagSeconds: number
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
