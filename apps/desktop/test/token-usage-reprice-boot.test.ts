import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  repriceUnpricedTokenUsage,
  upsertSessionAnalyticsRollup,
} from "../src/main/database/write-core.js";

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const NOW = "2026-06-21T12:00:00.000Z";

// claude-opus-4-5 @ 1000 input tokens prices to exactly $0.005 (see
// token-cost.test.ts) — the value the boot pass must resolve and persist.
const OPUS_INPUT_TOKENS = 1000;
const OPUS_REPRICED_COST = 0.005;
// A pre-priced row that the pass must leave untouched (it is not NULL).
const PREPRICED_COST = 2;

async function openTempDb(): Promise<{ db: SqliteDb; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "token-usage-reprice-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => NOW,
  });
  return { db, dir };
}

async function insertSession(db: SqliteDb, id: string): Promise<void> {
  await db.run(
    `INSERT INTO sessions (id, status, harness, started_at, updated_at)
     VALUES ($1, $2, $3, $4, $5)`,
    id,
    "completed",
    "claude_code",
    "2026-06-20T08:00:00.000Z",
    NOW
  );
}

async function insertToken(
  db: SqliteDb,
  sessionId: string,
  model: string,
  inputTokens: number,
  cost: number | null
): Promise<void> {
  await db.run(
    `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at, cost_usd_estimated)
     VALUES ($1, $2, $3, 0, 0, 0, $4, $5)`,
    sessionId,
    model,
    inputTokens,
    "2026-06-20T08:00:00.000Z",
    cost
  );
}

async function tokenCost(
  db: SqliteDb,
  sessionId: string,
  model: string
): Promise<number | null> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { cost_usd_estimated: number | null }[]
  >(
    "SELECT cost_usd_estimated FROM token_usage WHERE session_id = $1 AND model = $2",
    sessionId,
    model
  );
  const value = rows[0]?.cost_usd_estimated;
  return value == null ? null : Number(value);
}

async function analyticsCost(
  db: SqliteDb,
  sessionId: string
): Promise<number | null> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { est_cost: number | null }[]
  >("SELECT est_cost FROM session_analytics WHERE session_id = $1", sessionId);
  const value = rows[0]?.est_cost;
  return value == null ? null : Number(value);
}

async function sessionCost(
  db: SqliteDb,
  sessionId: string
): Promise<number | null> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { cost_usd_estimated: number | null }[]
  >("SELECT cost_usd_estimated FROM sessions WHERE id = $1", sessionId);
  const value = rows[0]?.cost_usd_estimated;
  return value == null ? null : Number(value);
}

test("boot re-pricing prices newly-priceable rows and heals both cost snapshots", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db, "sess-mixed");
    // A model that was unpriceable at import (NULL cost) but the current pricing
    // table now prices, a model that is STILL unpriceable, and a row already
    // priced at import.
    await insertToken(
      db,
      "sess-mixed",
      "claude-opus-4-5",
      OPUS_INPUT_TOKENS,
      null
    );
    await insertToken(db, "sess-mixed", "totally-made-up-model-xyz", 500, null);
    await insertToken(
      db,
      "sess-mixed",
      "claude-sonnet-4-5",
      100,
      PREPRICED_COST
    );

    // Materialize the rollup the way ingest does. est_cost / sessions cost see
    // only the one priced row — the snapshot the dashboard KPI would undercount.
    await db.prisma.write((client) =>
      client.$transaction((tx) =>
        upsertSessionAnalyticsRollup(tx, "sess-mixed", NOW)
      )
    );
    // The analytics rollup sees only the one priced row (the dashboard KPI the
    // bug undercounts). `sessions.cost_usd_estimated` is computed by a separate
    // ingest-time pass this raw-seed test bypasses, so it starts NULL.
    assert.equal(await analyticsCost(db, "sess-mixed"), PREPRICED_COST);
    assert.equal(await sessionCost(db, "sess-mixed"), null);

    const logs: string[] = [];
    await repriceUnpricedTokenUsage(db.prisma, (m) => logs.push(m));

    // The newly-priceable row is persisted; the still-unknown row stays NULL;
    // the pre-priced row is untouched.
    assert.equal(
      await tokenCost(db, "sess-mixed", "claude-opus-4-5"),
      OPUS_REPRICED_COST
    );
    assert.equal(
      await tokenCost(db, "sess-mixed", "totally-made-up-model-xyz"),
      null
    );
    assert.equal(
      await tokenCost(db, "sess-mixed", "claude-sonnet-4-5"),
      PREPRICED_COST
    );

    // Both materialized snapshots now include the re-priced cost, so they agree
    // with the read-time re-pricing surfaces.
    const expected = PREPRICED_COST + OPUS_REPRICED_COST;
    assert.equal(await analyticsCost(db, "sess-mixed"), expected);
    assert.equal(await sessionCost(db, "sess-mixed"), expected);

    assert.ok(
      logs.some((m) =>
        m.includes("token-usage re-pricing complete: repriced 1 row(s)")
      ),
      `expected completion log, got: ${logs.join(" | ")}`
    );

    // Idempotent: a second run finds the row priced (no longer NULL) and changes
    // nothing.
    await repriceUnpricedTokenUsage(db.prisma, () => undefined);
    assert.equal(await analyticsCost(db, "sess-mixed"), expected);
    assert.equal(await sessionCost(db, "sess-mixed"), expected);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("boot re-pricing is a no-op when every token_usage row is already priced", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db, "sess-priced");
    await insertToken(
      db,
      "sess-priced",
      "claude-sonnet-4-5",
      100,
      PREPRICED_COST
    );

    const logs: string[] = [];
    await repriceUnpricedTokenUsage(db.prisma, (m) => logs.push(m));

    assert.equal(
      await tokenCost(db, "sess-priced", "claude-sonnet-4-5"),
      PREPRICED_COST
    );
    // No NULL rows → the pass returns before emitting a completion log.
    assert.equal(logs.length, 0);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("boot re-pricing spans multiple chunks across sessions", async () => {
  const { db, dir } = await openTempDb();
  try {
    const sessionIds = ["sess-a", "sess-b", "sess-c"];
    for (const id of sessionIds) {
      await insertSession(db, id);
      await insertToken(db, id, "claude-opus-4-5", OPUS_INPUT_TOKENS, null);
      await db.prisma.write((client) =>
        client.$transaction((tx) => upsertSessionAnalyticsRollup(tx, id, NOW))
      );
    }

    // chunkSize=1 forces one transaction per session, exercising the loop
    // boundary the default 500-chunk path never hits in test.
    await repriceUnpricedTokenUsage(db.prisma, () => undefined, 1);

    for (const id of sessionIds) {
      assert.equal(
        await tokenCost(db, id, "claude-opus-4-5"),
        OPUS_REPRICED_COST
      );
      assert.equal(await analyticsCost(db, id), OPUS_REPRICED_COST);
      assert.equal(await sessionCost(db, id), OPUS_REPRICED_COST);
    }
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
