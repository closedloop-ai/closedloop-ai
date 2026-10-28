/**
 * @file branch-usage-reads-coverage.test.ts
 * @description ISS-8730 coverage for branch-usage-reads.ts: the raw-SQL
 * per-(session, model) token reads and the per-event read for branch-linked
 * sessions. Exercised against a recording mock of DbHostPrisma's
 * `$queryRawUnsafe`, so the row-mapping and window-clause behavior are pinned
 * without a real SQLite fixture. `readBranchUsageEventRows`'s window bounds
 * are pushed through the real `branchUsageEventWindowSql` (not re-derived
 * here), so this file pins the composition, not a duplicate of its own suite.
 *
 * Pins CURRENT behavior only; does not change apps/desktop source.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  readBranchAnalyticsTokenRows,
  readBranchUsageEventRows,
  readBranchUsageTokenRows,
} from "../src/main/database/branch-usage-reads.js";
import type { DbHostPrisma } from "../src/main/database/prisma-client.js";

type QueryCall = { sql: string; args: unknown[] };

function createRecordingPrisma(rows: unknown[]): {
  prisma: DbHostPrisma;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  const prisma = {
    client: {
      $queryRawUnsafe: (sql: string, ...args: unknown[]) => {
        calls.push({ sql, args });
        return Promise.resolve(rows);
      },
    },
  } as unknown as DbHostPrisma;
  return { prisma, calls };
}

const SUBQUERY = "SELECT session_id FROM artifact_link_join_marker";

/**
 * The subquery must land INSIDE `WHERE tu.session_id IN (…)`, joined to
 * `sessions` by an INNER join and ordered deterministically. A bare
 * `sql.includes(SUBQUERY)` cannot say any of that: it is satisfied by the
 * string appearing anywhere, so it only fails if the interpolation is deleted
 * outright, and stays green if the predicate moves, the join widens to a LEFT
 * join (which would admit token rows for sessions that no longer exist), or the
 * ORDER BY is dropped (which makes the `(session, model)` row order arbitrary).
 */
const SESSION_SUBQUERY_PREDICATE_RE = new RegExp(
  `WHERE tu\\.session_id IN \\(${SUBQUERY}\\)`
);
const INNER_JOIN_SESSIONS_RE =
  /\bFROM token_usage tu\s+JOIN sessions s ON s\.id = tu\.session_id\b/;
const OUTER_JOIN_RE = /\b(LEFT|RIGHT|FULL|CROSS)\s+(OUTER\s+)?JOIN\b/i;
const TOKEN_ROW_ORDER_RE = /ORDER BY tu\.session_id ASC, tu\.model ASC/;
const BILLING_COLUMN_RE = /\bs\.billing_mode\b/;

/**
 * The composition facts both token reads share, returned rather than asserted
 * so the assertion stays in the test body (Biome `noMisplacedAssertion`).
 */
function branchTokenSqlComposition(sql: string): Record<string, boolean> {
  return {
    subqueryInSessionIdPredicate: SESSION_SUBQUERY_PREDICATE_RE.test(sql),
    innerJoinOnSessions: INNER_JOIN_SESSIONS_RE.test(sql),
    noOuterJoin: !OUTER_JOIN_RE.test(sql),
    deterministicRowOrder: TOKEN_ROW_ORDER_RE.test(sql),
  };
}

/** Every composition fact above, all true — the shape a passing read must produce. */
const WELL_COMPOSED_BRANCH_TOKEN_SQL = {
  subqueryInSessionIdPredicate: true,
  innerJoinOnSessions: true,
  noOuterJoin: true,
  deterministicRowOrder: true,
} as const;

describe("readBranchUsageTokenRows", () => {
  test("maps token counts, cache tiers, and cost, resolving a definite stored billing mode straight through", async () => {
    const { prisma, calls } = createRecordingPrisma([
      {
        session_id: "s1",
        model: "claude-3",
        input_tokens: "100",
        output_tokens: "50",
        cache_read_tokens: "10",
        cache_write_tokens: "5",
        cache_write_5m_tokens: null,
        cache_write_1h_tokens: "2",
        billing_mode: "api",
        harness: "claude",
        created_at: "2026-01-01T00:00:00.000Z",
        session_started_at: "2025-12-31T00:00:00.000Z",
        cost_usd_estimated: 1.23,
      },
    ]);
    const rows = await readBranchUsageTokenRows(prisma, SUBQUERY);
    assert.deepEqual(rows, [
      {
        sessionId: "s1",
        model: "claude-3",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        cacheWrite5mTokens: null,
        cacheWrite1hTokens: 2,
        billingMode: "api",
        createdAt: "2026-01-01T00:00:00.000Z",
        sessionStartedAt: "2025-12-31T00:00:00.000Z",
        costUsdEstimated: 1.23,
      },
    ]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.length, 0);
    assert.deepEqual(
      branchTokenSqlComposition(calls[0].sql),
      WELL_COMPOSED_BRANCH_TOKEN_SQL
    );
  });

  test("maps a null captured cost to null rather than 0", async () => {
    const { prisma } = createRecordingPrisma([
      {
        session_id: "s1",
        model: "claude-3",
        input_tokens: "0",
        output_tokens: "0",
        cache_read_tokens: "0",
        cache_write_tokens: "0",
        cache_write_5m_tokens: null,
        cache_write_1h_tokens: null,
        billing_mode: "unknown",
        harness: "unknown-harness",
        created_at: null,
        session_started_at: null,
        cost_usd_estimated: null,
      },
    ]);
    const [row] = await readBranchUsageTokenRows(prisma, SUBQUERY);
    assert.equal(row.costUsdEstimated, null);
  });
});

