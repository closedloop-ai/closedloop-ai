/**
 * @file token-event-cost-locator.test.ts
 * @description ISS-8060: `updateTokenEventCost` runs once per token event, so
 * how its WHERE plans is the whole cost of the `token_events` import group. The
 * single `OR` locator it used to carry was unplannable without stats — the
 * desktop store is never `ANALYZE`d — so SQLite fell back to
 * `idx_token_events_session` and rescanned the session per event, making the
 * group quadratic in one session's event count.
 *
 * The statement EXPLAINed here is CAPTURED FROM `updateTokenEventCost` itself, not
 * read off the constant it happens to hold: EXPLAINing the constant would stay
 * green if the function stopped issuing it, which is precisely the re-merge this
 * guard exists to catch. The other two tests pin what the split must not change:
 * which row each arm reaches.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type { Prisma } from "../src/main/database/generated/client.js";
import { updateTokenEventCost } from "../src/main/database/token-cost-writes.js";
import type { EstimateTokenCostResult } from "../src/shared/token-cost.js";
import { openTestDb } from "./agent-db-test-utils.js";

type QueryPlanRow = { detail: string };
type PricedRow = {
  session_id: string;
  transport_id: string | null;
  cost_usd_estimated: number | null;
  cost_summary: string | null;
};

const SESSION = "cost-locator";
const OTHER_SESSION = "cost-locator-other";
const MODEL = "claude-opus-4-5";
const EVENT_AT = "2026-08-02T06:59:00.000Z";
const OBSERVED_AT = "2026-08-02T07:00:00.000Z";
const TRANSPORT_ID = "tx-a";
const SIBLING_TRANSPORT_ID = "tx-b";
const STORED_SUMMARY = "stored-producer-summary";

/**
 * The rescan the split exists to remove: the session-only index with no second
 * column. The trailing ` (` is load-bearing — without it this also matches the
 * two longer index names that ARE the fix.
 */
const SESSION_ONLY_RESCAN = "idx_token_events_session (";

const TRANSPORT_INDEX_RE = /idx_token_events_session_transport/;
const SESSION_CREATED_INDEX_RE = /idx_token_events_session_created/;

const LEGACY_EVENT = {
  timestamp: EVENT_AT,
  model: MODEL,
  input: 1,
  output: 1,
  cacheRead: 1,
  cacheWrite: 1,
};

const ESTIMATE: EstimateTokenCostResult = {
  costUsd: 0.5,
  inputCostUsd: 0.2,
  outputCostUsd: 0.2,
  cacheReadCostUsd: 0.05,
  cacheWriteCostUsd: 0.05,
  cacheWriteTtlPremiumUsd: 0,
  unknownModelFallbackApplied: false,
};

async function explain(
  db: Awaited<ReturnType<typeof openTestDb>>,
  sql: string,
  ...params: unknown[]
): Promise<string> {
  const rows = await db.prisma.client.$queryRawUnsafe<QueryPlanRow[]>(
    `EXPLAIN QUERY PLAN ${sql}`,
    ...params
  );
  return rows.map((row) => row.detail).join(" | ");
}

/**
 * Run `updateTokenEventCost` against a tx that records instead of executing, so
 * the SQL under test is the one the production function chose for this event.
 */
async function captureIssuedStatement(
  event: Parameters<typeof updateTokenEventCost>[2]
): Promise<{ sql: string; params: unknown[] }> {
  const issued: { sql: string; params: unknown[] }[] = [];
  await updateTokenEventCost(
    {
      $executeRawUnsafe: (sql: string, ...params: unknown[]) => {
        issued.push({ sql, params });
        return Promise.resolve(0) as ReturnType<
          Prisma.TransactionClient["$executeRawUnsafe"]
        >;
      },
    },
    SESSION,
    event,
    ESTIMATE,
    OBSERVED_AT
  );
  const statement = issued[0];
  if (!statement) {
    throw new Error("updateTokenEventCost issued no statement");
  }
  return statement;
}

