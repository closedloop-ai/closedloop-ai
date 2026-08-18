/**
 * @file ttl-premium-removal-heal.test.ts
 * @description FEA-3419: `healSessionRollupAfterTtlPremiumRemoval` converges
 * session cost rollups that still embed the REMOVED FEA-3636 session-level 1h
 * TTL premium term. Those rows exist only where a rev-24..30 import persisted
 * the retired `usageExtras.cache_creation` metadata blob (1h > 0) and the raw
 * transcript is gone, so the DATA_REVISION 38 rebuild cannot re-derive them.
 * The heal recomputes the rollup from scratch (pure Σ token_usage + web
 * search), bumps the ISO sync watermark ONLY for sessions whose cost actually
 * changed, and is idempotent — a second run writes nothing.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { healSessionRollupAfterTtlPremiumRemoval } from "../src/main/database/token-cost-maintenance.js";
import { makeSession } from "./normalized-session-test-utils.js";

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const DB_NOW = "2026-06-21T12:00:00.000Z";

async function openTempDb(): Promise<{ db: SqliteDb; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ttl-premium-heal-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => DB_NOW,
  });
  return { db, dir };
}

async function sessionRow(
  db: SqliteDb,
  id: string
): Promise<{ cost: number | null; updatedAt: string | null }> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { cost_usd_estimated: number | null; updated_at: string | null }[]
  >("SELECT cost_usd_estimated, updated_at FROM sessions WHERE id = $1", id);
  return {
    cost: rows[0]?.cost_usd_estimated ?? null,
    updatedAt: rows[0]?.updated_at ?? null,
  };
}

async function analyticsUpdatedAt(
  db: SqliteDb,
  id: string
): Promise<string | null> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { updated_at: string | null }[]
  >("SELECT updated_at FROM session_analytics WHERE session_id = $1", id);
  return rows[0]?.updated_at ?? null;
}

test("ttl-premium-removal heal corrects a stale premium-embedded rollup, bumps the ISO watermark once, and is idempotent", async () => {
  const { db, dir } = await openTempDb();
  const logs: string[] = [];
  const log = (message: string) => {
    logs.push(message);
  };
  try {
    // A session imported under the NEW code: typed split, premium inside the
    // token rows, rollup already correct.
    await db.importer.importSession(
      makeSession({
        sessionId: "stale-premium",
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
      }),
      "claude"
    );
    const correct = await sessionRow(db, "stale-premium");
    assert.ok(correct.cost !== null && correct.cost > 0);

    // Simulate a rev-24..30 unretained row: the retired blob persists in
    // metadata (1h > 0) and the stored rollup still embeds the removed
    // session-level premium (cost inflated by a fake extra term). Backdate
    // updated_at so the watermark bump is observable.
    const staleCost = (correct.cost ?? 0) + 0.5;
    await db.prisma.write((client) =>
      client.$executeRawUnsafe(
        `UPDATE sessions SET
           cost_usd_estimated = $1,
           metadata = json_set(COALESCE(metadata, '{}'),
             '$.usageExtras.cache_creation',
             json('{"ephemeral_5m_input_tokens":600,"ephemeral_1h_input_tokens":400}')),
           updated_at = $2
         WHERE id = $3`,
        staleCost,
        "2026-01-01T00:00:00.000Z",
        "stale-premium"
      )
    );

    await healSessionRollupAfterTtlPremiumRemoval(db.prisma, log);

    const healed = await sessionRow(db, "stale-premium");
    // The rollup converged back to the pure Σ(token_usage) total (which already
    // carries the per-event premium) — the fake session-level term is gone.
    assert.ok(healed.cost !== null);
    assert.ok(Math.abs((healed.cost ?? 0) - (correct.cost ?? 0)) < 1e-9);
    // ISO watermark advanced past the backdated cursor value and is 'T'-form
    // (visible to the raw-string sync cursor — never datetime('now') space-form).
    assert.ok(healed.updatedAt !== null);
    assert.ok((healed.updatedAt ?? "") > "2026-01-01T00:00:00.000Z");
    assert.ok((healed.updatedAt ?? "").includes("T"));
    assert.ok(logs.some((m) => m.includes("recomputed 1 session(s)")));
    const healedAnalyticsUpdatedAt = "2026-01-02T00:00:00.000Z";
    await db.run(
      "UPDATE session_analytics SET updated_at = $1 WHERE session_id = $2",
      healedAnalyticsUpdatedAt,
      "stale-premium"
    );

    // Idempotent: a second run finds the cost already conserved and bumps
    // nothing — the watermark is untouched.
    const logsBefore = logs.length;
    await healSessionRollupAfterTtlPremiumRemoval(db.prisma, log);
    const second = await sessionRow(db, "stale-premium");
    assert.equal(second.updatedAt, healed.updatedAt);
    assert.equal(
      await analyticsUpdatedAt(db, "stale-premium"),
      healedAnalyticsUpdatedAt
    );
    assert.ok(Math.abs((second.cost ?? 0) - (healed.cost ?? 0)) < 1e-9);
    assert.equal(
      logs.slice(logsBefore).filter((m) => m.includes("recomputed")).length,
      0
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ttl-premium-removal heal ignores sessions without the retired blob", async () => {
  const { db, dir } = await openTempDb();
  const logs: string[] = [];
  try {
    await db.importer.importSession(
      makeSession({
        sessionId: "clean",
        model: "claude-opus-4-5",
        tokensByModel: {
          "claude-opus-4-5": {
            input: 1000,
            output: 100,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
        tokenSeries: [
          {
            timestamp: "2026-01-01T00:00:30.000Z",
            model: "claude-opus-4-5",
            input: 1000,
            output: 100,
            cacheRead: 0,
            cacheWrite: 0,
          },
        ],
      }),
      "claude"
    );
    const before = await sessionRow(db, "clean");
    await healSessionRollupAfterTtlPremiumRemoval(db.prisma, (m) =>
      logs.push(m)
    );
    const after = await sessionRow(db, "clean");
    // No blob → not a candidate → nothing recomputed, watermark untouched.
    assert.equal(after.updatedAt, before.updatedAt);
    assert.equal(logs.length, 0);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
