import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

/**
 * FEA-1791 Phase 3 contract test for the events + token-usage store reads after
 * their conversion onto typed Prisma delegates. Seeds rows with raw SQL (so the
 * data is independent of the typed write path) and asserts the converted reads
 * preserve ordering, the LEFT JOIN session-name semantics (including the
 * name-is-null-when-the-session-row-is-absent case the old query produced), the
 * COUNT(*) GROUP BY ordering, and the BIGINT -> JS-number coercion.
 */

async function openDb() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "event-store-contract-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    emit: () => undefined,
    now: () => "2026-06-22T00:00:00.000Z",
  });
  return { db, dir };
}

async function seedEvent(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>,
  row: {
    id: string;
    sessionId: string;
    agentId: string | null;
    eventType: string;
    createdAt: string;
  }
) {
  await db.run(
    "INSERT INTO events (id, session_id, agent_id, event_type, created_at) VALUES ($1, $2, $3, $4, $5)",
    row.id,
    row.sessionId,
    row.agentId,
    row.eventType,
    row.createdAt
  );
}

test("FEA-1791: events store reads convert onto typed Prisma delegates", async () => {
  const { db, dir } = await openDb();
  try {
    await db.run(
      "INSERT INTO sessions (id, name) VALUES ($1, $2)",
      "sess-a",
      "Session A"
    );
    await db.run(
      "INSERT INTO sessions (id, name) VALUES ($1, $2)",
      "sess-b",
      "Session B"
    );
    // No `sessions` row for sess-orphan: its event must still surface with a
    // null sessionName (the old LEFT JOIN behavior).

    // Distinct per-type counts (3 / 2 / 1) so the GROUP BY ... ORDER BY count
    // DESC ordering is unambiguous.
    await seedEvent(db, {
      id: "e1",
      sessionId: "sess-a",
      agentId: "agent-1",
      eventType: "UserPromptSubmit",
      createdAt: "2026-06-01T00:00:01.000Z",
    });
    await seedEvent(db, {
      id: "e2",
      sessionId: "sess-a",
      agentId: "agent-1",
      eventType: "PreToolUse",
      createdAt: "2026-06-01T00:00:02.000Z",
    });
    await seedEvent(db, {
      id: "e3",
      sessionId: "sess-a",
      agentId: "agent-2",
      eventType: "UserPromptSubmit",
      createdAt: "2026-06-01T00:00:03.000Z",
    });
    await seedEvent(db, {
      id: "e4",
      sessionId: "sess-b",
      agentId: null,
      eventType: "UserPromptSubmit",
      createdAt: "2026-06-01T00:00:04.000Z",
    });
    await seedEvent(db, {
      id: "e5",
      sessionId: "sess-b",
      agentId: null,
      eventType: "PreToolUse",
      createdAt: "2026-06-01T00:00:05.000Z",
    });
    await seedEvent(db, {
      id: "e6",
      sessionId: "sess-orphan",
      agentId: null,
      eventType: "Stop",
      createdAt: "2026-06-01T00:00:06.000Z",
    });

    // getBySession: ascending by created_at, scoped to the session.
    const bySession = await db.events.getBySession("sess-a");
    assert.deepEqual(
      bySession.map((e) => e.id),
      ["e1", "e2", "e3"]
    );
    assert.equal(bySession[0].eventType, "UserPromptSubmit");
    assert.equal(bySession[0].agentId, "agent-1");

    // getBySessionAndAgent: further scoped to one agent.
    const byAgent = await db.events.getBySessionAndAgent("sess-a", "agent-1");
    assert.deepEqual(
      byAgent.map((e) => e.id),
      ["e1", "e2"]
    );

    // getAll: newest first, capped, with the session name joined in and null for
    // the orphaned event whose session row does not exist.
    const all = await db.events.getAll();
    assert.deepEqual(
      all.map((e) => e.id),
      ["e6", "e5", "e4", "e3", "e2", "e1"]
    );
    const nameById = new Map(all.map((e) => [e.id, e.sessionName]));
    assert.equal(nameById.get("e1"), "Session A");
    assert.equal(nameById.get("e4"), "Session B");
    assert.equal(nameById.get("e6"), null);

    // getWithSession: ascending, name resolved for a present session...
    const withSession = await db.events.getWithSession("sess-a");
    assert.deepEqual(
      withSession.map((e) => e.id),
      ["e1", "e2", "e3"]
    );
    assert.ok(withSession.every((e) => e.sessionName === "Session A"));
    // ...and null when the session row is absent.
    const orphanWithSession = await db.events.getWithSession("sess-orphan");
    assert.deepEqual(
      orphanWithSession.map((e) => [e.id, e.sessionName]),
      [["e6", null]]
    );
    // No events for the session -> empty (exercises the early-return guard that
    // skips the session-name lookup).
    assert.deepEqual(await db.events.getWithSession("no-such-session"), []);

    // getCountByType: grouped counts, descending.
    const counts = await db.events.getCountByType();
    assert.deepEqual(counts, [
      { eventType: "UserPromptSubmit", count: 3 },
      { eventType: "PreToolUse", count: 2 },
      { eventType: "Stop", count: 1 },
    ]);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-1791: tokenUsage.getBySession coerces BIGINT columns to JS numbers, ordered by model", async () => {
  const { db, dir } = await openDb();
  try {
    await db.run(
      "INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES ($1, $2, $3, $4, $5, $6)",
      "sess-tok",
      "claude-sonnet-4-5",
      100,
      50,
      10,
      5
    );
    await db.run(
      "INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES ($1, $2, $3, $4, $5, $6)",
      "sess-tok",
      "claude-opus-4",
      200,
      80,
      0,
      0
    );

    const rows = await db.tokenUsage.getBySession("sess-tok");
    // Ordered by model ASC: "claude-opus-4" < "claude-sonnet-4-5".
    assert.deepEqual(
      rows.map((r) => r.model),
      ["claude-opus-4", "claude-sonnet-4-5"]
    );
    const opus = rows[0];
    assert.equal(opus.sessionId, "sess-tok");
    assert.equal(opus.inputTokens, 200);
    assert.equal(opus.outputTokens, 80);
    assert.equal(typeof opus.inputTokens, "number");
    const sonnet = rows[1];
    assert.equal(sonnet.inputTokens, 100);
    assert.equal(sonnet.outputTokens, 50);
    assert.equal(sonnet.cacheReadTokens, 10);
    assert.equal(sonnet.cacheWriteTokens, 5);

    // Unknown session -> empty.
    assert.deepEqual(await db.tokenUsage.getBySession("nope"), []);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
