import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  backfillSessionAnalytics,
  recomputeHeadlessSessionAnalytics,
  upsertSessionAnalyticsRollup,
} from "../src/main/database/write-core.js";

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
        await upsertSessionAnalyticsRollup(tx, sid, NOW);
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
        await upsertSessionAnalyticsRollup(tx, sid, NOW);
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
        await upsertSessionAnalyticsRollup(tx, sid, NOW);
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
        await upsertSessionAnalyticsRollup(tx, sid, NOW);
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
        await upsertSessionAnalyticsRollup(tx, sid, NOW);
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
          await upsertSessionAnalyticsRollup(tx, id, NOW);
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
        upsertSessionAnalyticsRollup(tx, "sess-headless", NOW)
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

    // Idempotent: nothing left mis-marked, so a second pass is a no-op (no log).
    const logs2: string[] = [];
    await recomputeHeadlessSessionAnalytics(db.prisma, (m) => logs2.push(m));
    assert.equal(logs2.length, 0);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
