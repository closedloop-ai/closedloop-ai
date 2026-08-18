import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  backfillSessionAnalytics,
  recomputeHeadlessSessionAnalytics,
  recomputeHeadlessTurnBuckets,
  recomputeImportedAgentTurnAnalytics,
} from "../src/main/database/session-analytics-maintenance.js";
import { upsertSessionAnalyticsRollup } from "../src/main/database/session-analytics-rollup.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { ROLLUP_OPTS } from "./rollup-options-test-utils.js";

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
    // Valid JSON metadata WITHOUT a $.messages key, zero user/prompt events →
    // transcript_human_turns is NULL ($.messages path absent), hook fallback is
    // 0, so human_turns=0 and is_human=0 (FEA-2641: substring fallback deleted).
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
    /* `updated_at` is stamped with each path's own wall-clock `now` (the boot
       backfill uses its internal `new Date()`), so it is intentionally dropped
       from the behavior-preservation comparison; the test asserts on
       `updatedAtTypes` that it is a present string. */
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
    /* The boot-time backfill is fire-and-forget; wipe any rows it may have
       written so we control the comparison from a clean slate. */
    await db.run("DELETE FROM session_analytics");
    await db.run("DELETE FROM session_tool_analytics");

    await seedSessions(db);

    // Golden: run the per-session path for every session, capture the rollups.
    await db.prisma.write((client) =>
      client.$transaction(async (tx) => {
        for (const session of SESSIONS) {
          await upsertSessionAnalyticsRollup(tx, session.id, NOW, ROLLUP_OPTS);
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
    assert.equal(golden.rollups["analytics:sess-meta-human"]?.is_human, 0);
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

    /* SYNC NOTE (FEA-3485): the unbounded backfill deliberately does NOT bump
       `sessions.updated_at` (a whole-corpus single-`now` bump would collapse
       every session onto one sync-cursor watermark). The seed `updated_at = NOW`
       is therefore preserved untouched. */
    const backfilledWatermarks = await db.prisma.client.$queryRawUnsafe<
      { id: string; updated_at: string }[]
    >("SELECT id, updated_at FROM sessions");
    assert.equal(backfilledWatermarks.length, SESSIONS.length);
    for (const row of backfilledWatermarks) {
      assert.equal(
        row.updated_at,
        NOW,
        `expected ${row.id} watermark to be untouched, got ${row.updated_at}`
      );
    }

    // Idempotent: a second run finds nothing missing and leaves rows untouched.
    await backfillSessionAnalytics(db.prisma, () => undefined);
    assert.deepEqual((await readRollups(db)).rollups, golden.rollups);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FEA-2641: genuine-human-turn classification tests
// Transcript path ($.messages JSON) takes priority over hook event count.
// ---------------------------------------------------------------------------

test("FEA-2641: valid $.messages with 3 role:human entries → transcript path, human_turns=3, is_human=1", async () => {
  const { db, dir } = await openTempDb();
  try {
    const sid = "fea2641-transcript-3human";
    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, ended_at, updated_at, metadata)
       VALUES ($1, 'completed', 'claude_code', '2026-06-20T08:00:00.000Z', '2026-06-20T08:05:00.000Z', $2, $3)`,
      sid,
      NOW,
      JSON.stringify({
        messages: [
          { role: "human", timestamp: "2026-06-20T08:00:01.000Z", text: "a" },
          {
            role: "assistant",
            timestamp: "2026-06-20T08:00:02.000Z",
            text: "b",
          },
          { role: "human", timestamp: "2026-06-20T08:00:03.000Z", text: "c" },
          { role: "human", timestamp: "2026-06-20T08:00:04.000Z", text: "d" },
        ],
      })
    );
    // No user/prompt events — human count must come from transcript exclusively.
    await db.run(
      `INSERT INTO events (id, session_id, event_type, tool_name, created_at)
       VALUES ('fea2641-t1-evt1', $1, 'assistant', NULL, '2026-06-20T08:00:02.000Z')`,
      sid
    );

    await db.prisma.write((client) =>
      client.$transaction(async (tx) => {
        await upsertSessionAnalyticsRollup(tx, sid, NOW, ROLLUP_OPTS);
      })
    );

    const [row] = await db.prisma.client.$queryRawUnsafe<
      { human_turns: number; is_human: number }[]
    >(
      "SELECT human_turns, is_human FROM session_analytics WHERE session_id = $1",
      sid
    );
    assert.equal(row.human_turns, 3, "transcript path: 3 role:human messages");
    assert.equal(row.is_human, 1, "3 >= 2 threshold → is_human");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2641: $.messages with 0 human entries overrides 5 hook events → transcript-wins-at-zero, human_turns=0, is_human=0", async () => {
  const { db, dir } = await openTempDb();
  try {
    const sid = "fea2641-transcript-zero-wins";
    // $.messages exists but contains no role:"human" entries; some assistant text
    // contains the word "human" to prove the old substring hack is gone.
    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, ended_at, updated_at, metadata)
       VALUES ($1, 'completed', 'claude_code', '2026-06-20T09:00:00.000Z', '2026-06-20T09:05:00.000Z', $2, $3)`,
      sid,
      NOW,
      JSON.stringify({
        messages: [
          {
            role: "assistant",
            timestamp: "2026-06-20T09:00:01.000Z",
            text: "the human asked something",
          },
          {
            role: "assistant",
            timestamp: "2026-06-20T09:00:02.000Z",
            text: "another human-related response",
          },
        ],
      })
    );
    // 5 user/prompt events — these must NOT contribute when transcript says 0.
    for (let i = 1; i <= 5; i++) {
      await db.run(
        `INSERT INTO events (id, session_id, event_type, tool_name, created_at)
         VALUES ($1, $2, $3, NULL, '2026-06-20T09:00:00.000Z')`,
        `fea2641-t2-evt${i}`,
        sid,
        i <= 3 ? "user" : "prompt"
      );
    }

    await db.prisma.write((client) =>
      client.$transaction(async (tx) => {
        await upsertSessionAnalyticsRollup(tx, sid, NOW, ROLLUP_OPTS);
      })
    );

    const [row] = await db.prisma.client.$queryRawUnsafe<
      { human_turns: number; is_human: number }[]
    >(
      "SELECT human_turns, is_human FROM session_analytics WHERE session_id = $1",
      sid
    );
    assert.equal(
      row.human_turns,
      0,
      "transcript returns 0 → overrides hook count 5"
    );
    assert.equal(row.is_human, 0, "0 < 2 threshold → not human");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2641: NULL metadata with 2 user/prompt events → hook fallback, human_turns=2, is_human=1", async () => {
  const { db, dir } = await openTempDb();
  try {
    const sid = "fea2641-null-meta-hook";
    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, ended_at, updated_at, metadata)
       VALUES ($1, 'completed', 'claude_code', '2026-06-20T10:00:00.000Z', '2026-06-20T10:05:00.000Z', $2, NULL)`,
      sid,
      NOW
    );
    // NULL metadata → transcript_human_turns is NULL → hook fallback applies.
    await db.run(
      `INSERT INTO events (id, session_id, event_type, tool_name, created_at)
       VALUES ('fea2641-t3-evt1', $1, 'user', NULL, '2026-06-20T10:00:01.000Z'),
              ('fea2641-t3-evt2', $1, 'prompt', NULL, '2026-06-20T10:00:02.000Z')`,
      sid
    );

    await db.prisma.write((client) =>
      client.$transaction(async (tx) => {
        await upsertSessionAnalyticsRollup(tx, sid, NOW, ROLLUP_OPTS);
      })
    );

    const [row] = await db.prisma.client.$queryRawUnsafe<
      { human_turns: number; is_human: number }[]
    >(
      "SELECT human_turns, is_human FROM session_analytics WHERE session_id = $1",
      sid
    );
    assert.equal(row.human_turns, 2, "NULL metadata → hook fallback = 2");
    assert.equal(row.is_human, 1, "2 >= 2 threshold → is_human");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2641: valid JSON without $.messages key and 3 user/prompt events → hook fallback, human_turns=3, is_human=1", async () => {
  const { db, dir } = await openTempDb();
  try {
    const sid = "fea2641-no-messages-key-hook";
    // Valid JSON but no $.messages key → transcript_human_turns NULL → hook applies.
    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, ended_at, updated_at, metadata)
       VALUES ($1, 'completed', 'codex', '2026-06-20T11:00:00.000Z', '2026-06-20T11:05:00.000Z', $2, $3)`,
      sid,
      NOW,
      '{"harness":"codex"}'
    );
    for (let i = 1; i <= 3; i++) {
      await db.run(
        `INSERT INTO events (id, session_id, event_type, tool_name, created_at)
         VALUES ($1, $2, $3, NULL, '2026-06-20T11:00:00.000Z')`,
        `fea2641-t4-evt${i}`,
        sid,
        i <= 2 ? "user" : "prompt"
      );
    }

    await db.prisma.write((client) =>
      client.$transaction(async (tx) => {
        await upsertSessionAnalyticsRollup(tx, sid, NOW, ROLLUP_OPTS);
      })
    );

    const [row] = await db.prisma.client.$queryRawUnsafe<
      { human_turns: number; is_human: number }[]
    >(
      "SELECT human_turns, is_human FROM session_analytics WHERE session_id = $1",
      sid
    );
    assert.equal(
      row.human_turns,
      3,
      "no $.messages key → transcript NULL → hook fallback = 3"
    );
    assert.equal(row.is_human, 1, "3 >= 2 threshold → is_human");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2641: $.messages with primitive elements and non-human objects → only 2 human objects counted, human_turns=2, is_human=1", async () => {
  const { db, dir } = await openTempDb();
  try {
    const sid = "fea2641-mixed-messages";
    // Hostile element mix: json_each surfaces a JSON string element as
    // unquoted TEXT, so an UNGUARDED json_extract on it throws "malformed
    // JSON" and aborts the whole rollup chunk. The rollup gates json_extract
    // behind m.type = 'object', so bare strings/numbers/null must be skipped
    // — not crash — and only role:"human" OBJECTS count.
    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, ended_at, updated_at, metadata)
       VALUES ($1, 'completed', 'claude_code', '2026-06-20T12:00:00.000Z', '2026-06-20T12:05:00.000Z', $2, $3)`,
      sid,
      NOW,
      JSON.stringify({
        messages: [
          null,
          "just a bare string",
          42,
          { role: "assistant" },
          { role: "tool" },
          { role: "human" },
          { role: "human" },
        ],
      })
    );
    // No user/prompt events — only transcript path operates.

    await db.prisma.write((client) =>
      client.$transaction(async (tx) => {
        await upsertSessionAnalyticsRollup(tx, sid, NOW, ROLLUP_OPTS);
      })
    );

    const [row] = await db.prisma.client.$queryRawUnsafe<
      { human_turns: number; is_human: number }[]
    >(
      "SELECT human_turns, is_human FROM session_analytics WHERE session_id = $1",
      sid
    );
    assert.equal(
      row.human_turns,
      2,
      "primitive elements skipped by the m.type guard, non-human roles not counted; only 2 human objects counted"
    );
    assert.equal(row.is_human, 1, "2 >= 2 threshold → is_human");
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

test("FEA-3143 (D6): recomputeAnalyticsRollups byte-budgeted chunking matches per-session counts, incl. an over-budget session", async () => {
  const { db, dir } = await openTempDb();
  try {
    await db.run("DELETE FROM session_analytics");
    await db.run("DELETE FROM session_tool_analytics");
    await seedSessions(db);

    // A session whose metadata alone exceeds the 8 MiB per-chunk byte budget, so
    // the byte-budgeted chunker MUST split it into its own chunk (small sessions
    // above/below pack separately). Its $.messages carries genuine human turns so
    // the rollup counts something non-trivial for it.
    const bigId = "sess-over-budget";
    const padding = "x".repeat(9 * 1024 * 1024); // > SESSION_ANALYTICS_ROLLUP_METADATA_BUDGET_BYTES (8 MiB)
    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, ended_at, updated_at, metadata)
       VALUES ($1, 'completed', 'claude_code', '2026-06-16T08:00:00.000Z', '2026-06-16T08:10:00.000Z', $2, $3)`,
      bigId,
      NOW,
      JSON.stringify({
        pad: padding,
        messages: [
          { role: "human", timestamp: "2026-06-16T08:00:01.000Z", text: "a" },
          {
            role: "assistant",
            timestamp: "2026-06-16T08:00:02.000Z",
            text: "b",
          },
          { role: "human", timestamp: "2026-06-16T08:00:03.000Z", text: "c" },
        ],
      })
    );

    const allIds = [...SESSIONS.map((s) => s.id), bigId];

    // Golden: run the per-session path for every session, capture the rollups.
    await db.prisma.write((client) =>
      client.$transaction(async (tx) => {
        for (const id of allIds) {
          await upsertSessionAnalyticsRollup(tx, id, NOW, ROLLUP_OPTS);
        }
      })
    );
    const golden = await readRollups(db);
    // Sanity: the over-budget session was rolled up and its transcript turns counted.
    assert.equal(golden.rollups[`analytics:${bigId}`]?.human_turns, 2);
    assert.equal(golden.rollups[`analytics:${bigId}`]?.is_human, 1);

    // Wipe and re-derive via the byte-budgeted chunking path. The default 8 MiB
    // budget forces the 9 MiB session into its own chunk; the rest pack together.
    await db.run("DELETE FROM session_analytics");
    await db.run("DELETE FROM session_tool_analytics");
    await db.recomputeAnalyticsRollups(allIds);

    const batched = await readRollups(db);
    // Equivalence: byte-budgeted chunking yields exactly the golden per-session
    // rollups — the same counts regardless of how ids were grouped into chunks.
    assert.deepEqual(batched.rollups, golden.rollups);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2870: a headless session is marked is_human=0 even with human turns and markers", async () => {
  const { db, dir } = await openTempDb();
  try {
    await db.run("DELETE FROM session_analytics");
    await db.run("DELETE FROM session_tool_analytics");

    // A headless session (entrypoint sdk-ts) that ALSO has two user turns and
    // three "human" metadata markers — every non-headless signal points to human,
    // so this proves the headless override wins.
    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, ended_at, updated_at, metadata)
       VALUES ('sess-headless', 'completed', 'claude_code', $1, $2, $1, $3)`,
      "2026-06-20T08:00:00.000Z",
      "2026-06-20T08:05:00.000Z",
      '{"entrypoint":"sdk-ts","a":"human","b":"human","c":"human"}'
    );
    for (const [i, type] of ["user", "prompt", "assistant"].entries()) {
      await db.run(
        `INSERT INTO events (id, session_id, event_type, created_at)
         VALUES ($1, 'sess-headless', $2, $3)`,
        `h-evt-${i}`,
        type,
        "2026-06-20T08:00:00.000Z"
      );
    }

    await db.prisma.write((client) =>
      client.$transaction((tx) =>
        upsertSessionAnalyticsRollup(tx, "sess-headless", NOW, ROLLUP_OPTS)
      )
    );

    const rows = await db.prisma.client.$queryRawUnsafe<
      { human_turns: number; is_human: number }[]
    >(
      "SELECT human_turns, is_human FROM session_analytics WHERE session_id = 'sess-headless'"
    );
    // human_turns is still counted (2), but is_human is forced to 0 by the
    // headless override.
    assert.equal(Number(rows[0]?.human_turns), 2);
    assert.equal(Number(rows[0]?.is_human), 0);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2870: recomputeHeadlessSessionAnalytics flips mis-marked headless rows and is idempotent", async () => {
  const { db, dir } = await openTempDb();
  try {
    await db.run("DELETE FROM session_analytics");
    await db.run("DELETE FROM session_tool_analytics");

    // A pre-fix headless session (permissionMode bypassPermissions) whose stored
    // rollup still says is_human=1, plus a genuine human session that must be
    // left untouched.
    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, updated_at, metadata)
       VALUES ('sess-headless-old', 'completed', 'claude_code', $1, $1, $2)`,
      "2026-06-20T08:00:00.000Z",
      '{"permissionMode":"bypassPermissions"}'
    );
    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, updated_at, metadata)
       VALUES ('sess-real-human', 'completed', 'claude_code', $1, $1, $2)`,
      "2026-06-20T09:00:00.000Z",
      '{"author":"human"}'
    );
    for (const [i, id] of ["sess-headless-old", "sess-real-human"].entries()) {
      for (const type of ["user", "prompt"]) {
        await db.run(
          `INSERT INTO events (id, session_id, event_type, created_at)
           VALUES ($1, $2, $3, $4)`,
          `r-evt-${i}-${type}`,
          id,
          type,
          "2026-06-20T08:00:00.000Z"
        );
      }
    }
    // Simulate the stale pre-fix rollup: both marked human.
    for (const id of ["sess-headless-old", "sess-real-human"]) {
      await db.run(
        `INSERT INTO session_analytics (session_id, started_at, human_turns, is_human)
         VALUES ($1, '2026-06-20T08:00:00.000Z', 2, 1)`,
        id
      );
    }

    const logs: string[] = [];
    await recomputeHeadlessSessionAnalytics(db.prisma, (m) => logs.push(m));

    const byId = new Map(
      (
        await db.prisma.client.$queryRawUnsafe<
          { session_id: string; is_human: number }[]
        >("SELECT session_id, is_human FROM session_analytics")
      ).map((r) => [r.session_id, Number(r.is_human)])
    );
    // The headless row flipped to 0; the real human row is untouched.
    assert.equal(byId.get("sess-headless-old"), 0);
    assert.equal(byId.get("sess-real-human"), 1);
    assert.ok(
      logs.some((m) =>
        m.includes("headless session-analytics recompute complete")
      )
    );

    // SYNC INVARIANT (FEA-3485): the heal advances the healed session's sync
    // watermark (`sessions.updated_at` drives listUpdatedSessionCursorRows) so an
    // install that already uploaded the mis-marked `is_human` re-syncs the flip;
    // the untouched human session keeps its cursor position.
    const readWatermarks = async () =>
      new Map(
        (
          await db.prisma.client.$queryRawUnsafe<
            { id: string; updated_at: string }[]
          >("SELECT id, updated_at FROM sessions")
        ).map((r) => [r.id, r.updated_at])
      );
    const watermarks = await readWatermarks();
    assert.ok(
      (watermarks.get("sess-headless-old") ?? "") > "2026-06-20T08:00:00.000Z",
      `expected healed session watermark to advance, got ${watermarks.get("sess-headless-old")}`
    );
    assert.equal(watermarks.get("sess-real-human"), "2026-06-20T09:00:00.000Z");

    // Idempotent: nothing left mis-marked, so a second pass is a no-op (no log)
    // and the watermark is not re-bumped.
    const logs2: string[] = [];
    await recomputeHeadlessSessionAnalytics(db.prisma, (m) => logs2.push(m));
    assert.equal(logs2.length, 0);
    const watermarksAfter = await readWatermarks();
    assert.equal(
      watermarksAfter.get("sess-headless-old"),
      watermarks.get("sess-headless-old")
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3266: recomputeHeadlessTurnBuckets re-derives stale 'human' buckets for a below-threshold headless session the is_human heal skips", async () => {
  const { db, dir } = await openTempDb();
  try {
    // Quiesce the boot chain BEFORE seeding: it also runs
    // recomputeHeadlessTurnBuckets, and if its pass lands after the seeds it
    // heals them first — the direct call below then finds nothing and never
    // emits the "complete" log this test asserts on. The race phase shifts
    // with any awaited boot-path change (surfaced by FEA-3591's floor heal).
    await db.whenBootMaintenanceSettled();
    await db.run("DELETE FROM session_turn_bucket");

    const TS = "2026-06-20T08:00:00.000Z";
    // A newly-headless session (entrypoint carries an `exec` token) with a SINGLE
    // human turn — so it stays below SESSION_ANALYTICS_HUMAN_TURN_THRESHOLD (2)
    // and is_human=0, which means recomputeHeadlessSessionAnalytics (WHERE
    // is_human=1) NEVER selects it and so never rebuilds its buckets. Before the
    // classifier broadened it was NOT headless, so its persisted per-turn bucket
    // classified that lone turn as 'human'.
    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, updated_at, metadata)
       VALUES ('sess-exec', 'completed', 'claude_code', $1, $1, $2)`,
      TS,
      // FEA-3597: seeded WITH a tokenSeries so this case still exercises both
      // halves. Agent rows now come from the parent-attributed token series, so
      // a headless session with no tokenSeries would derive to `[]` and the
      // assertion below would degenerate into a vacuous empty-array check,
      // silently dropping the FEA-3266 regression coverage.
      `{"entrypoint":"claude-codex-exec","messages":[{"role":"human","timestamp":"${TS}"}],"tokenSeries":[{"timestamp":"${TS}","model":"m","input":1,"output":1}]}`
    );
    // A genuine interactive human session (no headless signal) that ALSO has a
    // human bucket — it must be left untouched.
    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, updated_at, metadata)
       VALUES ('sess-human', 'completed', 'claude_code', $1, $1, $2)`,
      TS,
      `{"messages":[{"role":"human","timestamp":"${TS}"}]}`
    );
    // Seed the STALE pre-broadening buckets: both sessions have a 'human' bucket.
    for (const id of ["sess-exec", "sess-human"]) {
      await db.run(
        `INSERT INTO session_turn_bucket (session_id, ts, turn_kind, turn_count)
         VALUES ($1, $2, 'human', 1)`,
        id,
        TS
      );
    }

    const logs: string[] = [];
    await recomputeHeadlessTurnBuckets(db.prisma, (m) => logs.push(m));

    const buckets = async (id: string) =>
      await db.prisma.client.$queryRawUnsafe<
        { turn_kind: string; turn_count: number }[]
      >(
        "SELECT turn_kind, turn_count FROM session_turn_bucket WHERE session_id = $1",
        id
      );
    // FEA-3266 intent, re-expressed for FEA-3597: the stale 'human' bucket is
    // GONE (it would misreport a headless turn as human-steered on the Insights
    // autonomy trend + activity heatmap). What changed is HOW it goes — the pass
    // used to CONVERT that row to 'agent'; agent rows now come from the
    // parent-attributed $.tokenSeries instead, so the human row is DELETED and
    // the agent row is derived from the token series this session seeds.
    assert.deepEqual(await buckets("sess-exec"), [
      { turn_kind: "agent", turn_count: 1 },
    ]);
    // The genuine human session is not headless, so it is never selected.
    assert.deepEqual(await buckets("sess-human"), [
      { turn_kind: "human", turn_count: 1 },
    ]);
    assert.ok(
      logs.some((m) => m.includes("headless turn-bucket recompute complete"))
    );

    // Convergent: sess-exec no longer has a 'human' bucket, so a second pass
    // selects nothing and logs nothing.
    const logs2: string[] = [];
    await recomputeHeadlessTurnBuckets(db.prisma, (m) => logs2.push(m));
    assert.equal(logs2.length, 0);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3485: a multi-chunk headless heal staggers updated_at per chunk (bounded sync-cursor top group)", async () => {
  const { db, dir } = await openTempDb();
  try {
    await db.run("DELETE FROM session_analytics");
    await db.run("DELETE FROM session_tool_analytics");

    // Six mis-marked headless sessions. Run with chunkSize=1 so each session is
    // its OWN chunk — the worst case for the cursor-group blow-up this guards.
    const staleIds = Array.from({ length: 6 }, (_, i) => `sess-headless-${i}`);
    for (const id of staleIds) {
      await db.run(
        `INSERT INTO sessions (id, status, harness, started_at, updated_at, metadata)
         VALUES ($1, 'completed', 'claude_code', $2, $2, $3)`,
        id,
        "2026-06-20T08:00:00.000Z",
        '{"permissionMode":"bypassPermissions"}'
      );
      for (const type of ["user", "prompt"]) {
        await db.run(
          `INSERT INTO events (id, session_id, event_type, created_at)
           VALUES ($1, $2, $3, $4)`,
          `mc-evt-${id}-${type}`,
          id,
          type,
          "2026-06-20T08:00:00.000Z"
        );
      }
      await db.run(
        `INSERT INTO session_analytics (session_id, started_at, human_turns, is_human)
         VALUES ($1, '2026-06-20T08:00:00.000Z', 2, 1)`,
        id
      );
    }

    await recomputeHeadlessSessionAnalytics(db.prisma, () => undefined, 1);

    const watermarks = (
      await db.prisma.client.$queryRawUnsafe<
        { id: string; updated_at: string }[]
      >("SELECT id, updated_at FROM sessions WHERE id LIKE 'sess-headless-%'")
    ).map((r) => r.updated_at);

    // Every healed session advanced past the seed watermark.
    for (const w of watermarks) {
      assert.ok(
        w > "2026-06-20T08:00:00.000Z",
        `expected healed watermark to advance, got ${w}`
      );
    }
    // CURSOR-GROUP BOUND: the six chunks land on DISTINCT updated_at values, so
    // the sync cursor's top-timestamp group (observedIdsAtTopUpdatedAt) is one
    // chunk (here a single session), never the whole O(stale-corpus) set. A
    // regression to one shared `now` would collapse these to a single value.
    const distinct = new Set(watermarks);
    assert.equal(
      distinct.size,
      staleIds.length,
      `expected ${staleIds.length} distinct per-chunk watermarks, got ${distinct.size}: ${[...distinct].join(", ")}`
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FEA-3226: transcript-first agent-turn counting
// The importer's top-level $.assistantMessages count takes priority over the
// event-name heuristic; the visible $.messages rows are NEVER counted.
// ---------------------------------------------------------------------------

test("FEA-3226: $.assistantMessages=7 with only importer event types → transcript path, agent_turns=7", async () => {
  const { db, dir } = await openTempDb();
  try {
    const sid = "fea3226-transcript-7";
    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, ended_at, updated_at, metadata)
       VALUES ($1, 'completed', 'claude_code', '2026-06-20T08:00:00.000Z', '2026-06-20T08:05:00.000Z', $2, $3)`,
      sid,
      NOW,
      '{"assistantMessages":7,"userMessages":3}'
    );
    // Only importer-written event types — none contain "assistant", so the
    // pre-fix heuristic scored 0 here. The count must come from metadata.
    for (const [i, type] of [
      "Stop",
      "PreToolUse",
      "PostToolUse",
      "TurnDuration",
    ].entries()) {
      await db.run(
        `INSERT INTO events (id, session_id, event_type, created_at)
         VALUES ($1, $2, $3, '2026-06-20T08:00:01.000Z')`,
        `fea3226-t1-evt${i}`,
        sid,
        type
      );
    }

    await db.prisma.write((client) =>
      client.$transaction((tx) =>
        upsertSessionAnalyticsRollup(tx, sid, NOW, ROLLUP_OPTS)
      )
    );

    const [row] = await db.prisma.client.$queryRawUnsafe<
      { agent_turns: number }[]
    >("SELECT agent_turns FROM session_analytics WHERE session_id = $1", sid);
    assert.equal(
      Number(row.agent_turns),
      7,
      "transcript path: $.assistantMessages wins over the 0-scoring heuristic"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3226: $.assistantMessages=0 overrides 3 assistant-named events → transcript-wins-at-zero, agent_turns=0", async () => {
  const { db, dir } = await openTempDb();
  try {
    const sid = "fea3226-zero-wins";
    // A present count wins even at 0 (e.g. a cancelled Codex session whose
    // parser reports no billable round-trips, FEA-3125) — the heuristic must
    // NOT resurrect a phantom count from event names.
    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, ended_at, updated_at, metadata)
       VALUES ($1, 'completed', 'codex', '2026-06-20T09:00:00.000Z', '2026-06-20T09:05:00.000Z', $2, $3)`,
      sid,
      NOW,
      '{"assistantMessages":0}'
    );
    for (let i = 1; i <= 3; i++) {
      await db.run(
        `INSERT INTO events (id, session_id, event_type, created_at)
         VALUES ($1, $2, 'assistant', '2026-06-20T09:00:01.000Z')`,
        `fea3226-t2-evt${i}`,
        sid
      );
    }

    await db.prisma.write((client) =>
      client.$transaction((tx) =>
        upsertSessionAnalyticsRollup(tx, sid, NOW, ROLLUP_OPTS)
      )
    );

    const [row] = await db.prisma.client.$queryRawUnsafe<
      { agent_turns: number }[]
    >("SELECT agent_turns FROM session_analytics WHERE session_id = $1", sid);
    assert.equal(
      Number(row.agent_turns),
      0,
      "transcript returns 0 → overrides heuristic count 3"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3226: no $.assistantMessages key → heuristic fallback counts events, NEVER the visible $.messages rows", async () => {
  const { db, dir } = await openTempDb();
  try {
    const sid = "fea3226-hook-fallback";
    // Hook-only-shaped metadata: no $.assistantMessages, but a $.messages
    // array with FOUR assistant-role rows. Visible rows split one billable
    // turn across text/tool_use blocks, so counting them would overcount —
    // the fallback must be the event-name heuristic (2), never the rows (4).
    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, ended_at, updated_at, metadata)
       VALUES ($1, 'completed', 'claude_code', '2026-06-20T10:00:00.000Z', '2026-06-20T10:05:00.000Z', $2, $3)`,
      sid,
      NOW,
      JSON.stringify({
        messages: [
          { role: "assistant", text: "a" },
          { role: "assistant", text: "b" },
          { role: "assistant", text: "c" },
          { role: "assistant", text: "d" },
        ],
      })
    );
    for (let i = 1; i <= 2; i++) {
      await db.run(
        `INSERT INTO events (id, session_id, event_type, created_at)
         VALUES ($1, $2, 'assistant', '2026-06-20T10:00:01.000Z')`,
        `fea3226-t3-evt${i}`,
        sid
      );
    }

    await db.prisma.write((client) =>
      client.$transaction((tx) =>
        upsertSessionAnalyticsRollup(tx, sid, NOW, ROLLUP_OPTS)
      )
    );

    const [row] = await db.prisma.client.$queryRawUnsafe<
      { agent_turns: number }[]
    >("SELECT agent_turns FROM session_analytics WHERE session_id = $1", sid);
    assert.equal(
      Number(row.agent_turns),
      2,
      "no $.assistantMessages → event heuristic (2), never the 4 visible assistant rows"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3226: recomputeImportedAgentTurnAnalytics heals frozen zeros, skips agreeing and hook-only rows, converges", async () => {
  const { db, dir } = await openTempDb();
  try {
    await db.run("DELETE FROM session_analytics");
    await db.run("DELETE FROM session_tool_analytics");

    // A pre-fix imported session whose rollup froze agent_turns=0, an
    // already-agreeing session, and a hook-only session (no metadata blob)
    // whose heuristic-derived count must not be touched.
    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, updated_at, metadata)
       VALUES ('sess-agt-stale', 'completed', 'claude_code', $1, $1, $2)`,
      "2026-06-20T08:00:00.000Z",
      '{"assistantMessages":5}'
    );
    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, updated_at, metadata)
       VALUES ('sess-agt-ok', 'completed', 'claude_code', $1, $1, $2)`,
      "2026-06-20T09:00:00.000Z",
      '{"assistantMessages":3}'
    );
    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, updated_at, metadata)
       VALUES ('sess-agt-hookonly', 'completed', 'claude_code', $1, $1, NULL)`,
      "2026-06-20T10:00:00.000Z"
    );
    const SENTINEL = "2026-06-20T11:00:00.000Z";
    for (const [id, agentTurns] of [
      ["sess-agt-stale", 0],
      ["sess-agt-ok", 3],
      ["sess-agt-hookonly", 2],
    ] as const) {
      await db.run(
        `INSERT INTO session_analytics (session_id, started_at, agent_turns, updated_at)
         VALUES ($1, '2026-06-20T08:00:00.000Z', $2, $3)`,
        id,
        agentTurns,
        SENTINEL
      );
    }

    const logs: string[] = [];
    await recomputeImportedAgentTurnAnalytics(db.prisma, (m) => logs.push(m));

    const rows = await db.prisma.client.$queryRawUnsafe<
      { session_id: string; agent_turns: number; updated_at: string }[]
    >("SELECT session_id, agent_turns, updated_at FROM session_analytics");
    const byId = new Map(rows.map((r) => [r.session_id, r]));
    // The frozen zero healed to the metadata count...
    assert.equal(Number(byId.get("sess-agt-stale")?.agent_turns), 5);
    assert.notEqual(byId.get("sess-agt-stale")?.updated_at, SENTINEL);
    // ...while the agreeing and hook-only rows were not rewritten at all.
    assert.equal(Number(byId.get("sess-agt-ok")?.agent_turns), 3);
    assert.equal(byId.get("sess-agt-ok")?.updated_at, SENTINEL);
    assert.equal(Number(byId.get("sess-agt-hookonly")?.agent_turns), 2);
    assert.equal(byId.get("sess-agt-hookonly")?.updated_at, SENTINEL);
    assert.ok(
      logs.some((m) =>
        m.includes("imported agent-turn recompute complete (FEA-3226): 1/1")
      ),
      `expected completion log, got: ${logs.join(" | ")}`
    );

    // SYNC INVARIANT: the heal advances the healed session's sync watermark
    // (`sessions.updated_at` drives listUpdatedSessionCursorRows) so an
    // install that already uploaded the frozen zero re-syncs the corrected
    // count; untouched sessions keep their cursor position.
    const sessionRows = await db.prisma.client.$queryRawUnsafe<
      { id: string; updated_at: string }[]
    >("SELECT id, updated_at FROM sessions");
    const sessById = new Map(sessionRows.map((r) => [r.id, r.updated_at]));
    assert.ok(
      (sessById.get("sess-agt-stale") ?? "") > "2026-06-20T08:00:00.000Z",
      `expected healed session watermark to advance, got ${sessById.get("sess-agt-stale")}`
    );
    assert.equal(sessById.get("sess-agt-ok"), "2026-06-20T09:00:00.000Z");
    assert.equal(sessById.get("sess-agt-hookonly"), "2026-06-20T10:00:00.000Z");

    // Convergent: the healed row now agrees with metadata, so a second pass
    // selects nothing (no log) and the watermark is not re-bumped.
    const logs2: string[] = [];
    await recomputeImportedAgentTurnAnalytics(db.prisma, (m) => logs2.push(m));
    assert.equal(logs2.length, 0);
    const staleAfterFirstPass = sessById.get("sess-agt-stale");
    const rebumped = await db.prisma.client.$queryRawUnsafe<
      { updated_at: string }[]
    >("SELECT updated_at FROM sessions WHERE id = 'sess-agt-stale'");
    assert.equal(rebumped[0]?.updated_at, staleAfterFirstPass);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
