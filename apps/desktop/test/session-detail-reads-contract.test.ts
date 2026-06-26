import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

/**
 * FEA-1791 Phase 3 contract test for the session DETAIL reads after they moved
 * off the raw `SqliteExecutor` handle onto the single `DesktopPrisma` client.
 * `getDetailsById`/`getActiveWithDetails`/`getHistoricalWithDetails`/`getPage`
 * keep their single `sessionDetailsCtes()` aggregate-join (per-session
 * COUNT(agents)/COUNT(events)/SUM(tokens) folded into the row in one query) on
 * `$queryRawUnsafe` — un-typeable AND the performant choice vs. per-table groupBy
 * marshalled to JS; only `attachEstimatedCosts` is converted to typed `findMany`.
 * Like the session/agent/event store contract tests this runs through
 * `openSqliteAgentDatabase` (electron), so it is a CI guard.
 *
 * The existing `sqlite-agent-dashboard-database` suite already pins the
 * per-session counts/token-totals and the `getPage` filter/escape/ordering. This
 * fills the gap it leaves: the CTE counts survive the move onto the one client,
 * and `attachEstimatedCosts` decorates `estimatedCostUsd` typed off that client on
 * every detail-read path (by-id, active, historical, page) — including the
 * literal-`%`/`_` escape on the q-search.
 */

const NOW = "2026-06-23T00:00:00.000Z";

test("FEA-1791: session detail reads + attachEstimatedCosts run on the single Prisma client", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "session-detail-reads-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
  try {
    // A running session carrying an authoritative cost_usd_estimated, two
    // agents, one event, and 400 tokens.
    await db.run(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness, cost_usd_estimated)
       VALUES ('cost-sess', 'Cost Session', 'running', $1, $1, 'claude', 1.25)`,
      "2026-06-20T10:00:00.000Z"
    );
    await db.run(
      `INSERT INTO agents (id, session_id, status) VALUES ('a1','cost-sess','running'),('a2','cost-sess','completed')`
    );
    await db.run(
      `INSERT INTO events (id, session_id, event_type) VALUES ('e1','cost-sess','PreToolUse')`
    );
    await db.run(
      `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens)
       VALUES ('cost-sess','claude-sonnet-4-5',300,100)`
    );
    // A terminal (completed) session with one agent — exercises the historical
    // read's `status IN (terminal)` filter and the cache.
    await db.run(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
       VALUES ('done-sess', 'Done Session', 'completed', $1, $1, 'claude')`,
      "2026-06-20T09:00:00.000Z"
    );
    await db.run(
      `INSERT INTO agents (id, session_id, status) VALUES ('a3','done-sess','completed')`
    );

    // getDetailsById: per-session counts + token total + the attached estimated cost.
    const detail = await db.sessions.getDetailsById("cost-sess");
    assert.ok(detail, "expected the session detail row");
    assert.equal(detail.agentCount, 2);
    assert.equal(detail.eventCount, 1);
    assert.equal(detail.totalTokens, 400);
    assert.equal(typeof detail.totalTokens, "number");
    assert.equal(detail.estimatedCostUsd, 1.25);
    assert.equal(await db.sessions.getDetailsById("missing"), undefined);

    // getActiveWithDetails: non-terminal sessions only, carrying the decoration.
    const active = await db.sessions.getActiveWithDetails();
    const activeCost = active.find((s) => s.id === "cost-sess");
    assert.ok(activeCost);
    assert.equal(activeCost.agentCount, 2);
    assert.equal(activeCost.estimatedCostUsd, 1.25);
    // The completed session must NOT appear in the active read.
    assert.equal(
      active.some((s) => s.id === "done-sess"),
      false
    );

    // getHistoricalWithDetails: terminal sessions only (status IN terminal), with
    // the same typed groupBy counts — and the running session excluded.
    const historical = await db.sessions.getHistoricalWithDetails();
    const done = historical.find((s) => s.id === "done-sess");
    assert.ok(done, "expected the completed session in the historical read");
    assert.equal(done.agentCount, 1);
    assert.equal(done.eventCount, 0);
    assert.equal(done.totalTokens, 0);
    assert.equal(
      historical.some((s) => s.id === "cost-sess"),
      false
    );

    // getPage: total + the typed page read + cost decoration (both sessions).
    const page = await db.sessions.getPage({ limit: 10, offset: 0 });
    assert.equal(page.total, 2);
    const pageCost = page.sessions.find((s) => s.id === "cost-sess");
    assert.ok(pageCost);
    assert.equal(pageCost.totalTokens, 400);
    assert.equal(pageCost.estimatedCostUsd, 1.25);

    // getPage q-search ESCAPE path still matches by name through the client.
    const searched = await db.sessions.getPage({ q: "Cost" });
    assert.deepEqual(
      searched.sessions.map((s) => s.id),
      ["cost-sess"]
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