describe("readBranchAnalyticsTokenRows", () => {
  test("always reports billingMode null, never resolving one from the row", async () => {
    const { prisma } = createRecordingPrisma([
      {
        session_id: "s1",
        model: "claude-3",
        input_tokens: "20",
        output_tokens: "10",
        cache_read_tokens: "0",
        cache_write_tokens: "0",
        cache_write_5m_tokens: "3",
        cache_write_1h_tokens: "4",
        created_at: "2026-01-01T00:00:00.000Z",
        session_started_at: "2025-12-31T00:00:00.000Z",
        cost_usd_estimated: 0.5,
      },
    ]);
    const [row] = await readBranchAnalyticsTokenRows(prisma, SUBQUERY);
    assert.equal(row.billingMode, null);
    assert.equal(row.inputTokens, 20);
    assert.equal(row.cacheWrite5mTokens, 3);
    assert.equal(row.cacheWrite1hTokens, 4);
    assert.equal(row.sessionStartedAt, "2025-12-31T00:00:00.000Z");
    assert.equal(row.costUsdEstimated, 0.5);
  });

  test("composes the same subquery predicate, inner join, and row order as the billing-mode read", async () => {
    const { prisma, calls } = createRecordingPrisma([]);
    await readBranchAnalyticsTokenRows(prisma, SUBQUERY);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, []);
    assert.deepEqual(
      branchTokenSqlComposition(calls[0].sql),
      WELL_COMPOSED_BRANCH_TOKEN_SQL
    );
    // The one deliberate difference from readBranchUsageTokenRows: this read
    // does not project the billing columns, which is why every row it maps
    // carries `billingMode: null` rather than a resolved mode.
    assert.doesNotMatch(calls[0].sql, BILLING_COLUMN_RE);
  });
});

describe("readBranchUsageEventRows", () => {
  test("with no bounds, omits the window clause and pushes no extra bind params", async () => {
    const { prisma, calls } = createRecordingPrisma([]);
    await readBranchUsageEventRows(prisma, SUBQUERY);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, []);
    assert.ok(
      !calls[0].sql.includes("te.created_at >="),
      "an unbounded read must not push a start-date predicate"
    );
  });

  test("with canonical bounds, pushes both instants as positional bind params in order", async () => {
    const { prisma, calls } = createRecordingPrisma([]);
    await readBranchUsageEventRows(prisma, SUBQUERY, {
      startIso: "2026-01-01T00:00:00.000Z",
      endIso: "2026-02-01T00:00:00.000Z",
    });
    assert.deepEqual(calls[0].args, [
      "2026-01-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
    ]);
    assert.ok(calls[0].sql.includes("te.created_at >= $1"));
    assert.ok(calls[0].sql.includes("te.created_at <= $2"));
  });

  test("a non-canonical bound is silently not pushed down (pinning the documented safe-degradation behavior)", async () => {
    const { prisma, calls } = createRecordingPrisma([]);
    await readBranchUsageEventRows(prisma, SUBQUERY, {
      // Date-only, no time component: fails CANONICAL_INSTANT_RE.
      startIso: "2026-01-01",
    });
    assert.deepEqual(calls[0].args, []);
    assert.ok(!calls[0].sql.includes("te.created_at >="));
  });

  test("maps event identity fields, resolves billing mode per row, and coalesces a missing session_started_at to null", async () => {
    const { prisma } = createRecordingPrisma([
      {
        event_row_id: "42",
        event_fingerprint: "fp-1",
        session_id: "s1",
        model: "claude-3",
        input_tokens: "7",
        output_tokens: "3",
        cache_read_tokens: "0",
        cache_write_tokens: "0",
        cache_write_5m_tokens: null,
        cache_write_1h_tokens: null,
        billing_mode: "api",
        harness: "claude",
        created_at: "2026-01-01T00:00:00.000Z",
        // Omitted key rather than an explicit null, simulating a raw-row
        // shape the typed contract does not guarantee — readBranchUsageEventRows
        // has an explicit `?? null` here that readBranchUsageTokenRows lacks.
        session_started_at: undefined,
        cost_usd_estimated: 2.5,
      },
    ]);
    const [row] = await readBranchUsageEventRows(prisma, SUBQUERY);
    assert.equal(row.eventRowId, "42");
    assert.equal(row.eventFingerprint, "fp-1");
    assert.equal(row.billingMode, "api");
    assert.equal(row.sessionStartedAt, null);
    assert.equal(row.costUsdEstimated, 2.5);
  });
});
