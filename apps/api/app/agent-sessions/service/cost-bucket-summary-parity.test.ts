// FEA-4293/4294 (thread wongk): the usage-summary cards and the Sessions TABLE
// must aggregate the SAME cost-bucket population. The table buckets on the
// RECONCILED captured cost, not the stored `SessionDetail.estimatedCost` rollup,
// so the summary must resolve the identical reconciled-matched id set instead of
// restating a stored-rollup predicate. These tests drive `findSessions` and
// `buildUsageSummaryWhere` through the shared cost-reconciliation harness and
// assert the two surfaces scope to the same ids.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractIdInFilter,
  FROM_50_BUCKET,
  getCandidateScanOrderBy,
  getCapturedQueryRaw,
  installCostSessions,
  resetCapturedQueryRaw,
  UNDER_1_BUCKET,
  UPDATED,
} from "@/__tests__/support/agent-sessions/service/cost-query-reconciliation.test-harness";
import { agentSessionsService } from "../service";
import { SESSION_DEFAULT_ORDER_BY } from "./session-sort-order";
import { buildUsageSummaryWhere } from "./usage-summary-where";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

describe("usage-summary ↔ table cost-bucket parity (FEA-4293/4294, thread wongk)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCapturedQueryRaw();
  });

  it("scopes the summary to the SAME reconciled population the table paints — a legacy $0 rollup with $0.42 priced events is IN both", async () => {
    // wongk's exact case: a legacy row stored at estimatedCost=0 whose PRICED
    // per-event stream totals $0.42. The table buckets on the reconciled $0.42,
    // so it appears under "≤ $1". The OLD summary restated the stored-rollup
    // predicate (SESSION_COST_KNOWN_WHERE requires estimatedCost>0), which would
    // DROP this row from the cards — the divergence. Assert the summary now
    // resolves the SAME reconciled-matched id set the table returns.
    installCostSessions([
      {
        artifactId: "legacy-zero-rollup",
        storedRollup: 0,
        eventCostSum: 0.42,
        eventCount: 3,
        pricedCount: 3,
        sessionUpdatedAt: UPDATED(1),
      },
    ]);

    // Table: the reconciled $0.42 puts it in ≤ $1.
    const table = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { costBuckets: [UNDER_1_BUCKET] },
    });
    expect(table.total).toBe(1);
    expect(table.items[0]?.id).toBe("legacy-zero-rollup");
    expect(table.items[0]?.cost).toBe("$0.42");

    // Summary: the where must be scoped to that SAME single id — NOT dropped by a
    // stored-rollup > 0 predicate.
    const summaryWhere = await buildUsageSummaryWhere({
      organizationId: "org-1",
      filters: { costBuckets: [UNDER_1_BUCKET] },
    });
    expect(extractIdInFilter(summaryWhere)).toEqual(["legacy-zero-rollup"]);
  });

  it("excludes from the summary the SAME session the table excludes — a stale-inflated rollup whose reconciled cost leaves the bucket", async () => {
    // Inverse: rollup $1,378.39 would put the row in a high bucket, but the
    // reconciled $0.42 belongs in ≤ $1. Filtering on $50+, the table excludes it;
    // the summary must exclude it too (its id-set is empty), so neither the cards
    // nor the table count a session the reconciled cost says isn't in the bucket.
    installCostSessions([
      {
        artifactId: "reconciled-cheap",
        storedRollup: 1378.39,
        eventCostSum: 0.42,
        eventCount: 3,
        pricedCount: 3,
        sessionUpdatedAt: UPDATED(1),
      },
    ]);

    const table = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { costBuckets: [FROM_50_BUCKET] },
    });
    expect(table.total).toBe(0);

    const summaryWhere = await buildUsageSummaryWhere({
      organizationId: "org-1",
      filters: { costBuckets: [FROM_50_BUCKET] },
    });
    expect(extractIdInFilter(summaryWhere)).toEqual([]);
  });

  it("does NOT reconcile (no candidate scan) when the summary has no cost-bucket filter", async () => {
    // A non-cost-sensitive summary keeps the plain buildWhere path: no reconciled
    // candidate read, and no artifactId IN scoping clause.
    installCostSessions([
      {
        artifactId: "s1",
        storedRollup: 5,
        eventCostSum: 5,
        eventCount: 2,
        sessionUpdatedAt: UPDATED(1),
      },
    ]);

    const summaryWhere = await buildUsageSummaryWhere({
      organizationId: "org-1",
      filters: { quality: "all" },
    });

    // No cost filter → no reconciled candidate scan ($queryRaw untouched) and no
    // id-scoping clause on the summary where.
    expect(getCapturedQueryRaw()?.mock.calls ?? []).toHaveLength(0);
    expect(extractIdInFilter(summaryWhere)).toBeNull();
  });

  it("excludes an UNKNOWN-cost $0 row (no priced events, no subscription) from the summary bucket, matching the table (FEA-4294)", async () => {
    // A $0 row with an UNPRICED stream and no subscription renders "—": it is not
    // a numeric cost and must be excluded from the numeric ≤ $1 bucket on BOTH
    // surfaces. pricedCount 0 → reconciled cost falls back to the $0 rollup, and
    // sessionCostIsNumeric rejects a $0 non-subscription cost.
    installCostSessions([
      {
        artifactId: "unknown-cost",
        storedRollup: 0,
        eventCostSum: 0,
        eventCount: 2,
        pricedCount: 0,
        billingMode: null,
        sessionUpdatedAt: UPDATED(1),
      },
    ]);

    const table = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { costBuckets: [UNDER_1_BUCKET] },
    });
    expect(table.total).toBe(0);

    const summaryWhere = await buildUsageSummaryWhere({
      organizationId: "org-1",
      filters: { costBuckets: [UNDER_1_BUCKET] },
    });
    expect(extractIdInFilter(summaryWhere)).toEqual([]);
  });

  it("orders the summary/export candidate scan the SAME way the table's default cost path does, so a capped cohort can't diverge (thread wongk, FEA-4326)", async () => {
    // wongk's cap divergence: when the SESSION_COST_RECONCILE_CANDIDATE_CAP bites,
    // the surviving 10,000-row candidate set is decided by the candidate scan's
    // ORDER BY. The table's default cost path scans by `nonCostOrderBy(filters)`
    // (→ SESSION_DEFAULT_ORDER_BY: lastActivityAt + sessionStartedAt), while the
    // summary/export previously scanned by a bare `sessionUpdatedAt desc`. Those
    // timestamps move for different reasons, so a heavy org kept DIFFERENT ids and
    // the export/summary cohort diverged from the painted table. The export route
    // carries no sortBy/sortDir, so both paths must resolve to the SAME default
    // order — assert the summary candidate scan uses exactly SESSION_DEFAULT_ORDER_BY.
    installCostSessions([
      {
        artifactId: "s1",
        storedRollup: 0,
        eventCostSum: 0.42,
        eventCount: 3,
        pricedCount: 3,
        sessionUpdatedAt: UPDATED(1),
      },
    ]);

    // Drive the table (default sort, cost bucket) so both scans are recorded.
    await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: { costBuckets: [UNDER_1_BUCKET] },
    });
    const tableCandidateOrderBy = getCandidateScanOrderBy();
    expect(tableCandidateOrderBy).toEqual(SESSION_DEFAULT_ORDER_BY);

    // The summary/export cohort resolver must scan candidates with the IDENTICAL
    // order, so the capped id set can't diverge from the table's.
    resetCapturedQueryRaw();
    installCostSessions([
      {
        artifactId: "s1",
        storedRollup: 0,
        eventCostSum: 0.42,
        eventCount: 3,
        pricedCount: 3,
        sessionUpdatedAt: UPDATED(1),
      },
    ]);
    await buildUsageSummaryWhere({
      organizationId: "org-1",
      filters: { costBuckets: [UNDER_1_BUCKET] },
    });
    expect(getCandidateScanOrderBy()).toEqual(SESSION_DEFAULT_ORDER_BY);
    expect(getCandidateScanOrderBy()).toEqual(tableCandidateOrderBy);
  });
});
