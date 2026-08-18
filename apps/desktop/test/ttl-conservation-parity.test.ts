/**
 * @file ttl-conservation-parity.test.ts
 * @description FEA-3419 round-3 blocker regressions.
 *
 * 1. Conservation TTL parity: token_usage and token_events commit in SEPARATE
 *    tolerant transactions, so a partial re-import can pair a TTL-priced usage
 *    row with STALE events whose four counters still match but whose TTL
 *    provenance differs. Without the parity guard the conservation heal would
 *    adopt the stale premium-free event sum and silently erase the premium —
 *    with it, the mismatch disqualifies and the aggregate is kept (fail
 *    closed).
 *
 * 2. Cost-locator collision: token_events has no primary key; the cost-update
 *    WHERE used to match only (session, model, created_at, four counters), so
 *    two events differing ONLY in their TTL split would both take the last
 *    price. The null-safe TTL pair in the locator keeps each row's price its
 *    own.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  healTokenUsageEventConservation,
  repriceUnpricedTokenUsage,
} from "../src/main/database/token-cost-maintenance.js";
import { estimateTokenCost } from "../src/shared/token-cost.js";
import { makeSession } from "./normalized-session-test-utils.js";

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const DB_NOW = "2026-06-21T12:00:00.000Z";

async function openTempDb(): Promise<{ db: SqliteDb; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ttl-parity-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => DB_NOW,
  });
  return { db, dir };
}

function ttlSession(sessionId: string) {
  return makeSession({
    sessionId,
    model: "claude-opus-4-5",
    tokensByModel: {
      "claude-opus-4-5": {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 1000,
        cacheWriteTtl: { fiveM: 600, oneH: 400 },
      },
    },
    tokenSeries: [
      {
        timestamp: "2026-01-01T00:00:30.000Z",
        model: "claude-opus-4-5",
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 1000,
        cacheWriteTtl: { fiveM: 600, oneH: 400 },
      },
    ],
  });
}

async function usageCost(db: SqliteDb, sessionId: string): Promise<number> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { cost_usd_estimated: number | null }[]
  >(
    "SELECT cost_usd_estimated FROM token_usage WHERE session_id = $1",
    sessionId
  );
  return Number(rows[0]?.cost_usd_estimated ?? 0);
}

test("conservation stays fail-closed when stale events lack the usage row's TTL provenance", async () => {
  const { db, dir } = await openTempDb();
  try {
    await db.importer.importSession(ttlSession("parity"), "claude");
    const premiumCost = await usageCost(db, "parity");
    assert.ok(premiumCost > 0);

    // Simulate the partial re-import: the events regress to a STALE pre-TTL
    // state — same four counters, NULL provenance, repriced at the 5m-only
    // rate — while the usage row keeps its TTL columns and premium cost.
    const staleEstimate = estimateTokenCost({
      model: "claude-opus-4-5",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 1000,
      observedAt: "2026-01-01T00:00:30.000Z",
    });
    assert.ok(staleEstimate);
    await db.prisma.write((client) =>
      client.$executeRawUnsafe(
        `UPDATE token_events SET
           cache_write_5m_tokens = NULL,
           cache_write_1h_tokens = NULL,
           cost_usd_estimated = $1
         WHERE session_id = $2`,
        staleEstimate?.costUsd ?? 0,
        "parity"
      )
    );

    // Four-counter sums still match the usage row exactly, the series is fully
    // priced, and the costs diverge — the ONLY thing standing between the
    // premium and its silent erasure is the TTL-parity clause.
    await healTokenUsageEventConservation(db.prisma, () => undefined);
    assert.equal(await usageCost(db, "parity"), premiumCost);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("conservation still converges when the event series carries matching TTL provenance", async () => {
  const { db, dir } = await openTempDb();
  try {
    await db.importer.importSession(ttlSession("parity-ok"), "claude");
    const conservedCost = await usageCost(db, "parity-ok");
    assert.ok(conservedCost > 0);

    // Perturb ONLY the usage cost. Counts match, the series is fully priced,
    // and TTL parity holds (usage columns == event sums) — the heal must
    // converge the aggregate back to Σ(event costs).
    await db.prisma.write((client) =>
      client.$executeRawUnsafe(
        "UPDATE token_usage SET cost_usd_estimated = $1 WHERE session_id = $2",
        conservedCost + 1,
        "parity-ok"
      )
    );
    await healTokenUsageEventConservation(db.prisma, () => undefined);
    const healed = await usageCost(db, "parity-ok");
    assert.ok(Math.abs(healed - conservedCost) < 1e-9);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("partially timestamp-less event attribution fails conservation closed", async () => {
  const { db, dir } = await openTempDb();
  try {
    const timestamped = ttlSession("partial-timestamp").tokenSeries[0];
    assert.ok(timestamped);
    // The aggregate represents two equal calls. Only the first had a usable
    // timestamp, so tokenSeries can retain one event while tokensByModel still
    // carries both calls. Conservation must keep the aggregate price because
    // the event series is structurally incomplete.
    await db.importer.importSession(
      makeSession({
        sessionId: "partial-timestamp",
        model: "claude-opus-4-5",
        tokensByModel: {
          "claude-opus-4-5": {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 2000,
            cacheWriteTtl: { fiveM: 1200, oneH: 800 },
          },
        },
        tokenSeries: [timestamped],
      }),
      "claude"
    );

    const aggregateCost = await usageCost(db, "partial-timestamp");
    const [eventSum] = await db.prisma.client.$queryRawUnsafe<
      { cost: number | null; cache_write_tokens: number | bigint | null }[]
    >(
      `SELECT SUM(cost_usd_estimated) AS cost,
              SUM(cache_write_tokens) AS cache_write_tokens
       FROM token_events WHERE session_id = $1`,
      "partial-timestamp"
    );
    assert.equal(Number(eventSum.cache_write_tokens), 1000);
    assert.ok(aggregateCost > Number(eventSum.cost ?? 0));

    await healTokenUsageEventConservation(db.prisma, () => undefined);
    assert.equal(await usageCost(db, "partial-timestamp"), aggregateCost);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("empty tokenSeries synthesis persists the exact FEA-3419 evidence premium", async () => {
  const { db, dir } = await openTempDb();
  try {
    const oneHourTokens = 90_091;
    await db.importer.importSession(
      makeSession({
        sessionId: "evidence-empty-series",
        model: "claude-fable-5",
        tokensByModel: {
          "claude-fable-5": {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: oneHourTokens,
            cacheWriteTtl: { fiveM: 0, oneH: oneHourTokens },
          },
        },
        tokenSeries: [],
      }),
      "claude"
    );

    type CostRow = {
      cache_write_5m_tokens: number | bigint | null;
      cache_write_1h_tokens: number | bigint | null;
      cost_usd_estimated: number | null;
    };
    const usageRows = await db.prisma.client.$queryRawUnsafe<CostRow[]>(
      `SELECT cache_write_5m_tokens, cache_write_1h_tokens,
              cost_usd_estimated
       FROM token_usage WHERE session_id = $1`,
      "evidence-empty-series"
    );
    const eventRows = await db.prisma.client.$queryRawUnsafe<CostRow[]>(
      `SELECT cache_write_5m_tokens, cache_write_1h_tokens,
              cost_usd_estimated
       FROM token_events WHERE session_id = $1`,
      "evidence-empty-series"
    );
    assert.equal(usageRows.length, 1);
    assert.equal(eventRows.length, 1, "one fallback event is synthesized");

    for (const row of [...usageRows, ...eventRows]) {
      assert.equal(Number(row.cache_write_5m_tokens), 0);
      assert.equal(Number(row.cache_write_1h_tokens), oneHourTokens);
      assert.ok(Math.abs(Number(row.cost_usd_estimated) - 1.801_82) < 1e-9);
    }
    assert.ok(
      Math.abs((await usageCost(db, "evidence-empty-series")) - 1.801_82) < 1e-9
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("cost-update locator distinguishes two events identical except their TTL split", async () => {
  const { db, dir } = await openTempDb();
  try {
    // Anchor session so the boot reprice has a session to chunk over.
    await db.importer.importSession(
      makeSession({
        sessionId: "collide",
        model: "claude-opus-4-5",
        tokensByModel: {
          "claude-opus-4-5": {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 2000,
            cacheWriteTtl: { fiveM: 1000, oneH: 1000 },
          },
        },
        tokenSeries: [],
      }),
      "claude"
    );
    // Two UNPRICED events identical in (model, created_at, four counters) but
    // differing ONLY in the split: one all-1h, one absent. Inserted raw —
    // exactly the keyless-table shape the locator must disambiguate.
    await db.prisma.write(async (client) => {
      await client.$executeRawUnsafe(
        "DELETE FROM token_events WHERE session_id = $1",
        "collide"
      );
      await client.$executeRawUnsafe(
        `INSERT INTO token_events (session_id, model, created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens)
         VALUES ($1, $2, $3, 0, 0, 0, 1000, 0, 1000), ($1, $2, $3, 0, 0, 0, 1000, NULL, NULL)`,
        "collide",
        "claude-opus-4-5",
        "2026-01-01T00:00:30.000Z"
      );
      // The usage row must be unpriced so the boot pass picks the session up.
      await client.$executeRawUnsafe(
        "UPDATE token_usage SET cost_usd_estimated = NULL WHERE session_id = $1",
        "collide"
      );
    });

    await repriceUnpricedTokenUsage(db.prisma, () => undefined);

    const rows = await db.prisma.client.$queryRawUnsafe<
      {
        cache_write_1h_tokens: number | bigint | null;
        cost_usd_estimated: number | null;
      }[]
    >(
      "SELECT cache_write_1h_tokens, cost_usd_estimated FROM token_events WHERE session_id = $1 ORDER BY cache_write_1h_tokens IS NULL",
      "collide"
    );
    assert.equal(rows.length, 2);
    const oneHourRow = rows[0];
    const absentRow = rows[1];
    assert.equal(Number(oneHourRow.cache_write_1h_tokens), 1000);
    assert.equal(absentRow.cache_write_1h_tokens, null);
    assert.ok(oneHourRow.cost_usd_estimated !== null);
    assert.ok(absentRow.cost_usd_estimated !== null);
    // The 1h row carries the 2x premium; the absent row prices at the 5m rate.
    // Without the null-safe TTL pair in the WHERE, both rows would have taken
    // the LAST computed price and these would be equal.
    assert.ok(
      (oneHourRow.cost_usd_estimated ?? 0) > (absentRow.cost_usd_estimated ?? 0)
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
