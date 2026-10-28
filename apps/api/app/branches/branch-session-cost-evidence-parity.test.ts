import {
  aggregateBranchCostCompleteness,
  BranchCostCompleteness,
  BranchCostCompletenessReason,
  branchCostEvidenceByteBudget,
  branchCostEvidenceRowBudget,
} from "@repo/api/src/types/branch-usage";
import {
  TokenCostCompleteness,
  TokenSourceIdentityAvailability,
} from "@repo/api/src/types/token-cost-provenance";
import {
  BRANCH_COST_COMPLETENESS_PARITY_CASES,
  type BranchCostParityCase,
  BranchCostParityState,
} from "@repo/lib/branches/__tests__/cost-completeness-parity-fixture";
import { describe, expect, it, vi } from "vitest";
import { COMPLETENESS_GATE_MARKER } from "@/__tests__/support/branches/branch-analytics-rollup.test-markers";
import {
  collectSqlValues,
  renderSql,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import { BranchAnalyticsRollupState } from "./branch-analytics-rollup-contract";
import type { LinkedSession } from "./branch-read-service/session-usage-link-read";
import type { SessionUsageClient } from "./branch-read-service/session-usage-window";
import {
  resolveSessionEventEvidence,
  SESSION_USAGE_AGGREGATE_ONLY_SESSION_CHUNK_SIZE,
  SESSION_USAGE_COST_EVIDENCE_SESSION_CHUNK_SIZE,
} from "./branch-session-cost-evidence";

describe("Cloud Branch cost-completeness parity and resource bounds", () => {
  it.each(BRANCH_COST_COMPLETENESS_PARITY_CASES)(
    "matches the shared cross-surface $name state",
    async (scenario) => {
      expect(await resolveParityCase(scenario)).toEqual(scenario.expected);
    }
  );

  it("emits no fallback subtotal when the incomplete population is entirely unpriced", async () => {
    // ISS-7813. `lifetimeSessionSubtotal` used to reduce to a bare 0, and
    // `coverageIncompleteContribution` accepts a finite non-negative subtotal —
    // so a branch where NOTHING was priced published a `fallbackSubtotalUsd` of
    // 0 that a reader takes as a measured $0.00. That is the conflation this
    // ticket removes, on the sibling path to `applyCloudLifetimeCoverage`.
    //
    // Reachable only once a null cost can be stored, which is what this PR's
    // migration enables — so this guards the expand step rather than a live bug.
    const { db } = makeLargeOrganizationClient({ evidenceExceeded: true });

    const { contributions } = await resolveSessionEventEvidence(
      db,
      "org-1",
      [
        linkedSession("session-1", null, 10),
        linkedSession("session-2", null, 5),
      ],
      undefined
    );

    expect(contributions).toHaveLength(1);
    expect(contributions[0].coverageIncomplete).toBe(true);
    expect(contributions[0].fallbackSubtotalUsd).toBeUndefined();
  });

  it("still emits a fallback subtotal when any session in that population is priced", async () => {
    // The contrast case, so the assertion above cannot pass by the fallback
    // simply never being populated. An unpriced sibling still contributes 0 to
    // that sum — whether a partly-priced branch may report a total at all is the
    // pre-existing `hasPricedCost` question, deliberately untouched here.
    const { db } = makeLargeOrganizationClient({ evidenceExceeded: true });

    const { contributions } = await resolveSessionEventEvidence(
      db,
      "org-1",
      [
        linkedSession("session-1", 7.5, 10),
        linkedSession("session-2", null, 5),
      ],
      undefined
    );

    expect(contributions).toHaveLength(1);
    expect(contributions[0].fallbackSubtotalUsd).toBe(7.5);
  });

  it("bounds all-time evidence work by 1,000-session chunks", async () => {
    const { db, eventAggregateQuery, eventEvidenceQuery } =
      makeLargeOrganizationClient();
    const sessions = Array.from({ length: 2001 }, (_, index) =>
      linkedSession(`session-${index}`, 0, 0)
    );

    await resolveSessionEventEvidence(db, "org-1", sessions, undefined);

    expect(eventAggregateQuery).toHaveBeenCalledTimes(3);
    expect(eventEvidenceQuery).toHaveBeenCalledTimes(3);
    for (const [statement] of eventAggregateQuery.mock.calls) {
      expect(sessionIdsFromSql(statement).length).toBeLessThanOrEqual(
        SESSION_USAGE_COST_EVIDENCE_SESSION_CHUNK_SIZE
      );
    }
  });

  it("uses larger chunks for aggregate-only metrics-card reads", async () => {
    const { db, eventAggregateQuery, eventEvidenceQuery, eventGroupBy } =
      makeLargeOrganizationClient();
    const sessions = Array.from({ length: 5001 }, (_, index) =>
      linkedSession(`session-${index}`, 0, 0)
    );

    await resolveSessionEventEvidence(
      db,
      "org-1",
      sessions,
      { startDate: new Date("2026-06-01T00:00:00.000Z") },
      { includeCostEvidence: false }
    );

    expect(eventAggregateQuery).toHaveBeenCalledTimes(2);
    expect(eventGroupBy).not.toHaveBeenCalled();
    expect(eventEvidenceQuery).not.toHaveBeenCalled();
    for (const [statement] of eventAggregateQuery.mock.calls) {
      expect(sessionIdsFromSql(statement).length).toBeLessThanOrEqual(
        SESSION_USAGE_AGGREGATE_ONLY_SESSION_CHUNK_SIZE
      );
    }
    const sql = renderSql(eventAggregateQuery.mock.calls[0]?.[0]);
    expect(sql).toContain("WITH requested_sessions AS MATERIALIZED");
    expect(sql).toContain("SELECT DISTINCT unnest");
    expect(sql).toContain("JOIN session_detail session");
    expect(sql).toContain("JOIN artifacts artifact");
    expect(sql).toContain("artifact.organization_id =");
    expect(sql).toContain("event.event_created_at >=");
    expect(sql).toContain(
      'COUNT(event.estimated_cost) AS "estimatedCostCount"'
    );
    expect(sql).toContain('COUNT(*) AS "eventCount"');
    expect(sql).not.toContain("COUNT(event.estimated_cost)::int");
    expect(sql).not.toContain("COUNT(*)::int");
  });

  it("uses fresh materialized aggregate rows without scanning live token events", async () => {
    const event = cloudEvent(0, 10, 3);
    const { db, eventAggregateQuery, materializedAggregateQuery } =
      makeBranchCostEvidenceClient({
        aggregateRows: [],
        evidenceRows: evidenceRows([event]),
        materializedRows: aggregateRows([event]),
        materializedState: {
          organizationId: "org-1",
          state: BranchAnalyticsRollupState.Fresh,
          sourceWatermarkEventCreatedAt: event.eventCreatedAt,
          materializedThroughEventCreatedAt: event.eventCreatedAt,
          asOf: new Date(),
          lagSeconds: 0,
          backfillCursorCreatedAt: new Date(),
          backfillCursorEventId: "event-1",
          backfillCompletedAt: new Date(),
        },
      });

    const result = await resolveSessionEventEvidence(
      db,
      "org-1",
      [linkedSession("session-1", 3, 10)],
      undefined
    );

    expect(eventAggregateQuery).not.toHaveBeenCalled();
    expect(materializedAggregateQuery).toHaveBeenCalledOnce();
    expect(aggregateBranchCostCompleteness(result.contributions)).toEqual({
      completeness: BranchCostCompleteness.Complete,
      subtotalUsd: 3,
      lanes: { subscriptionEquivalentCost: 3, apiEstimatedCost: 0 },
    });
  });

  it("falls back to the live aggregate when the materialized read fails", async () => {
    const event = cloudEvent(0, 10, 3);
    const {
      db,
      eventAggregateQuery,
      materializedAggregateQuery,
      missingMaterializedQuery,
    } = makeBranchCostEvidenceClient({
      aggregateRows: aggregateRows([event]),
      evidenceRows: evidenceRows([event]),
      materializedStateError: new Error("rollup relation unavailable"),
    });

    const result = await resolveSessionEventEvidence(
      db,
      "org-1",
      [linkedSession("session-1", 3, 10)],
      undefined
    );

    expect(eventAggregateQuery).toHaveBeenCalledOnce();
    expect(missingMaterializedQuery).not.toHaveBeenCalled();
    expect(materializedAggregateQuery).not.toHaveBeenCalled();
    expect(aggregateBranchCostCompleteness(result.contributions)).toEqual({
      completeness: BranchCostCompleteness.Complete,
      subtotalUsd: 3,
      lanes: { subscriptionEquivalentCost: 3, apiEstimatedCost: 0 },
    });
  });

  /**
   * ISS-9831 inverted which query answers this. The assertion it replaces — that
   * a windowed read stays on the live token-event aggregate — encoded the
   * rollup's old session-LIFETIME grain, under which no window was answerable.
   * The writer now emits one bucket per UTC day, so a day-aligned window is
   * served from the buckets it covers. The SPEND assertion is deliberately
   * unchanged: the point is that the fast path returns the same number the live
   * query did, not a different one.
   */
  it("serves a day-aligned windowed aggregate-only read from the rollup", async () => {
    const event = cloudEvent(0, 10, 3);
    const {
      db,
      eventAggregateQuery,
      materializedAggregateQuery,
      missingMaterializedQuery,
    } = makeBranchCostEvidenceClient({
      aggregateRows: aggregateRows([event]),
      evidenceRows: [],
      materializedRows: aggregateRows([event]),
      materializedState: freshWindowedRollupState(event.eventCreatedAt),
    });

    const result = await resolveSessionEventEvidence(
      db,
      "org-1",
      [linkedSession("session-1", 3, 10)],
      { startDate: new Date("2026-06-01T00:00:00.000Z") },
      { includeCostEvidence: false }
    );

    expect(materializedAggregateQuery).toHaveBeenCalledOnce();
    expect(missingMaterializedQuery).toHaveBeenCalledOnce();
    expect(eventAggregateQuery).not.toHaveBeenCalled();
    expect(result.windowedSpend?.get("session-1")).toMatchObject({
      inputTokens: 10,
      estimatedCostUsd: 3,
      hasPricedCost: true,
    });
  });

  it("keeps a window too narrow for a whole bucket on the live exact token-event query", async () => {
    const event = cloudEvent(0, 10, 3);
    const {
      db,
      eventAggregateQuery,
      materializedAggregateQuery,
      missingMaterializedQuery,
    } = makeBranchCostEvidenceClient({
      aggregateRows: aggregateRows([event]),
      evidenceRows: [],
      materializedRows: aggregateRows([event]),
      materializedState: freshWindowedRollupState(event.eventCreatedAt),
    });

    const result = await resolveSessionEventEvidence(
      db,
      "org-1",
      [linkedSession("session-1", 3, 10)],
      {
        // Half of one day: no whole bucket sits inside it, so answering from the
        // rollup would be the fallback wearing the fast path's name.
        startDate: new Date("2026-06-01T06:00:00.000Z"),
        endDate: new Date("2026-06-01T18:00:00.000Z"),
      },
      { includeCostEvidence: false }
    );

    expect(eventAggregateQuery).toHaveBeenCalledOnce();
    expect(missingMaterializedQuery).not.toHaveBeenCalled();
    expect(materializedAggregateQuery).not.toHaveBeenCalled();
    expect(result.windowedSpend?.get("session-1")).toMatchObject({
      inputTokens: 10,
      estimatedCostUsd: 3,
      hasPricedCost: true,
    });
  });

  it("accepts raw bigint counts without losing ordinary completeness", async () => {
    const event = cloudEvent(0, 1, 3);
    const { db } = makeBranchCostEvidenceClient({
      aggregateRows: [
        {
          ...aggregateRows([event])[0],
          estimatedCostCount: 1n,
          eventCount: 1n,
        },
      ],
      evidenceRows: evidenceRows([event]),
    });

    const result = await resolveSessionEventEvidence(
      db,
      "org-1",
      [linkedSession("session-1", 3, 1)],
      undefined
    );

    expect(aggregateBranchCostCompleteness(result.contributions)).toEqual({
      completeness: BranchCostCompleteness.Complete,
      subtotalUsd: 3,
      lanes: { subscriptionEquivalentCost: 3, apiEstimatedCost: 0 },
    });
  });

  it("marks an unsafe raw count as malformed evidence", async () => {
    const unsafeCount = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    const event = cloudEvent(0, 1, 3);
    const { db } = makeBranchCostEvidenceClient({
      aggregateRows: [
        {
          ...aggregateRows([event])[0],
          estimatedCostCount: 1n,
          eventCount: unsafeCount,
        },
      ],
      evidenceRows: evidenceRows([event]),
    });

    const result = await resolveSessionEventEvidence(
      db,
      "org-1",
      [linkedSession("session-1", 3, 1)],
      undefined
    );

    expect(aggregateBranchCostCompleteness(result.contributions)).toEqual({
      completeness: BranchCostCompleteness.Partial,
      reason: BranchCostCompletenessReason.Malformed,
      subtotalUsd: 3,
    });
  });

  it("stops all-time evidence hydration after the request-wide cap is exceeded", async () => {
    const { db, eventAggregateQuery, eventEvidenceQuery } =
      makeLargeOrganizationClient({ evidenceExceeded: true });
    const sessions = Array.from({ length: 2001 }, (_, index) =>
      linkedSession(`session-${index}`, 0, 0)
    );

    await resolveSessionEventEvidence(db, "org-1", sessions, undefined);

    expect(eventAggregateQuery).toHaveBeenCalledTimes(3);
    expect(eventEvidenceQuery).toHaveBeenCalledOnce();
  });
});

async function resolveParityCase(scenario: BranchCostParityCase) {
  const events = scenario.events.map((event, index) =>
    cloudEvent(index, event.inputTokens, event.costUsd)
  );
  const { db } = makeBranchCostEvidenceClient({
    aggregateRows: aggregateRows(events),
    evidenceRows: scenario.evidenceExceeded
      ? [
          metadataRow(
            scenario.state === BranchCostParityState.RowCap
              ? branchCostEvidenceRowBudget + 1
              : 1,
            scenario.state === BranchCostParityState.ByteCap
              ? branchCostEvidenceByteBudget + 1
              : 0
          ),
        ]
      : evidenceRows(events),
  });
  const result = await resolveSessionEventEvidence(
    db,
    "org-1",
    [
      linkedSession(
        "session-1",
        scenario.lifetimeCostUsd,
        scenario.lifetimeInputTokens
      ),
    ],
    scenario.windowActive
      ? { startDate: new Date("2026-06-01T00:00:00.000Z") }
      : undefined
  );
  return aggregateBranchCostCompleteness(result.contributions);
}

function makeLargeOrganizationClient(
  options: { evidenceExceeded?: boolean } = {}
) {
  return makeBranchCostEvidenceClient({
    aggregateRows: [],
    evidenceRows: [
      metadataRow(
        options.evidenceExceeded ? branchCostEvidenceRowBudget + 1 : 0,
        0
      ),
    ],
  });
}

type MockAggregateRows = MockAggregateRow[];
type MockEvidenceRows = ReturnType<typeof evidenceRows>;
type MockMaterializedState = {
  organizationId: string;
  state: string;
  sourceWatermarkEventCreatedAt: Date | null;
  materializedThroughEventCreatedAt: Date | null;
  asOf: Date | null;
  lagSeconds: number | bigint | null;
  backfillCursorCreatedAt: Date | null;
  backfillCursorEventId: string | null;
  backfillCompletedAt: Date | null;
};

type MockAggregateRow = {
  agentSessionId: string;
  sumInputTokens: bigint;
  sumOutputTokens: bigint;
  sumCacheReadTokens: bigint;
  sumCacheWriteTokens: bigint;
  sumEstimatedCost: number | null;
  minInputTokens: number;
  minOutputTokens: bigint;
  minCacheReadTokens: bigint;
  minCacheWriteTokens: bigint;
  minEstimatedCost: number | null;
  estimatedCostCount: number | bigint;
  eventCount: number | bigint;
};

function makeBranchCostEvidenceClient({
  aggregateRows: mockAggregateRows,
  evidenceRows: mockEvidenceRows,
  materializedRows: mockMaterializedRows = [],
  materializedState,
  materializedStateError,
  missingMaterializedRows = [],
}: {
  aggregateRows: MockAggregateRows;
  evidenceRows: MockEvidenceRows;
  materializedRows?: MockAggregateRows;
  materializedState?: MockMaterializedState;
  materializedStateError?: Error;
  missingMaterializedRows?: { agentSessionId: string }[];
}) {
  const eventAggregateQuery = vi.fn().mockResolvedValue(mockAggregateRows);
  const eventEvidenceQuery = vi.fn().mockResolvedValue(mockEvidenceRows);
  const materializedAggregateQuery = vi
    .fn()
    .mockResolvedValue(mockMaterializedRows);
  const missingMaterializedQuery = vi
    .fn()
    .mockResolvedValue(missingMaterializedRows);
  const eventGroupBy = vi.fn();
  const queryRaw = vi.fn((statement: unknown) => {
    const sql = renderSql(statement);
    if (sql.includes("FROM branch_analytics_rollup_states")) {
      if (materializedStateError) {
        return Promise.reject(materializedStateError);
      }
      return Promise.resolve(materializedState ? [materializedState] : []);
    }
    if (sql.includes(COMPLETENESS_GATE_MARKER)) {
      return missingMaterializedQuery(statement);
    }
    if (sql.includes("deduplicated_buckets AS MATERIALIZED")) {
      return materializedAggregateQuery(statement);
    }
    if (sql.includes("WITH requested_sessions AS MATERIALIZED")) {
      return eventAggregateQuery(statement);
    }
    if (sql.includes("WITH evidence_size AS MATERIALIZED")) {
      return eventEvidenceQuery(statement);
    }
    throw new Error(`Unexpected Branch cost evidence SQL: ${sql}`);
  });
  const db = {
    $queryRaw: queryRaw,
    agentSessionTokenEvent: { groupBy: eventGroupBy },
  } as unknown as SessionUsageClient;
  return {
    db,
    eventAggregateQuery,
    eventEvidenceQuery,
    eventGroupBy,
    materializedAggregateQuery,
    missingMaterializedQuery,
    queryRaw,
  };
}

function linkedSession(
  artifactId: string,
  // ISS-7813: `null` is the never-priced session, a distinct case from 0.
  estimatedCost: number | null,
  inputTokens: number
): LinkedSession {
  return {
    artifactId,
    externalSessionId: artifactId,
    harness: "claude",
    sessionStartedAt: new Date("2026-06-10T10:00:00.000Z"),
    sessionEndedAt: null,
    lastActivityAt: new Date("2026-06-10T10:00:00.000Z"),
    estimatedCost,
    inputTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    turns: null,
    toolUseCount: 0,
    componentInvocationCount: 0,
    billingMode: null,
    ownerUserId: null,
  };
}

function cloudEvent(
  index: number,
  inputTokens: number,
  costUsd: number | null
) {
  return {
    id: `parity-event-${index}`,
    agentSessionId: "session-1",
    eventCreatedAt: new Date("2026-06-10T10:00:00.000Z"),
    inputTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: costUsd,
    sourceIdentity: {
      availability: TokenSourceIdentityAvailability.Available,
      scheme: "parity-fixture",
      sourceRecordIds: [`parity-record-${index}`],
    },
    costCompleteness: costUsd === null ? null : TokenCostCompleteness.Complete,
    costCompletenessReason: null,
    subscriptionEquivalentCost: costUsd,
    apiEstimatedCost: costUsd === null ? null : 0,
  };
}

function aggregateRows(
  events: readonly ReturnType<typeof cloudEvent>[]
): MockAggregateRows {
  if (events.length === 0) {
    return [];
  }
  const priced = events.filter((event) => event.estimatedCost !== null);
  const inputTokens = events.reduce(
    (total, event) => total + BigInt(event.inputTokens),
    0n
  );
  const outputTokens = 0n;
  const cacheReadTokens = 0n;
  const cacheWriteTokens = 0n;
  const estimatedCost =
    priced.length === 0
      ? null
      : priced.reduce((total, event) => total + (event.estimatedCost ?? 0), 0);
  const minInputTokens = Math.min(...events.map((event) => event.inputTokens));
  const minEstimatedCost =
    priced.length === 0
      ? null
      : Math.min(...priced.map((event) => event.estimatedCost ?? 0));
  return [
    {
      agentSessionId: "session-1",
      sumInputTokens: inputTokens,
      sumOutputTokens: outputTokens,
      sumCacheReadTokens: cacheReadTokens,
      sumCacheWriteTokens: cacheWriteTokens,
      sumEstimatedCost: estimatedCost,
      minInputTokens,
      minOutputTokens: outputTokens,
      minCacheReadTokens: cacheReadTokens,
      minCacheWriteTokens: cacheWriteTokens,
      minEstimatedCost,
      estimatedCostCount: priced.length,
      eventCount: events.length,
    },
  ];
}

function evidenceRows(events: readonly ReturnType<typeof cloudEvent>[]) {
  if (events.length === 0) {
    return [metadataRow(0, 0)];
  }
  return events.map((event) => ({
    ...event,
    evidenceCount: events.length,
    retainedBytes: events.length,
  }));
}

function metadataRow(evidenceCount: number, retainedBytes: number) {
  return {
    id: null,
    agentSessionId: null,
    eventCreatedAt: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    estimatedCost: null,
    sourceIdentity: null,
    costCompleteness: null,
    costCompletenessReason: null,
    subscriptionEquivalentCost: null,
    apiEstimatedCost: null,
    evidenceCount,
    retainedBytes,
  };
}

function sessionIdsFromSql(statement: unknown): string[] {
  return collectSqlValues(statement).filter(
    (value): value is string =>
      typeof value === "string" && value.startsWith("session-")
  );
}

/** A rollup state healthy enough for a windowed read to reach the buckets. */
function freshWindowedRollupState(
  eventCreatedAt: Date | null
): MockMaterializedState {
  return {
    organizationId: "org-1",
    state: BranchAnalyticsRollupState.Fresh,
    sourceWatermarkEventCreatedAt: eventCreatedAt,
    materializedThroughEventCreatedAt: eventCreatedAt,
    asOf: new Date(),
    lagSeconds: 0,
    backfillCursorCreatedAt: new Date(),
    backfillCursorEventId: "event-1",
    backfillCompletedAt: new Date(),
  };
}