test("ISS-8060: each per-event cost locator seeks its index instead of rescanning the session", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "token-cost-eqp-"));
  const db = await openTestDb(dir);
  try {
    const transport = await captureIssuedStatement({
      ...LEGACY_EVENT,
      transportId: TRANSPORT_ID,
    });
    const transportPlan = await explain(db, transport.sql, ...transport.params);
    assert.match(
      transportPlan,
      TRANSPORT_INDEX_RE,
      `transport locator must seek the transport index, got: ${transportPlan}`
    );
    assert.ok(
      !transportPlan.includes(SESSION_ONLY_RESCAN),
      `transport locator must not fall back to the session rescan, got: ${transportPlan}`
    );

    const legacy = await captureIssuedStatement(LEGACY_EVENT);
    const legacyPlan = await explain(db, legacy.sql, ...legacy.params);
    assert.match(
      legacyPlan,
      SESSION_CREATED_INDEX_RE,
      `legacy locator must seek the (session, created_at) index, got: ${legacyPlan}`
    );
    assert.ok(
      !legacyPlan.includes(SESSION_ONLY_RESCAN),
      `legacy locator must not fall back to the session rescan, got: ${legacyPlan}`
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-8060: the transport locator prices only its own session's matching transport row", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "token-cost-transport-"));
  const db = await openTestDb(dir);
  try {
    // A sibling transport id and a same-transport row in another session. The
    // split gave this arm its own bind positions ($9 summary, $10 session, $11
    // transport) and `$executeRawUnsafe` is untyped, so a transposed parameter
    // would silently match nothing or the wrong row.
    await db.prisma.write((client) =>
      client.$executeRawUnsafe(
        `INSERT INTO token_events (session_id, transport_id, model, created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cost_summary)
         VALUES ($1, $4, $3, $5, 1, 1, 1, 1, NULL, NULL, $6),
                ($1, $7, $3, $5, 1, 1, 1, 1, NULL, NULL, $6),
                ($2, $4, $3, $5, 1, 1, 1, 1, NULL, NULL, $6)`,
        SESSION,
        OTHER_SESSION,
        MODEL,
        TRANSPORT_ID,
        EVENT_AT,
        STORED_SUMMARY,
        SIBLING_TRANSPORT_ID
      )
    );

    await db.prisma.write((client) =>
      client.$transaction((tx) =>
        updateTokenEventCost(
          tx,
          SESSION,
          { ...LEGACY_EVENT, transportId: TRANSPORT_ID },
          ESTIMATE,
          OBSERVED_AT
        )
      )
    );

    const rows = await db.prisma.client.$queryRawUnsafe<PricedRow[]>(
      `SELECT session_id, transport_id, cost_usd_estimated, cost_summary
         FROM token_events ORDER BY session_id, transport_id`
    );
    assert.equal(rows.length, 3);
    const [targetRow, siblingRow, otherSessionRow] = rows;
    assert.equal(targetRow?.transport_id, TRANSPORT_ID);
    assert.equal(siblingRow?.transport_id, SIBLING_TRANSPORT_ID);
    assert.equal(otherSessionRow?.session_id, OTHER_SESSION);
    assert.equal(targetRow?.cost_usd_estimated, 0.5);
    assert.equal(siblingRow?.cost_usd_estimated, null);
    assert.equal(otherSessionRow?.cost_usd_estimated, null);
    // This arm DOES write the summary — the untouched siblings keep the stored
    // one, so "changed" here cannot be satisfied by the row simply not matching.
    assert.notEqual(targetRow?.cost_summary, STORED_SUMMARY);
    assert.equal(typeof targetRow?.cost_summary, "string");
    assert.equal(siblingRow?.cost_summary, STORED_SUMMARY);
    assert.equal(otherSessionRow?.cost_summary, STORED_SUMMARY);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-8060: the legacy locator prices only its own session's transportless row", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "token-cost-locator-"));
  const db = await openTestDb(dir);
  try {
    // Three rows identical in every legacy locator column. Only the middle one
    // is transportless AND in the target session, so any widening of the split
    // — a dropped `transport_id IS NULL`, a dropped session scope — reaches a
    // row it must not.
    await db.prisma.write((client) =>
      client.$executeRawUnsafe(
        `INSERT INTO token_events (session_id, transport_id, model, created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cost_summary)
         VALUES ($1, $4, $3, $5, 1, 1, 1, 1, NULL, NULL, $6),
                ($1, NULL, $3, $5, 1, 1, 1, 1, NULL, NULL, $6),
                ($2, NULL, $3, $5, 1, 1, 1, 1, NULL, NULL, $6)`,
        SESSION,
        OTHER_SESSION,
        MODEL,
        TRANSPORT_ID,
        EVENT_AT,
        STORED_SUMMARY
      )
    );

    await db.prisma.write((client) =>
      client.$transaction((tx) =>
        updateTokenEventCost(tx, SESSION, LEGACY_EVENT, ESTIMATE, OBSERVED_AT)
      )
    );

    const rows = await db.prisma.client.$queryRawUnsafe<PricedRow[]>(
      `SELECT session_id, transport_id, cost_usd_estimated, cost_summary
         FROM token_events ORDER BY session_id, transport_id IS NULL`
    );
    assert.equal(rows.length, 3);
    const [transportRow, legacyRow, otherSessionRow] = rows;
    assert.equal(transportRow?.session_id, SESSION);
    assert.equal(legacyRow?.session_id, SESSION);
    assert.equal(otherSessionRow?.session_id, OTHER_SESSION);
    assert.equal(legacyRow?.cost_usd_estimated, 0.5);
    assert.equal(transportRow?.cost_usd_estimated, null);
    assert.equal(otherSessionRow?.cost_usd_estimated, null);
    // The CASE the split replaced never wrote a legacy row's summary, and a
    // legacy record carries none to write.
    assert.equal(legacyRow?.cost_summary, STORED_SUMMARY);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
