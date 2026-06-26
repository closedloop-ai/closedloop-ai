import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  backfillSessionAnalytics,
  openSqliteAgentDatabase,
  upsertSessionAnalyticsRollup,
} from "../src/main/database/sqlite.js";

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const NOW = "2026-06-21T12:00:00.000Z";

async function openTempDb(): Promise<{ db: SqliteDb; dir: string }> {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "session-analytics-backfill-")
  );
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => NOW,
  });
  return { db, dir };
}

type SeedSession = {
  id: string;
  status: string;
  harness: string;
  startedAt: string | null;
  endedAt: string | null;
  metadata: string | null;
  events: { type: string; tool?: string | null }[];
  tokens?: {
    model: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
  }[];
};

const SESSIONS: SeedSession[] = [
  {
    // Human session: two user turns → is_human, assistant + tool + error events,
    // tokens across two models, finite runtime.
    id: "sess-human",
    status: "completed",
    harness: "claude_code",
    startedAt: "2026-06-20T08:00:00.000Z",
    endedAt: "2026-06-20T08:05:00.000Z",
    metadata: '{"author":"human"}',
    events: [
      { type: "user" },
      { type: "prompt" },
      { type: "assistant" },
      { type: "assistant_tool_use", tool: "Bash" },
      { type: "tool_result", tool: "Bash" },
      { type: "tool_error", tool: "Read" },
      { type: "session_failed" },
    ],
    tokens: [
      {
        model: "claude-opus",
        input: 100,
        output: 50,
        cacheRead: 10,
        cacheWrite: 5,
        cost: 1.25,
      },
      {
        model: "claude-haiku",
        input: 200,
        output: 80,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.5,
      },
    ],
  },
  {
    // Agent session: one user turn (below threshold) and metadata "human"
    // markers below threshold → not human; no tokens; no end → null runtime.
    id: "sess-agent",
    status: "running",
    harness: "codex",
    startedAt: "2026-06-19T10:00:00.000Z",
    endedAt: null,
    metadata: '{"role":"human"}',
    events: [
      { type: "user" },
      { type: "assistant" },
      { type: "assistant", tool: "Grep" },
    ],
  },
  {
    // No events, no tokens, no metadata markers → all zeros; tokens still 0.
    id: "sess-empty",
    status: "abandoned",
    harness: "opencode",
    startedAt: "2026-06-18T00:00:00.000Z",
    endedAt: "2026-06-18T00:00:00.000Z",
    metadata: null,
    events: [],
  },
  {
    // Metadata-classified human (>= 2 "human" markers, zero user turns) →
    // is_human via the metadata fallback branch.
    id: "sess-meta-human",
    status: "completed",
    harness: "claude_code",
    startedAt: "2026-06-17T09:00:00.000Z",
    endedAt: "2026-06-17T09:30:00.000Z",
    metadata: '{"a":"human","b":"human","c":"human"}',
    events: [
      { type: "assistant" },
      { type: "assistant_tool_use", tool: "Edit" },
    ],
  },
];

async function seedSessions(db: SqliteDb): Promise<void> {
  let eventCounter = 0;
  for (const session of SESSIONS) {
    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, ended_at, updated_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      session.id,
      session.status,
      session.harness,
      session.startedAt,
      session.endedAt,
      NOW,
      session.metadata
    );
    for (const event of session.events) {
      eventCounter += 1;
      await db.run(
        `INSERT INTO events (id, session_id, event_type, tool_name, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        `evt-${eventCounter}`,
        session.id,
        event.type,
        event.tool ?? null,
        session.startedAt ?? NOW
      );
    }
    for (const token of session.tokens ?? []) {
      await db.run(
        `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd_estimated)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        session.id,
        token.model,
        token.input,
        token.output,
        token.cacheRead,
        token.cacheWrite,
        token.cost
      );
    }
  }
}

async function readRollups(db: SqliteDb): Promise<{
  rollups: Record<string, Record<string, unknown>>;
  updatedAtTypes: Record<string, string>;
}> {
  const analytics = await db.prisma.client.$queryRawUnsafe<
    Record<string, unknown>[]
  >("SELECT * FROM session_analytics ORDER BY session_id");
  const tools = await db.prisma.client.$queryRawUnsafe<
    Record<string, unknown>[]
  >("SELECT * FROM session_tool_analytics ORDER BY session_id, tool_name");
  const rollups: Record<string, Record<string, unknown>> = {};
  const updatedAtTypes: Record<string, string> = {};
  for (const row of analytics) {
    // `updated_at` is stamped with each path's own wall-clock `now` (the boot
    // backfill uses its internal `new Date()`), so it is intentionally dropped
    // from the behavior-preservation comparison; the test asserts on
    // `updatedAtTypes` that it is a present string.
    const { updated_at, ...rest } = row;
    updatedAtTypes[`analytics:${String(row.session_id)}`] = typeof updated_at;
    rollups[`analytics:${String(row.session_id)}`] = rest;
  }
  for (const row of tools) {
    rollups[`tool:${String(row.session_id)}:${String(row.tool_name)}`] = row;
  }
  return { rollups, updatedAtTypes };
}

