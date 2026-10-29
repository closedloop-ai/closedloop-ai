/**
 * @file iss7820-legacy-analytics-cost-recompute.test.ts
 * @description ISS-7820 review (davetho): the boot pass that converges an
 * UPGRADED install onto the widened `session_analytics.est_cost`.
 *
 * Migration 0072 copies every legacy value across verbatim on purpose — it
 * cannot know which zeros were real — so an install that upgrades keeps its
 * pre-fix confident numbers. `backfillSessionAnalytics` cannot heal them: it
 * anti-joins on a MISSING analytics row, and an upgraded store has one for every
 * session. Without this pass a completed session keeps the wrong figure forever.
 *
 * The fixture seeds the three states directly into `session_analytics`, exactly
 * as the migration would leave them, and asserts the pass moves the two the new
 * derivation calls "unknown" while leaving the real total alone.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { startBootMaintenance } from "../src/main/database/boot-maintenance.js";
import { recomputeLegacySessionAnalyticsCost } from "../src/main/database/session-analytics-maintenance.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { openTestPrisma } from "./prisma-test-utils.js";

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const NOW = "2026-08-20T12:00:00.000Z";
/** The web-search line item ALONE, which the ticket measured on a $0.04753625 session. */
const LEGACY_PARTIAL_COST = 0.03;
/** "$0.00 with nothing priced and no web search" — indistinguishable from a real zero. */
const LEGACY_AMBIGUOUS_ZERO = 0;
/** A fully priced window's real total; this one must not move. */
const PRICED_COST = 1.25;

test("the pass nulls the legacy costs the new derivation calls unknown", async () => {
  const { db, dir } = await openTempDb();
  try {
    await seedUpgradedStore(db);
    assert.deepEqual(await readEstCosts(db), {
      "sess-ambiguous-zero": LEGACY_AMBIGUOUS_ZERO,
      "sess-partly-priced": LEGACY_PARTIAL_COST,
      "sess-priced": PRICED_COST,
    });

    const logs: string[] = [];
    await recomputeLegacySessionAnalyticsCost(db.prisma, (m) => logs.push(m));

    assert.deepEqual(await readEstCosts(db), {
      // Half its token_usage window is unpriced — the stored 0.03 was the web
      // search line item alone, and the column can now say so.
      "sess-ambiguous-zero": null,
      "sess-partly-priced": null,
      // Fully priced with a real total: untouched, which is what keeps a genuine
      // figure distinguishable from an absent one.
      "sess-priced": PRICED_COST,
    });
    assert.ok(
      logs.some((m) =>
        m.includes("legacy analytics cost recompute complete (ISS-7820): 2/2")
      ),
      `expected a 2/2 completion log, got ${JSON.stringify(logs)}`
    );
  } finally {
    await closeTempDb(db, dir);
  }
});

test("the pass is convergent — a second run selects nothing", async () => {
  const { db, dir } = await openTempDb();
  try {
    await seedUpgradedStore(db);
    await recomputeLegacySessionAnalyticsCost(db.prisma, () => undefined);
    const afterFirst = await readEstCosts(db);

    const logs: string[] = [];
    await recomputeLegacySessionAnalyticsCost(db.prisma, (m) => logs.push(m));

    assert.deepEqual(await readEstCosts(db), afterFirst);
    assert.deepEqual(
      logs,
      [],
      "a converged store must not re-select, re-write, or re-log"
    );
  } finally {
    await closeTempDb(db, dir);
  }
});

/*
 * The pass is only a repair if the boot chain actually runs it — a pass nobody
 * calls heals nothing, and deleting its `.then(...)` would leave both tests above
 * green. The fixture here is a session with NO `token_usage` at all and no web
 * search: nothing was measured, so the derivation says "unknown", and no other
 * boot pass selects it (the analytics backfill anti-joins on a MISSING rollup
 * row, the headless recompute needs `is_human = 1`, the imported agent-turn heal
 * needs transcript metadata). Reprice has nothing to price, so the state cannot
 * be reached by any other pass in the chain.
 */
