import { LinkType } from "@repo/api/src/types/artifact";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
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
} from "./branch-analytics-rollup";
import {
  BRANCH_ANALYTICS_ROLLUP_RECEIVE_OVERLAP_MS,
  BranchAnalyticsRollupReadStatus,
  BranchAnalyticsRollupState,
  BranchAnalyticsRollupUnavailableReason,
} from "./branch-analytics-rollup-contract";

const ORGANIZATION_ID = "11111111-1111-7111-8111-111111111111";
const SESSION_ID = "22222222-2222-7222-8222-222222222222";
const EVENT_ID = "33333333-3333-7333-8333-333333333333";
const NOW = new Date("2026-09-02T15:00:00.000Z");
const EVENT_CREATED_AT = new Date("2026-09-02T14:58:00.000Z");

describe("Branch analytics rollup read", () => {
  it("trusts a fresh unbounded state without scanning live token events", async () => {
    const { db, queryRaw } = buildReadClient({
      state: freshState(),
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
    expect(queryRaw).toHaveBeenCalledTimes(3);
    expect(
      queryRaw.mock.calls.map((call) => renderSql(call[0])).join("\n")
    ).not.toContain('SUM(event.input_tokens) AS "sumInputTokens"');
  });

  /**
   * ISS-9831 changed this expectation deliberately. The refusal it used to
   * assert was correct for a rollup grained per session LIFETIME — a lifetime
   * total cannot be apportioned to a window. The writer now emits one bucket per
   * UTC day, so the same window is answerable as whole buckets plus a bounded
   * read of the one partial day, and refusing it would leave ~34% of production
   * `/branches` requests on the fallback for no reason.
   */
  it("answers a date-windowed read from the buckets the window covers", async () => {
    const { db, queryRaw } = buildReadClient({
      state: freshState(),
      aggregateRows: [],
    });

    const result = await readMaterializedBranchEventAggregates(
      db,
      ORGANIZATION_ID,
      [SESSION_ID],
      { startDate: new Date("2026-09-02T14:00:00.000Z") },
      NOW
    );

    expect(result).toEqual({
      status: BranchAnalyticsRollupReadStatus.Available,
      rows: [],
    });
    const bucketSql = queryRaw.mock.calls
      .map((call) => renderSql(call[0]))
      .find((sql) => sql.includes("deduplicated_buckets AS MATERIALIZED"));
    // The whole-bucket floor is the NEXT midnight, and 14:00 onwards of 09-02
    // comes from the source — never from a bucket that also holds 09-02 00:00.
    expect(bucketSql).toContain("rollup.bucket_start >=");
    expect(bucketSql).toContain("UNION ALL");
  });

  it("refuses a window too narrow to hold a whole bucket", async () => {
    const { db, queryRaw } = buildReadClient({
      state: freshState(),
      aggregateRows: [],
    });

    const result = await readMaterializedBranchEventAggregates(
      db,
      ORGANIZATION_ID,
      [SESSION_ID],
      {
        startDate: new Date("2026-09-02T06:00:00.000Z"),
        endDate: new Date("2026-09-02T18:00:00.000Z"),
      },
      NOW
    );

    expect(result).toEqual({
      status: BranchAnalyticsRollupReadStatus.Unavailable,
      reason: BranchAnalyticsRollupUnavailableReason.DateWindowUnsupported,
      state: freshState(),
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it("reads deduplicated aggregate rows from the materialized table", async () => {
    const aggregateRows = [
      {
        agentSessionId: SESSION_ID,
        sumInputTokens: 10n,
        sumOutputTokens: 3n,
        sumCacheReadTokens: 2n,
        sumCacheWriteTokens: 1n,
        sumEstimatedCost: { toString: () => "1.25" },
        minInputTokens: 10n,
        minOutputTokens: 3n,
        minCacheReadTokens: 2n,
        minCacheWriteTokens: 1n,
        minEstimatedCost: { toString: () => "1.25" },
        estimatedCostCount: 1n,
        eventCount: 1n,
      },
    ];
    const { db, queryRaw } = buildReadClient({
      state: freshState(),
      aggregateRows,
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
      rows: aggregateRows,
    });
    const aggregateSql = queryRaw.mock.calls
      .map((call) => renderSql(call[0]))
      .find((statement) =>
        statement.includes("deduplicated_buckets AS MATERIALIZED")
      );
    expect(aggregateSql).toBeDefined();
    const sql = aggregateSql ?? "";
    expect(sql).toContain("deduplicated_buckets AS MATERIALIZED");
    expect(sql).toContain("JOIN branch_analytics_session_rollups rollup");
    expect(sql).toContain("MAX(rollup.input_tokens)");
    expect(sql).toContain(
      "GROUP BY rollup.session_artifact_id, rollup.bucket_start"
    );
    expect(sql).not.toContain("rollup.bucket_start >=");
    expect(sql).not.toContain("rollup.bucket_start <=");
    expect(sql).not.toContain("JOIN agent_session_token_events event");
  });

  it("falls back when a fresh state is missing requested source rows", async () => {
    const { db, queryRaw } = buildReadClient({
      state: freshState(),
      aggregateRows: [],
      incompleteMaterializedRows: [{ agentSessionId: SESSION_ID }],
    });

    const result = await readMaterializedBranchEventAggregates(
      db,
      ORGANIZATION_ID,
      [SESSION_ID],
      undefined,
      NOW
    );

    expect(result).toMatchObject({
      status: BranchAnalyticsRollupReadStatus.Unavailable,
      reason: BranchAnalyticsRollupUnavailableReason.SessionRowsMissing,
    });
    expect(queryRaw).toHaveBeenCalledTimes(2);
    // ISS-10565: the gate compares watermarks, one probe per session. It must
    // never recount the source on the request path again, and its source side
    // is the newest RECEIVED event, bounded by as_of alone: with the value terms
    // in the lateral, a session whose every event is malformed has nothing to
    // find and drops out of the result, and the read serves it as zero usage.
    const completenessSql = renderSql(queryRaw.mock.calls[1]?.[0]);
    expect(completenessSql).toContain("ORDER BY event.event_created_at DESC");
    expect(completenessSql).toContain(
      "materialized_watermark.source_max_event_created_at < event.event_created_at"
    );
    expect(completenessSql).toContain("event.created_at <=");
    expect(completenessSql).not.toContain("event.input_tokens >= 0");
    expect(completenessSql).not.toContain("COUNT(");
    expect(completenessSql).not.toContain("GROUP BY");
  });

  it("refuses stale, pending, error, and malformed freshness states", async () => {
    const states = [
      {
        state: { ...freshState(), state: BranchAnalyticsRollupState.Pending },
        reason: BranchAnalyticsRollupUnavailableReason.BackfillIncomplete,
      },
      {
        state: { ...freshState(), state: BranchAnalyticsRollupState.Error },
        reason: BranchAnalyticsRollupUnavailableReason.StateError,
      },
      {
        state: {
          ...freshState(),
          asOf: new Date("2026-09-02T14:44:59.000Z"),
        },
        reason: BranchAnalyticsRollupUnavailableReason.StaleClock,
      },
      {
        state: { ...freshState(), lagSeconds: 901 },
        reason: BranchAnalyticsRollupUnavailableReason.LagExceeded,
      },
      {
        state: { ...freshState(), lagSeconds: -1 },
        reason: BranchAnalyticsRollupUnavailableReason.LagUnknown,
      },
    ];

    for (const scenario of states) {
      const { result, queryRaw } = await readUnavailableState(scenario.state);
      expect(result).toMatchObject({
        status: BranchAnalyticsRollupReadStatus.Unavailable,
        reason: scenario.reason,
      });
      expect(queryRaw).toHaveBeenCalledTimes(1);
    }
  });
});

describe("Branch analytics rollup producer", () => {
  it("consults the session refresh queue on every batch and never walks a receive-time event cursor", async () => {
    const otherSessionId = "55555555-5555-7555-8555-555555555555";
    const { tx, executeRaw, queryRaw } = buildRefreshTx({
      state: freshState(),
      sessionRefreshRows: [
        { agentSessionId: SESSION_ID, needsBackfill: true },
        { agentSessionId: otherSessionId, needsBackfill: true },
      ],
      sessionLimit: 3,
      materializedThroughEventCreatedAt: EVENT_CREATED_AT,
      sourceWatermarkEventCreatedAt: EVENT_CREATED_AT,
      upsertedRows: 2n,
    });

    const summary = await refreshBranchAnalyticsRollupBatchTx(tx, {
      organizationId: ORGANIZATION_ID,
      sessionLimit: 3,
      now: NOW,
    });

    expect(summary).toMatchObject({
      organizationId: ORGANIZATION_ID,
      sessionsRefreshed: 2,
      upsertedRows: 2,
      complete: true,
      lagSeconds: 0,
    });
    const issuedSql = queryRaw.mock.calls.map((call) => renderSql(call[0]));
    expect(
      issuedSql.some((sql) => sql.includes("ORDER BY event.created_at ASC"))
    ).toBe(false);
    expect(
      issuedSql.some((sql) => sql.includes("(event.created_at, event.id) >"))
    ).toBe(false);
    const stateValues = collectSqlValues(executeRaw.mock.calls[1]?.[0]);
    expect(stateValues).toEqual(
      expect.arrayContaining([BranchAnalyticsRollupState.Fresh, NOW])
    );
    expect(stateValues).not.toContain(EVENT_ID);
  });

  it("drops a malformed session's rows and keeps it out of the refresh queue", async () => {
    const { tx, executeRaw, queryRaw } = buildRefreshTx({
      state: freshState(),
      sessionRefreshRows: [],
      sessionLimit: 3,
      materializedThroughEventCreatedAt: EVENT_CREATED_AT,
      sourceWatermarkEventCreatedAt: EVENT_CREATED_AT,
      malformedSessionCount: 1n,
      purgedRows: 1n,
      upsertedRows: 0n,
    });

    const summary = await refreshBranchAnalyticsRollupBatchTx(tx, {
      organizationId: ORGANIZATION_ID,
      sessionLimit: 3,
      now: NOW,
    });

    const deleteCall = queryRaw.mock.calls.find((call) =>
      renderSql(call[0]).includes(
        "DELETE FROM branch_analytics_session_rollups"
      )
    );
    expect(renderSql(deleteCall?.[0])).toContain("USING session_watermarks");
    expect(renderSql(deleteCall?.[0])).not.toContain("array_agg");
    // The purge's rows are the batch's rows too, not a side effect the
    // summary forgets.
    expect(summary.deletedRows).toBe(1);
    const queueCall = queryRaw.mock.calls.find((call) =>
      renderSql(call[0]).includes("eligible_sessions AS MATERIALIZED")
    );
    // ISS-10817 moved this exclusion off a per-link `NOT EXISTS` anti-join and
    // onto the per-session aggregate that already visits the same rows, so both
    // halves are pinned: the queue COMPUTES malformed-ness, and it EXCLUDES on
    // it. Pinning only the predicate text would stay green if the WHERE term
    // that acts on it were dropped.
    expect(renderSql(queueCall?.[0])).toContain("BOOL_OR(");
    expect(renderSql(queueCall?.[0])).toContain(
      "WHERE NOT COALESCE(source.malformed, false)"
    );
    expect(renderSql(queueCall?.[0])).toContain("event.input_tokens < 0");
    // The organization stays fresh: one bad session refuses that session, not
    // every read of its siblings.
    const stateValues = collectSqlValues(executeRaw.mock.calls.at(-1)?.[0]);
    expect(stateValues).toContain(BranchAnalyticsRollupState.Fresh);
    expect(stateValues).not.toContain(BranchAnalyticsRollupState.Error);
  });

  it("queues a session whose rollup is missing or behind its newest source event", async () => {
    const otherSessionId = "55555555-5555-7555-8555-555555555555";
    const { tx, executeRaw, queryRaw } = buildRefreshTx({
      state: freshState(),
      sessionRefreshRows: [
        { agentSessionId: SESSION_ID, needsBackfill: true },
        { agentSessionId: otherSessionId, needsBackfill: true },
      ],
      sessionLimit: 3,
      materializedThroughEventCreatedAt: EVENT_CREATED_AT,
      sourceWatermarkEventCreatedAt: EVENT_CREATED_AT,
      upsertedRows: 2n,
    });

    await refreshBranchAnalyticsRollupBatchTx(tx, {
      organizationId: ORGANIZATION_ID,
      sessionLimit: 3,
      now: NOW,
    });

    const refreshQueueSql = queryRaw.mock.calls
      .map((call) => renderSql(call[0]))
      .find((sql) => sql.includes("eligible_sessions AS MATERIALIZED"));
    // Pinned as ONE contiguous block anchored at the WHERE. The first two terms
    // also appear in the SELECT list's `needsBackfill` COALESCE, so asserting
    // either on its own matches that copy and pins no WHERE term at all —
    // deleting the whole OR-chain from the WHERE would stay green. ISS-10817
    // put the malformed guard ahead of the chain, and that guard is unique to
    // the WHERE, which is what makes this anchor hold.
    expect(
      refreshQueueSql
    ).toContain(`WHERE NOT COALESCE(source.malformed, false)
      AND (
        rollup.session_artifact_id IS NULL
        OR rollup.source_max_event_created_at < source.source_max_event_created_at
        OR rollup.event_count < source.source_event_count
        OR ${syncedSinceTerm("rollup.as_of")}
      )`);
    expect(refreshQueueSql).toContain('"needsBackfill" DESC');
    expect(refreshQueueSql).toContain("al.metadata->>'linkKind'");
    expect(collectSqlValues(queryRaw.mock.calls[0]?.[0])).toEqual(
      expect.arrayContaining([
        BranchParticipationKind.Wrote,
        BranchParticipationKind.Reviewed,
        LinkType.RelatesTo,
        SessionArtifactLinkKind.SessionPr,
        SessionArtifactLinkKind.SessionBranch,
        SessionArtifactLinkKind.SessionPrSet,
      ])
    );
    expect(sessionIdsFromSql(executeRaw.mock.calls[0]?.[0])).toEqual([
      SESSION_ID,
      otherSessionId,
    ]);
  });

  it("re-materializes a session synced since its rows were written, with no periodic re-sweep of the rest (ISS-12779)", async () => {
    const { tx, queryRaw } = buildRefreshTx({
      state: freshState(),
      sessionRefreshRows: [
        { agentSessionId: SESSION_ID, needsBackfill: false },
      ],
      sessionLimit: 3,
      materializedThroughEventCreatedAt: EVENT_CREATED_AT,
      sourceWatermarkEventCreatedAt: EVENT_CREATED_AT,
      upsertedRows: 1n,
    });

    await refreshBranchAnalyticsRollupBatchTx(tx, {
      organizationId: ORGANIZATION_ID,
      sessionLimit: 3,
      now: NOW,
    });

    const refreshQueueCall = queryRaw.mock.calls.find((call) =>
      renderSql(call[0]).includes("eligible_sessions AS MATERIALIZED")
    )?.[0];
    const refreshQueueSql = renderSql(refreshQueueCall);
    // A synced session's malformed state is re-read too (session_watermarks),
    // and its history is scanned and queued (received_sessions, refresh_batch),
    // so an in-place edit that makes it malformed purges it instead of
    // re-materializing it.
    expect(refreshQueueSql).toContain(syncedSinceTerm("materialized.as_of"));
    expect(refreshQueueSql.split(syncedSinceTerm("rollup.as_of"))).toHaveLength(
      3
    );
    // The six-hour re-sweep bound a clock earlier than the batch's own; nothing
    // the queue reads may be older than `now` any more.
    expect(
      collectSqlValues(refreshQueueCall).filter(
        (value) => value instanceof Date && value < NOW
      )
    ).toEqual([]);
  });

  it("stays complete when only re-synced rows fill the bound, so a sync burst never forces the whole org back to pending", async () => {
    const queued = [
      "aaaaaaaa-1111-7111-8111-111111111111",
      "bbbbbbbb-2222-7222-8222-222222222222",
    ];
    const { tx, executeRaw } = buildRefreshTx({
      state: freshState(),
      sessionRefreshRows: [
        { agentSessionId: queued[0] as string, needsBackfill: true },
        { agentSessionId: queued[1] as string, needsBackfill: false },
      ],
      sessionLimit: 2,
      materializedThroughEventCreatedAt: EVENT_CREATED_AT,
      sourceWatermarkEventCreatedAt: EVENT_CREATED_AT,
      upsertedRows: 2n,
    });

    const summary = await refreshBranchAnalyticsRollupBatchTx(tx, {
      organizationId: ORGANIZATION_ID,
      sessionLimit: 2,
      now: NOW,
    });

    expect(summary).toMatchObject({ sessionsRefreshed: 2, complete: true });
    expect(collectSqlValues(executeRaw.mock.calls[1]?.[0])).toEqual(
      expect.arrayContaining([BranchAnalyticsRollupState.Fresh, NOW])
    );
  });

  it("bounds the source watermark and the aggregate at the batch cutoff, so an event received after it cannot be materialized under the older as_of", async () => {
    const { tx, queryRaw } = buildRefreshTx({
      state: freshState(),
      sessionRefreshRows: [{ agentSessionId: SESSION_ID, needsBackfill: true }],
      sessionLimit: 3,
      materializedThroughEventCreatedAt: EVENT_CREATED_AT,
      sourceWatermarkEventCreatedAt: EVENT_CREATED_AT,
      upsertedRows: 1n,
    });

    await refreshBranchAnalyticsRollupBatchTx(tx, {
      organizationId: ORGANIZATION_ID,
      sessionLimit: 3,
      now: NOW,
    });

    const refreshQueueSql = queryRaw.mock.calls
      .map((call) => renderSql(call[0]))
      .find((sql) => sql.includes("source_watermarks AS MATERIALIZED"));
    // Pin the WHERE bounds themselves: the in-scope COUNT FILTER also renders
    // this cutoff and would mask a deleted history or newest-event predicate.
    expect(refreshQueueSql).toMatch(sourceHistoryCutoffWhere);
    expect(refreshQueueSql).toMatch(sourceNewestCutoffWhere);

    // The read counts source events through `as_of` and rejects only a
    // materialized count that is too LOW, so an aggregate that reached past
    // this cutoff would be served under the older `as_of` and its surplus would
    // mask a pre-cutoff event that really is missing.
    const upsertCall = queryRaw.mock.calls.find((call) =>
      renderSql(call[0]).includes("event_buckets AS MATERIALIZED")
    );
    expect(renderSql(upsertCall?.[0])).toContain("event.created_at <= ");
    expect(collectSqlValues(upsertCall?.[0])).toEqual(
      expect.arrayContaining([NOW])
    );
  });

  it("stays pending while the session refresh queue still fills its bound", async () => {
    const queued = [
      "aaaaaaaa-1111-7111-8111-111111111111",
      "bbbbbbbb-2222-7222-8222-222222222222",
    ];
    const { tx, executeRaw } = buildRefreshTx({
      state: freshState(),
      sessionRefreshRows: queued.map((agentSessionId) => ({
        agentSessionId,
        needsBackfill: true,
      })),
      sessionLimit: 2,
      materializedThroughEventCreatedAt: EVENT_CREATED_AT,
      sourceWatermarkEventCreatedAt: EVENT_CREATED_AT,
      upsertedRows: 2n,
    });

    const summary = await refreshBranchAnalyticsRollupBatchTx(tx, {
      organizationId: ORGANIZATION_ID,
      sessionLimit: 2,
      now: NOW,
    });

    expect(summary).toMatchObject({
      sessionsRefreshed: 2,
      complete: false,
    });
    expect(collectSqlValues(executeRaw.mock.calls[1]?.[0])).toEqual(
      expect.arrayContaining([BranchAnalyticsRollupState.Pending, null])
    );
  });
});

async function readUnavailableState(state: MockRollupState) {
  const { db, queryRaw } = buildReadClient({
    state,
    aggregateRows: [],
  });

  const result = await readMaterializedBranchEventAggregates(
    db,
    ORGANIZATION_ID,
    [SESSION_ID],
    undefined,
    NOW
  );

  return { queryRaw, result };
}

function buildReadClient(input: {
  state: MockRollupState | undefined;
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
  state: MockRollupState | undefined;
  sessionRefreshRows?: MockSessionRefreshRow[];
  sessionLimit: number;
  sourceWatermarkEventCreatedAt: Date | null;
  materializedThroughEventCreatedAt: Date | null;
  malformedSessionCount?: bigint;
  purgedRows?: bigint;
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
          malformedSessionCount: input.malformedSessionCount ?? 0n,
          purgedRows: input.purgedRows ?? 0n,
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

function freshState(): MockRollupState {
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

type MockRollupState = {
  organizationId: string;
  state: string;
  sourceWatermarkEventCreatedAt: Date | null;
  materializedThroughEventCreatedAt: Date | null;
  asOf: Date | null;
  lagSeconds: number | bigint | null;
  backfillCompletedAt: Date | null;
};

type MockSessionRefreshRow = {
  agentSessionId: string;
  needsBackfill?: boolean;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sessionIdsFromSql(statement: unknown): string[] {
  return collectSqlValues(statement).filter(
    (value): value is string =>
      typeof value === "string" &&
      value !== ORGANIZATION_ID &&
      UUID_PATTERN.test(value)
  );
}

const sourceHistoryCutoffWhere =
  /WHERE event.agent_session_id = received\."agentSessionId"\s+AND event.created_at <= /;
const sourceNewestCutoffWhere =
  /WHERE event.agent_session_id = eligible\.id\s+AND event.created_at <= /;

/** `branchSessionSyncedSinceMaterializedSql` as `renderSql` prints it. */
function syncedSinceTerm(materializedAsOf: string): string {
  return `(
    eligible.last_synced_at > ${materializedAsOf}
      - ${BRANCH_ANALYTICS_ROLLUP_RECEIVE_OVERLAP_MS} * INTERVAL '1 millisecond'
  )`;
}
