import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InsightsSection } from "@closedloop-ai/loops-api/insights";
import {
  BASELINE_MIGRATIONS,
  LEGACY_SCHEMA_REASSERT_SEQUENCE,
} from "../src/main/database/baseline-schema.js";
import { openLibsqlDatabase } from "../src/main/database/libsql-executor.js";
import { computeLocalInsights } from "../src/main/database/local-insights.js";
import { runDesktopMigrations } from "../src/main/database/migration-runner.js";
import { MIGRATIONS } from "../src/main/database/migrations-manifest.js";
import {
  createDesktopPrisma,
  type WriteSerializer,
} from "../src/main/database/prisma-client.js";

/**
 * FEA-1791 Phase 3 contract test for the Insights backend after `local-insights.ts`
 * moved off the raw `SqliteExecutor` handle onto the single `DesktopPrisma`
 * client. The sqlite-conversion golden suite already pins exact byte-for-byte
 * section output against a seeded DB (run in CI, where the runtime + electron
 * load); this test is the ELECTRON-FREE companion that builds the Prisma client
 * straight from the migration runner (no `sqlite.ts`/electron import) so the
 * conversion is verifiable in the dev sandbox too. It focuses on the parts the
 * conversion actually changed:
 *
 * - the TYPED `agent.groupBy` / `session.groupBy` reads (agentsByStatus /
 *   agentsByType / sessionsByStatus) produce the same keys / counts / desc order
 *   as the old `GROUP BY … ORDER BY n DESC` SQL, with a nullable `type` mapped to
 *   'unknown';
 * - aggregate INTEGER columns the Prisma raw path can surface as `bigint` come
 *   back as JS numbers through the `num()` / `token()` coercion boundary.
 */

// computeLocalInsights only reads, so the write queue is never exercised — a
// pass-through satisfies the factory without importing sqlite.ts (electron).
const passthroughQueue: WriteSerializer = { run: (fn) => fn() };

const NOW = new Date("2026-06-22T00:00:00.000Z");
const IN_WINDOW = "2026-06-20T10:00:00.000Z";

test("FEA-1791: local insights run on the single Prisma client against real libSQL", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-insights-contract-"));
  const { db, config } = await openLibsqlDatabase(
    path.join(dir, "agent-dashboard.sqlite")
  );
  await runDesktopMigrations(db, {
    migrations: MIGRATIONS,
    baselineStatements: LEGACY_SCHEMA_REASSERT_SEQUENCE,
    baselineMigrations: BASELINE_MIGRATIONS,
  });
  const prisma = createDesktopPrisma(config, passthroughQueue);
  try {
    // Three in-window sessions: status completed×2, running×1.
    for (const [id, status] of [
      ["s1", "completed"],
      ["s2", "completed"],
      ["s3", "running"],
    ]) {
      await db.query(
        "INSERT INTO sessions (id, status, started_at, ended_at) VALUES ($1, $2, $3, $4)",
        [id, status, IN_WINDOW, "2026-06-20T11:00:00.000Z"]
      );
      await db.query(
        `INSERT INTO session_analytics (session_id, started_at, is_human, est_cost)
         VALUES ($1, $2, $3, $4)`,
        [id, IN_WINDOW, id === "s1" ? 1 : 0, 2.5]
      );
    }
    // Agents: status completed×2, running×1; type general×2, NULL×1.
    for (const [id, sessionId, status, type] of [
      ["a1", "s1", "completed", "general"],
      ["a2", "s1", "running", "general"],
      ["a3", "s2", "completed", null],
    ]) {
      await db.query(
        "INSERT INTO agents (id, session_id, status, type) VALUES ($1, $2, $3, $4)",
        [id, sessionId, status, type]
      );
    }
    // One tool event (Agents tool-runs KPI + Utilization eventsByType).
    await db.query(
      `INSERT INTO events (id, session_id, event_type, tool_name, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      ["e1", "s1", "PreToolUse", "Bash", IN_WINDOW]
    );
    // Token usage (Agents tokens KPI / model breakdown) — BigInt columns.
    await db.query(
      `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens)
       VALUES ($1, $2, 300, 100)`,
      ["s1", "claude-sonnet-4-5"]
    );

    // --- Agents section: typed agent.groupBy reads ------------------------
    const agents = await computeLocalInsights(
      prisma,
      InsightsSection.Agents,
      "90",
      NOW
    );
    const agentsByStatus = agents.charts.agentsByStatus;
    assert.deepEqual(
      agentsByStatus.map((b) => [b.key, b.value]),
      // completed (2) before running (1) — the SQL's ORDER BY n DESC.
      [
        ["completed", 2],
        ["running", 1],
      ]
    );
    assert.equal(typeof agentsByStatus[0]?.value, "number");
    assert.deepEqual(
      agents.charts.agentsByType.map((b) => [b.key, b.value]),
      // type general (2) before the NULL group mapped to 'unknown' (1).
      [
        ["general", 2],
        ["unknown", 1],
      ]
    );
    // Token KPIs come back as numbers (bigint-coerced), models distinct = 1.
    const tokensKpi = agents.kpis.find((k) => k.key === "tokens");
    assert.equal(tokensKpi?.value, 400);
    assert.equal(typeof tokensKpi?.value, "number");
    assert.equal(agents.kpis.find((k) => k.key === "models")?.value, 1);
    assert.equal(agents.kpis.find((k) => k.key === "tool-runs")?.value, 1);

    // --- Utilization section: typed session.groupBy read ------------------
    const utilization = await computeLocalInsights(
      prisma,
      InsightsSection.Utilization,
      "90",
      NOW
    );
    assert.deepEqual(
      utilization.charts.sessionsByStatus.map((b) => [b.key, b.value]),
      [
        ["completed", 2],
        ["running", 1],
      ]
    );
    const sessionsKpi = utilization.kpis.find((k) => k.key === "sessions");
    assert.equal(sessionsKpi?.value, 3);
    assert.equal(typeof sessionsKpi?.value, "number");
    assert.equal(utilization.kpis.find((k) => k.key === "events")?.value, 1);

    // --- Delivery section: raw reads still run + coerce -------------------
    const delivery = await computeLocalInsights(
      prisma,
      InsightsSection.Delivery,
      "90",
      NOW
    );
    // No PR artifacts seeded → captured 0, but the section must compute, and
    // the cost KPI sums session_analytics.est_cost (3 × 2.5) as a number.
    assert.equal(delivery.kpis.find((k) => k.key === "merged")?.value, 0);
    const costKpi = delivery.kpis.find((k) => k.key === "cost");
    assert.equal(costKpi?.value, 7.5);
    assert.equal(typeof costKpi?.value, "number");
  } finally {
    await prisma.disconnect();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