test("the boot maintenance chain runs the pass", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    await db.query(
      `INSERT INTO sessions (id, status, started_at, updated_at, ended_at)
       VALUES ($1, 'inactive', $2, $2, $2)`,
      ["sess-nothing-measured", NOW]
    );
    await db.query(
      `INSERT INTO session_analytics (session_id, started_day, status, harness, is_human, est_cost, updated_at)
       VALUES ($1, '2026-08-20', 'inactive', 'claude', 0, $2, $3)`,
      ["sess-nothing-measured", LEGACY_AMBIGUOUS_ZERO, NOW]
    );

    const logs: string[] = [];
    await startBootMaintenance(prisma, (m) => logs.push(m));

    const rows = await prisma.client.$queryRawUnsafe<
      { est_cost: number | null }[]
    >(
      "SELECT est_cost FROM session_analytics WHERE session_id = $1",
      "sess-nothing-measured"
    );
    assert.equal(
      rows[0]?.est_cost,
      null,
      "the ambiguous legacy zero is gone after the boot chain settles"
    );
    assert.ok(
      logs.some((m) =>
        m.includes("legacy analytics cost recompute complete (ISS-7820)")
      ),
      `the pass reported from inside the chain, got ${JSON.stringify(logs)}`
    );
  } finally {
    await close();
  }
});

async function openTempDb(): Promise<{ db: SqliteDb; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss7820-legacy-cost-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
  return { db, dir };
}

async function closeTempDb(db: SqliteDb, dir: string): Promise<void> {
  await db.close?.();
  await rm(dir, { recursive: true, force: true });
}

type SeedSession = {
  id: string;
  legacyEstCost: number;
  tokenUsage: { model: string; costUsd: number | null }[];
};

const SESSIONS: SeedSession[] = [
  {
    id: "sess-partly-priced",
    legacyEstCost: LEGACY_PARTIAL_COST,
    tokenUsage: [
      { costUsd: 0.02, model: "claude-sonnet-4-5" },
      { costUsd: null, model: "some-unpriced-model" },
    ],
  },
  {
    id: "sess-ambiguous-zero",
    legacyEstCost: LEGACY_AMBIGUOUS_ZERO,
    tokenUsage: [{ costUsd: null, model: "some-unpriced-model" }],
  },
  {
    id: "sess-priced",
    legacyEstCost: PRICED_COST,
    tokenUsage: [{ costUsd: PRICED_COST, model: "claude-sonnet-4-5" }],
  },
];

/**
 * An install as migration 0072 leaves it: an analytics row for every session,
 * carrying the value the pre-fix rollup wrote.
 */
async function seedUpgradedStore(db: SqliteDb): Promise<void> {
  await db.run("DELETE FROM session_analytics");
  for (const session of SESSIONS) {
    await db.run(
      `INSERT INTO sessions (id, status, started_at, updated_at, ended_at)
       VALUES ($1, 'inactive', $2, $2, $2)`,
      session.id,
      NOW
    );
    for (const row of session.tokenUsage) {
      await db.run(
        `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, created_at, cost_usd_estimated)
         VALUES ($1, $2, 100, 200, $3, $4)`,
        session.id,
        row.model,
        NOW,
        row.costUsd
      );
    }
    await db.run(
      `INSERT INTO session_analytics (session_id, started_day, status, harness, est_cost, updated_at)
       VALUES ($1, '2026-08-20', 'inactive', 'claude', $2, $3)`,
      session.id,
      session.legacyEstCost,
      NOW
    );
  }
}

async function readEstCosts(
  db: SqliteDb
): Promise<Record<string, number | null>> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { session_id: string; est_cost: number | null }[]
  >("SELECT session_id, est_cost FROM session_analytics ORDER BY session_id");
  const costs: Record<string, number | null> = {};
  for (const row of rows) {
    costs[row.session_id] = row.est_cost === null ? null : Number(row.est_cost);
  }
  return costs;
}