test("batched backfill produces identical rollups to the per-session path", async () => {
  const { db, dir } = await openTempDb();
  try {
    // The boot-time backfill is fire-and-forget; wipe any rows it may have
    // written so we control the comparison from a clean slate.
    await db.run("DELETE FROM session_analytics");
    await db.run("DELETE FROM session_tool_analytics");

    await seedSessions(db);

    // Golden: run the per-session path for every session, capture the rollups.
    await db.prisma.write((client) =>
      client.$transaction(async (tx) => {
        for (const session of SESSIONS) {
          await upsertSessionAnalyticsRollup(tx, session.id, NOW);
        }
      })
    );
    const golden = await readRollups(db);

    // Sanity: every seeded session got a rollup, and classifications hold.
    assert.equal(
      Object.keys(golden.rollups).filter((k) => k.startsWith("analytics:"))
        .length,
      SESSIONS.length
    );
    assert.equal(golden.rollups["analytics:sess-human"]?.is_human, 1);
    assert.equal(golden.rollups["analytics:sess-human"]?.human_turns, 2);
    assert.equal(golden.rollups["analytics:sess-human"]?.event_count, 7);
    assert.equal(golden.rollups["analytics:sess-human"]?.tool_invocations, 3);
    assert.equal(golden.rollups["analytics:sess-human"]?.error_events, 2);
    assert.equal(golden.rollups["analytics:sess-human"]?.input_tokens, 300);
    assert.equal(golden.rollups["analytics:sess-human"]?.output_tokens, 130);
    assert.equal(golden.rollups["analytics:sess-human"]?.est_cost, 1.75);
    assert.equal(golden.rollups["analytics:sess-human"]?.runtime_ms, 300_000);
    assert.equal(golden.rollups["analytics:sess-agent"]?.is_human, 0);
    assert.equal(golden.rollups["analytics:sess-agent"]?.runtime_ms, null);
    assert.equal(golden.rollups["analytics:sess-empty"]?.event_count, 0);
    assert.equal(golden.rollups["analytics:sess-meta-human"]?.is_human, 1);
    assert.equal(golden.rollups["analytics:sess-meta-human"]?.human_turns, 0);
    assert.ok(golden.rollups["tool:sess-human:Bash"]);
    // `updated_at` is present (a string) on every per-session rollup.
    assert.equal(golden.updatedAtTypes["analytics:sess-human"], "string");

    // Now wipe the rollups so every session looks "missing", and run the
    // set-based boot backfill.
    await db.run("DELETE FROM session_analytics");
    await db.run("DELETE FROM session_tool_analytics");

    const logs: string[] = [];
    await backfillSessionAnalytics(db.prisma, (m) => logs.push(m));

    const batched = await readRollups(db);
    assert.deepEqual(batched.rollups, golden.rollups);
    // The batched path also stamps a present `updated_at` on every rollup.
    assert.deepEqual(batched.updatedAtTypes, golden.updatedAtTypes);
    assert.ok(
      logs.some((m) =>
        m.includes(
          `session-analytics backfill complete: ${SESSIONS.length}/${SESSIONS.length}`
        )
      ),
      `expected completion log, got: ${logs.join(" | ")}`
    );

    // Idempotent: a second run finds nothing missing and leaves rows untouched.
    await backfillSessionAnalytics(db.prisma, () => undefined);
    assert.deepEqual((await readRollups(db)).rollups, golden.rollups);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("backfill spans multiple chunks: every session rolled up across chunk boundaries", async () => {
  const { db, dir } = await openTempDb();
  try {
    await db.run("DELETE FROM session_analytics");
    await db.run("DELETE FROM session_tool_analytics");
    await seedSessions(db);
    await db.run("DELETE FROM session_analytics");
    await db.run("DELETE FROM session_tool_analytics");

    // chunkSize=2 with SESSIONS.length=4 forces ⌈4/2⌉ = 2 chunked transactions,
    // exercising the loop boundary the default 500-chunk path never hits in test.
    const logs: string[] = [];
    await backfillSessionAnalytics(db.prisma, (m) => logs.push(m), 2);

    const { rollups } = await readRollups(db);
    const analyticsKeys = Object.keys(rollups).filter((k) =>
      k.startsWith("analytics:")
    );
    // Every seeded session gets exactly one rollup, regardless of which chunk it
    // landed in.
    assert.equal(analyticsKeys.length, SESSIONS.length);
    for (const session of SESSIONS) {
      assert.ok(
        rollups[`analytics:${session.id}`],
        `missing rollup for ${session.id}`
      );
    }
    // The completion log counts every session across all successful chunks.
    assert.ok(
      logs.some((m) =>
        m.includes(
          `session-analytics backfill complete: ${SESSIONS.length}/${SESSIONS.length}`
        )
      ),
      `expected completion log, got: ${logs.join(" | ")}`
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
