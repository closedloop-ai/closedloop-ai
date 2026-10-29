import { describe, expect, it, vi } from "vitest";
import {
  COMPLETENESS_GATE_MARKER,
  ROLLUP_STATE_READ_MARKER,
} from "@/__tests__/support/branches/branch-analytics-rollup.test-markers";
import {
  collectSqlValues,
  renderSql,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import {
  readMaterializedBranchEventAggregates,
  refreshBranchAnalyticsRollupBatchTx,
  refreshBranchAnalyticsSessionRollupsTx,
} from "./branch-analytics-rollup";
import {
  BranchAnalyticsRollupReadStatus,
  BranchAnalyticsRollupState,
  type BranchAnalyticsRollupStateRow,
  BranchAnalyticsRollupUnavailableReason,
} from "./branch-analytics-rollup-contract";

// ISS-9713 branch coverage. Mirrors the mocking patterns already established
// in branch-analytics-rollup.test.ts (SQL-string-dispatched $queryRaw/
// $executeRaw fakes) and branch-analytics-rollup-due.test.ts (withDb/withDb.tx
// mocks), targeting branches those suites never reach: the early-return
// guards, the unexported freshness/lag classifiers driven only through the
// exported read/write entry points, and the due-refresh defaulting/rollup.

const ORGANIZATION_ID = "11111111-1111-7111-8111-111111111111";
const SESSION_ID = "22222222-2222-7222-8222-222222222222";
const EVENT_CREATED_AT = new Date("2026-09-02T14:58:00.000Z");
const NOW = new Date("2026-09-02T15:00:00.000Z");

describe("readMaterializedBranchEventAggregates trivial guard", () => {
  it("returns an empty Available result without querying when no sessions are requested", async () => {
    const queryRaw = vi.fn();

    const result = await readMaterializedBranchEventAggregates(
      { $queryRaw: queryRaw },
      ORGANIZATION_ID,
      [],
      undefined,
      NOW
    );

    expect(result).toEqual({
      status: BranchAnalyticsRollupReadStatus.Available,
      rows: [],
    });
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe("refreshBranchAnalyticsSessionRollupsTx trivial guard", () => {
  it("returns a zero summary without touching the transaction when no sessions are requested", async () => {
    const executeRaw = vi.fn();
    const queryRaw = vi.fn();

    const result = await refreshBranchAnalyticsSessionRollupsTx(
      { $executeRaw: executeRaw, $queryRaw: queryRaw },
      { organizationId: ORGANIZATION_ID, sessionArtifactIds: [], asOf: NOW }
    );

    expect(result).toEqual({ deletedRows: 0, upsertedRows: 0 });
    expect(executeRaw).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe("readMaterializedBranchEventAggregates freshness-state branches", () => {
  it("reports LagExceeded for a state already flagged Stale", async () => {
    const { result } = await readUnavailableState({
      ...freshState(),
      state: BranchAnalyticsRollupState.Stale,
    });

    expect(result).toMatchObject({
      status: BranchAnalyticsRollupReadStatus.Unavailable,
      reason: BranchAnalyticsRollupUnavailableReason.LagExceeded,
    });
  });

  it("reports BackfillIncomplete for a Fresh-flagged state with no recorded backfill completion", async () => {
    const { result } = await readUnavailableState({
      ...freshState(),
      backfillCompletedAt: null,
    });

    expect(result).toMatchObject({
      status: BranchAnalyticsRollupReadStatus.Unavailable,
      reason: BranchAnalyticsRollupUnavailableReason.BackfillIncomplete,
    });
  });
});

describe("readMaterializedBranchEventAggregates bigint lagSeconds normalization", () => {
  it("reports LagUnknown when the persisted bigint lag exceeds MAX_SAFE_INTEGER", async () => {
    const { result } = await readUnavailableState({
      ...freshState(),
      lagSeconds: BigInt(Number.MAX_SAFE_INTEGER) + 10n,
    });

    expect(result).toMatchObject({
      status: BranchAnalyticsRollupReadStatus.Unavailable,
      reason: BranchAnalyticsRollupUnavailableReason.LagUnknown,
    });
  });

  it("accepts a safe non-negative bigint lag within the freshness ceiling", async () => {
    const { db } = buildReadClient({
      state: { ...freshState(), lagSeconds: 5n },
      aggregateRows: [],
    });

    const result = await readMaterializedBranchEventAggregates(
      db,
      ORGANIZATION_ID,
      [SESSION_ID],
      undefined,
      NOW
    );

    expect(result).toEqual({
      status: BranchAnalyticsRollupReadStatus.Available,
      rows: [],
    });
  });

  it("reports LagUnknown for a negative bigint lag", async () => {
    const { result } = await readUnavailableState({
      ...freshState(),
      lagSeconds: -1n,
    });

    expect(result).toMatchObject({
      status: BranchAnalyticsRollupReadStatus.Unavailable,
      reason: BranchAnalyticsRollupUnavailableReason.LagUnknown,
    });
  });
});

describe("refreshBranchAnalyticsRollupBatchTx freshness/lag resolution", () => {
  it("reports zero lag for an org with an empty refresh queue and no source events yet", async () => {
    const { tx, executeRaw } = buildRefreshTx({
      state: freshState(),
      sourceWatermarkEventCreatedAt: null,
      materializedThroughEventCreatedAt: EVENT_CREATED_AT,
      sessionLimit: 5,
      upsertedRows: 0,
    });

    const summary = await refreshBranchAnalyticsRollupBatchTx(tx, {
      organizationId: ORGANIZATION_ID,
      sessionLimit: 5,
      now: NOW,
    });

    expect(summary).toMatchObject({ complete: true, lagSeconds: 0 });
    const stateValues = collectSqlValues(stateWriteCall(executeRaw));
    expect(stateValues).toEqual(
      expect.arrayContaining([BranchAnalyticsRollupState.Fresh, 0])
    );
  });

  it("marks the projection Stale (not Pending) when backfill is complete but nothing has materialized yet", async () => {
    const { tx, executeRaw } = buildRefreshTx({
      state: freshState(),
      sourceWatermarkEventCreatedAt: EVENT_CREATED_AT,
      materializedThroughEventCreatedAt: null,
      sessionLimit: 5,
      upsertedRows: 0,
    });

    const summary = await refreshBranchAnalyticsRollupBatchTx(tx, {
      organizationId: ORGANIZATION_ID,
      sessionLimit: 5,
      now: NOW,
    });

    expect(summary).toMatchObject({ complete: true, lagSeconds: null });
    const stateValues = collectSqlValues(stateWriteCall(executeRaw));
    expect(stateValues).toEqual(
      expect.arrayContaining([BranchAnalyticsRollupState.Stale])
    );
  });

  it("marks the projection Stale (not Fresh) once a complete backfill's lag exceeds the ceiling", async () => {
    const sourceWatermarkEventCreatedAt = new Date(
      EVENT_CREATED_AT.getTime() + 1000 * 1000
    );
    const { tx, executeRaw } = buildRefreshTx({
      state: freshState(),
      sourceWatermarkEventCreatedAt,
      materializedThroughEventCreatedAt: EVENT_CREATED_AT,
      sessionLimit: 5,
      upsertedRows: 0,
    });

    const summary = await refreshBranchAnalyticsRollupBatchTx(tx, {
      organizationId: ORGANIZATION_ID,
      sessionLimit: 5,
      now: NOW,
    });

    expect(summary).toMatchObject({ complete: true, lagSeconds: 1000 });
    const stateValues = collectSqlValues(stateWriteCall(executeRaw));
    expect(stateValues).toEqual(
      expect.arrayContaining([BranchAnalyticsRollupState.Stale, 1000])
    );
  });
});

async function readUnavailableState(state: BranchAnalyticsRollupStateRow) {
  const { db, queryRaw } = buildReadClient({ state, aggregateRows: [] });

  const result = await readMaterializedBranchEventAggregates(
    db,
    ORGANIZATION_ID,
    [SESSION_ID],
    undefined,
    NOW
  );

  return { queryRaw, result };
}

function freshState(): BranchAnalyticsRollupStateRow {
  return {
    organizationId: ORGANIZATION_ID,
    state: BranchAnalyticsRollupState.Fresh,
    sourceWatermarkEventCreatedAt: EVENT_CREATED_AT,
    materializedThroughEventCreatedAt: EVENT_CREATED_AT,
    asOf: NOW,
    lagSeconds: 0,
    backfillCompletedAt: NOW,
  };
}

function buildReadClient(input: {
  state: BranchAnalyticsRollupStateRow | undefined;
  aggregateRows: unknown[];
  incompleteMaterializedRows?: { agentSessionId: string }[];
}) {
  const queryRaw = vi.fn((statement: unknown) => {
    const sql = renderSql(statement);
    if (sql.includes(ROLLUP_STATE_READ_MARKER)) {
      return Promise.resolve(input.state ? [input.state] : []);
    }
    if (sql.includes(COMPLETENESS_GATE_MARKER)) {
      return Promise.resolve(input.incompleteMaterializedRows ?? []);
    }
    if (sql.includes("deduplicated_buckets AS MATERIALIZED")) {
      return Promise.resolve(input.aggregateRows);
    }
    throw new Error(`Unexpected Branch analytics rollup read SQL: ${sql}`);
  });
  return {
    db: { $queryRaw: queryRaw } as Parameters<
      typeof readMaterializedBranchEventAggregates
    >[0],
    queryRaw,
  };
}

function buildRefreshTx(input: {
  state: BranchAnalyticsRollupStateRow | undefined;
  sessionRefreshRows?: { agentSessionId: string }[];
  sessionLimit: number;
  sourceWatermarkEventCreatedAt: Date | null;
  materializedThroughEventCreatedAt: Date | null;
  upsertedRows: number | bigint;
}) {
  const queryRaw = vi.fn((statement: unknown) => {
    const sql = renderSql(statement);
    if (sql.includes(ROLLUP_STATE_READ_MARKER)) {
      return Promise.resolve(input.state ? [input.state] : []);
    }
    if (sql.includes('AS "sourceWatermarkEventCreatedAt"')) {
      return Promise.resolve([
        {
          sourceWatermarkEventCreatedAt: input.sourceWatermarkEventCreatedAt,
          sessionRefreshBatch: input.sessionRefreshRows ?? [],
          malformedSessionCount: 0n,
          purgedRows: 0n,
        },
      ]);
    }
    if (sql.includes("INSERT INTO branch_analytics_session_rollups")) {
      return Promise.resolve([{ upsertedRows: input.upsertedRows }]);
    }
    if (sql.includes("MAX(source_max_event_created_at)")) {
      return Promise.resolve([
        {
          materializedThroughEventCreatedAt:
            input.materializedThroughEventCreatedAt,
        },
      ]);
    }
    throw new Error(`Unexpected Branch analytics rollup refresh SQL: ${sql}`);
  });
  const executeRaw = vi.fn((statement: unknown) => {
    const sql = renderSql(statement);
    if (sql.includes("DELETE FROM branch_analytics_session_rollups")) {
      return Promise.resolve(1);
    }
    if (sql.includes("INSERT INTO branch_analytics_rollup_states")) {
      return Promise.resolve(1);
    }
    throw new Error(`Unexpected Branch analytics rollup write SQL: ${sql}`);
  });
  return {
    tx: { $executeRaw: executeRaw, $queryRaw: queryRaw } as Parameters<
      typeof refreshBranchAnalyticsRollupBatchTx
    >[0],
    executeRaw,
    queryRaw,
  };
}

/**
 * The `$executeRaw` call that writes the rollup state row.
 *
 * Located by its SQL rather than by call index: a batch with no event rows
 * skips the aggregate upsert entirely, so the state write is not always the
 * second call.
 */
function stateWriteCall(executeRaw: ReturnType<typeof vi.fn>): unknown {
  const call = executeRaw.mock.calls.find((entry) =>
    renderSql(entry[0]).includes("INSERT INTO branch_analytics_rollup_states")
  );
  if (!call) {
    throw new Error("expected a branch_analytics_rollup_states write");
  }
  return call[0];
}
