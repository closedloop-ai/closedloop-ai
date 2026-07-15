import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { createSqliteSessionSyncSource } from "../src/main/database/sync-source.js";
import {
  repriceUnpricedTokenUsage,
  upsertSessionAnalyticsRollup,
} from "../src/main/database/write-core.js";

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const NOW = "2026-06-21T12:00:00.000Z";

// claude-opus-4-5 @ 1000 input tokens prices to exactly $0.005 (see
// token-cost.test.ts). A compacted row whose EFFECTIVE input is
// current(1000) + baseline(1000) = 2000 must price to $0.010 — twice the
// current-only value the FEA-2879 bug would (silently) charge.
const CURRENT_INPUT = 1000;
const BASELINE_INPUT = 1000;
const EFFECTIVE_COST = 0.01;
const CURRENT_ONLY_COST = 0.005;

async function openTempDb(): Promise<{ db: SqliteDb; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "token-usage-compaction-"));
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

// Insert a token_usage row whose pre-compaction totals were rolled into
// baseline_* by upsertTokenUsage's Gap 5 / compaction-resilience path.
async function insertCompactedToken(
  db: SqliteDb,
  sessionId: string,
  model: string,
  opts: {
    currentInput: number;
    baselineInput: number;
    cost: number | null;
  }
): Promise<void> {
  await db.run(
    `INSERT INTO token_usage (
       session_id, model,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       baseline_input, baseline_output, baseline_cache_read, baseline_cache_write,
       created_at, cost_usd_estimated
     )
     VALUES ($1, $2, $3, 0, 0, 0, $4, 0, 0, 0, $5, $6)`,
    sessionId,
    model,
    opts.currentInput,
    opts.baselineInput,
    "2026-06-20T08:00:00.000Z",
    opts.cost
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

async function analytics(
  db: SqliteDb,
  sessionId: string
): Promise<{ estCost: number | null; inputTokens: number | null }> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { est_cost: number | null; input_tokens: number | null }[]
  >(
    "SELECT est_cost, input_tokens FROM session_analytics WHERE session_id = $1",
    sessionId
  );
  const row = rows[0];
  return {
    estCost: row?.est_cost == null ? null : Number(row.est_cost),
    inputTokens: row?.input_tokens == null ? null : Number(row.input_tokens),
  };
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

// FEA-2879: baseline_* preserves the pre-compaction totals on transcript
// compaction. The boot reprice must fold them into the effective total it
// prices, so a compacted session's healed cost reflects ALL incurred tokens.
test("boot re-pricing prices the effective total (current + baseline) of a compacted row", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db, "sess-compacted");
    await insertCompactedToken(db, "sess-compacted", "claude-opus-4-5", {
      currentInput: CURRENT_INPUT,
      baselineInput: BASELINE_INPUT,
      cost: null,
    });

    // Materialize the rollup the way ingest does — est_cost starts at 0 (the
    // one row is unpriced).
    await db.prisma.write((client) =>
      client.$transaction((tx) =>
        upsertSessionAnalyticsRollup(tx, "sess-compacted", NOW)
      )
    );
    assert.equal((await analytics(db, "sess-compacted")).estCost, 0);

    await repriceUnpricedTokenUsage(db.prisma, () => undefined);

    // Priced on the effective total, NOT the post-compaction subset.
    assert.equal(
      await tokenCost(db, "sess-compacted", "claude-opus-4-5"),
      EFFECTIVE_COST
    );
    assert.notEqual(
      await tokenCost(db, "sess-compacted", "claude-opus-4-5"),
      CURRENT_ONLY_COST
    );

    // Both materialized cost snapshots agree on the effective cost.
    const rolled = await analytics(db, "sess-compacted");
    assert.equal(rolled.estCost, EFFECTIVE_COST);
    assert.equal(await sessionCost(db, "sess-compacted"), EFFECTIVE_COST);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// FEA-2879 (P2 repair): a row compacted BEFORE this patch already has
// baseline_* populated AND a non-null cost_usd_estimated computed by the old
// current-only pricing path (which ignored baseline_*). The boot reprice must
// repair those already-costed compacted rows to the effective total, and must
// converge — a second pass over a now-correct row is a no-op.
test("boot re-pricing repairs an already-costed compacted row and is convergent", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db, "sess-precosted");
    // Simulate the pre-FEA-2879 state: baseline_* preserved by the compaction
    // path, but cost frozen at the current-only price ($0.005), undercounting.
    await insertCompactedToken(db, "sess-precosted", "claude-opus-4-5", {
      currentInput: CURRENT_INPUT,
      baselineInput: BASELINE_INPUT,
      cost: CURRENT_ONLY_COST,
    });

    await db.prisma.write((client) =>
      client.$transaction((tx) =>
        upsertSessionAnalyticsRollup(tx, "sess-precosted", NOW)
      )
    );
    // The rollup already sums est_cost from the (undercounted) per-row cost.
    assert.equal(
      (await analytics(db, "sess-precosted")).estCost,
      CURRENT_ONLY_COST
    );

    await repriceUnpricedTokenUsage(db.prisma, () => undefined);

    // Repriced to the effective total, not the frozen current-only value.
    assert.equal(
      await tokenCost(db, "sess-precosted", "claude-opus-4-5"),
      EFFECTIVE_COST
    );
    const rolled = await analytics(db, "sess-precosted");
    assert.equal(rolled.estCost, EFFECTIVE_COST);
    assert.equal(await sessionCost(db, "sess-precosted"), EFFECTIVE_COST);

    // Convergence / idempotency: a second pass leaves the (now-correct) row at
    // the effective total — no double-count, no drift.
    await repriceUnpricedTokenUsage(db.prisma, () => undefined);
    assert.equal(
      await tokenCost(db, "sess-precosted", "claude-opus-4-5"),
      EFFECTIVE_COST
    );
    assert.equal(
      (await analytics(db, "sess-precosted")).estCost,
      EFFECTIVE_COST
    );
    assert.equal(await sessionCost(db, "sess-precosted"), EFFECTIVE_COST);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// FEA-2879: a NON-compacted, already-correctly-priced row (no baseline_*) must
// not be touched by the reprice pass — guards against the broadened selection
// re-pricing healthy rows.
test("boot re-pricing leaves a correctly-priced non-compacted row untouched", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db, "sess-healthy");
    await insertCompactedToken(db, "sess-healthy", "claude-opus-4-5", {
      currentInput: CURRENT_INPUT,
      baselineInput: 0,
      cost: CURRENT_ONLY_COST,
    });

    await repriceUnpricedTokenUsage(db.prisma, () => undefined);

    // current-only == effective total here (no baseline), so cost is unchanged.
    assert.equal(
      await tokenCost(db, "sess-healthy", "claude-opus-4-5"),
      CURRENT_ONLY_COST
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// FEA-2879: the materialized session_analytics token COUNTS must also include
// the pre-compaction baseline_*, not just the post-compaction current_* subset.
test("session_analytics rollup counts the effective (current + baseline) tokens", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db, "sess-counts");
    await insertCompactedToken(db, "sess-counts", "claude-opus-4-5", {
      currentInput: CURRENT_INPUT,
      baselineInput: BASELINE_INPUT,
      cost: CURRENT_ONLY_COST,
    });

    await db.prisma.write((client) =>
      client.$transaction((tx) =>
        upsertSessionAnalyticsRollup(tx, "sess-counts", NOW)
      )
    );

    const rolled = await analytics(db, "sess-counts");
    assert.equal(rolled.inputTokens, CURRENT_INPUT + BASELINE_INPUT);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// FEA-2922: the per-model sync projection (tokenUsageByModel) must ship the
// EFFECTIVE (current + baseline) totals too, mirroring the session_analytics
// rollup. Otherwise a compacted session syncs raw post-compaction counts while
// its co-synced rollup carries effective totals — they disagree, and the raw
// counts contradict the effective-priced per-model cost.
test("tokenUsageByModel sync projection ships the effective (current + baseline) totals", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db, "sess-sync");
    // Stored cost is the effective-priced value (what FEA-2879 materializes).
    await insertCompactedToken(db, "sess-sync", "claude-opus-4-5", {
      currentInput: CURRENT_INPUT,
      baselineInput: BASELINE_INPUT,
      cost: EFFECTIVE_COST,
    });

    const [session] = await createSqliteSessionSyncSource(
      db.prisma
    ).loadUsageSessions(["sess-sync"]);
    const perModel = session?.tokenUsageByModel?.[0];
    assert.ok(perModel, "expected a per-model token usage row");

    // Effective input total, NOT the post-compaction subset (the bug shipped
    // CURRENT_INPUT alone).
    assert.equal(perModel.inputTokens, CURRENT_INPUT + BASELINE_INPUT);
    assert.notEqual(perModel.inputTokens, CURRENT_INPUT);

    // Cost (effective-priced) and counts (now effective) agree — no
    // cost/count mismatch inside the synced per-model row.
    assert.equal(perModel.estimatedCostUsd, EFFECTIVE_COST);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// FEA-2922: non-compacted sessions must still produce correct token counts —
// the effective-total rollup must reduce to the current-only counts when a row
// was never compacted. `baseline_*` is `NOT NULL DEFAULT 0` (see 0001_init /
// schema.prisma), so a real non-compacted row carries baseline_* = 0 (the
// column default), NOT NULL: omitting the columns exercises that exact state.
test("non-compacted sessions (default-0 baseline) produce correct token counts", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db, "sess-non-compacted");
    // Insert a token_usage row that OMITS the baseline_* columns, so each takes
    // its schema DEFAULT of 0 — exactly the shape of a never-compacted row.
    await db.run(
      `INSERT INTO token_usage (
         session_id, model,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         created_at, cost_usd_estimated
       )
       VALUES ($1, $2, $3, 0, 0, 0, $4, $5)`,
      "sess-non-compacted",
      "claude-opus-4-5",
      CURRENT_INPUT,
      "2026-06-20T08:00:00.000Z",
      CURRENT_ONLY_COST
    );

    // Rollup must not produce NaN — effective input = current + baseline(0) = current.
    // Drive it through a Prisma transaction exactly as ingest does
    // (importPhaseDerivedRollups passes the phase `tx`), not by handing the
    // SqliteDb wrapper straight to a function typed for Prisma.TransactionClient.
    await db.prisma.write((client) =>
      client.$transaction((tx) =>
        upsertSessionAnalyticsRollup(tx, "sess-non-compacted", NOW)
      )
    );
    const snap = await analytics(db, "sess-non-compacted");
    assert.equal(snap.inputTokens, CURRENT_INPUT);
    assert.notEqual(snap.inputTokens, Number.NaN);

    // Sync projection must also produce correct counts.
    const [session] = await createSqliteSessionSyncSource(
      db.prisma
    ).loadUsageSessions(["sess-non-compacted"]);
    const perModel = session?.tokenUsageByModel?.[0];
    assert.ok(perModel, "expected a per-model token usage row");
    assert.equal(perModel.inputTokens, CURRENT_INPUT);
    assert.notEqual(perModel.inputTokens, Number.NaN);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
