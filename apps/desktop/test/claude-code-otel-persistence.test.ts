import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DATA_REVISION } from "../src/main/collectors/engine/data-revision.js";
import { deterministicEventId } from "../src/main/database/deterministic-event-id.js";
import type { PrismaClient } from "../src/main/database/generated/client.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  type ClaudeCodeOtelPersistenceWarning,
  ClaudeCodeOtelSignalType,
  ClaudeCodeOtelTableName,
  ClaudeCodeOtelWarningSignalType,
  ClaudeCodePermissionDecision,
  ClaudeCodePermissionSource,
  persistClaudeCodeOtelSignals,
} from "../src/main/otel/claude-code-persistence.js";

const NOW = "2026-06-18T19:30:00.000Z";
const LATER = "2026-06-18T19:31:00.000Z";
const SESSION_ID = "claude-otel-session";
const MODEL = "claude-sonnet-4-5";
const LARGE_CACHE_READ_TOKENS = 2_192_635_647;

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;
type ClaudeCodeOtelSideTable = Exclude<
  (typeof ClaudeCodeOtelTableName)[keyof typeof ClaudeCodeOtelTableName],
  typeof ClaudeCodeOtelTableName.TokenUsage
>;

test("persists Claude Code OTel cost, permission, API request, and token usage signals", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db, SESSION_ID);
    const warnings: ClaudeCodeOtelPersistenceWarning[] = [];

    const summary = await persistClaudeCodeOtelSignals(
      {
        prisma: db.prisma,
        events: [
          makeCostUsage({ costUsd: 1.25 }),
          makePermissionDecision(),
          makeApiRequest({ inputTokens: 100, outputTokens: 30 }),
          makeTokenUsage({ inputTokens: 120, outputTokens: 40 }),
        ],
      },
      { now: () => NOW, warn: (warning) => warnings.push(warning) }
    );

    assert.deepEqual(summary, { accepted: 4, rejected: 0 });
    assert.deepEqual(warnings, []);

    const costRows = await selectRows(db, ClaudeCodeOtelTableName.CostEvent);
    assert.equal(costRows.length, 1);
    assert.equal(costRows[0].session_id, SESSION_ID);
    assert.equal(costRows[0].model, MODEL);
    assert.equal(Number(costRows[0].cost_usd), 1.25);
    assert.equal(costRows[0].observed_at, "2026-06-18T19:00:00.000Z");
    assert.equal(costRows[0].data_revision, DATA_REVISION);

    const permissionRows = await selectRows(
      db,
      ClaudeCodeOtelTableName.PermissionEvent
    );
    assert.equal(permissionRows.length, 1);
    assert.equal(permissionRows[0].tool_name, "Bash");
    assert.equal(
      permissionRows[0].decision,
      ClaudeCodePermissionDecision.Allow
    );
    assert.equal(permissionRows[0].source, ClaudeCodePermissionSource.Hook);
    assert.equal(permissionRows[0].data_revision, DATA_REVISION);

    const apiRows = await selectRows(db, ClaudeCodeOtelTableName.ApiRequest);
    assert.equal(apiRows.length, 1);
    assert.equal(Number(apiRows[0].tokens_input), 100);
    assert.equal(Number(apiRows[0].tokens_output), 30);
    assert.equal(Number(apiRows[0].tokens_cache_read), 5);
    assert.equal(Number(apiRows[0].tokens_cache_creation), 2);
    assert.equal(Number(apiRows[0].cost_usd), 1.75);
    assert.equal(apiRows[0].duration_ms, 2500);
    assert.equal(apiRows[0].data_revision, DATA_REVISION);

    assert.deepEqual(await db.tokenUsage.getBySession(SESSION_ID), [
      {
        sessionId: SESSION_ID,
        model: MODEL,
        inputTokens: 120,
        outputTokens: 40,
        cacheReadTokens: 6,
        cacheWriteTokens: 3,
        estimatedCostUsd: 0.000_973_049_999_999_999_9,
      },
    ]);
  } finally {
    await cleanup();
  }
});

test("replaying natural keys updates intended rows without duplicates", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db, SESSION_ID);
    await persistClaudeCodeOtelSignals(
      {
        prisma: db.prisma,
        events: [
          makeCostUsage({ costUsd: 1.25 }),
          makePermissionDecision({
            decision: ClaudeCodePermissionDecision.Allow,
          }),
          makeApiRequest({ inputTokens: 100, outputTokens: 30 }),
          makeTokenUsage({ inputTokens: 120, outputTokens: 40 }),
        ],
      },
      { now: () => NOW }
    );

    await persistClaudeCodeOtelSignals(
      {
        prisma: db.prisma,
        events: [
          makeCostUsage({ costUsd: 2.5 }),
          makePermissionDecision({
            decision: ClaudeCodePermissionDecision.Deny,
          }),
          makeApiRequest({ inputTokens: 222, outputTokens: 44 }),
          makeTokenUsage({ inputTokens: 333, outputTokens: 55 }),
        ],
      },
      { now: () => LATER }
    );

    const costRows = await selectRows(db, ClaudeCodeOtelTableName.CostEvent);
    assert.equal(costRows.length, 1);
    assert.equal(Number(costRows[0].cost_usd), 2.5);
    assert.equal(costRows[0].created_at, NOW);
    assert.equal(costRows[0].updated_at, LATER);

    const permissionRows = await selectRows(
      db,
      ClaudeCodeOtelTableName.PermissionEvent
    );
    assert.equal(permissionRows.length, 1);
    assert.equal(permissionRows[0].decision, ClaudeCodePermissionDecision.Deny);

    const apiRows = await selectRows(db, ClaudeCodeOtelTableName.ApiRequest);
    assert.equal(apiRows.length, 1);
    assert.equal(Number(apiRows[0].tokens_input), 222);
    assert.equal(Number(apiRows[0].tokens_output), 44);

    assert.deepEqual(await db.tokenUsage.getBySession(SESSION_ID), [
      {
        sessionId: SESSION_ID,
        model: MODEL,
        inputTokens: 333,
        outputTokens: 55,
        cacheReadTokens: 6,
        cacheWriteTokens: 3,
        estimatedCostUsd: 0.001_837_05,
      },
    ]);
  } finally {
    await cleanup();
  }
});

test("persists large Claude Code OTel token counters exactly", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db, SESSION_ID);

    const summary = await persistClaudeCodeOtelSignals(
      {
        prisma: db.prisma,
        events: [
          makeApiRequest({ cacheReadTokens: LARGE_CACHE_READ_TOKENS }),
          makeTokenUsage({ cacheReadTokens: LARGE_CACHE_READ_TOKENS }),
        ],
      },
      { now: () => NOW }
    );

    assert.deepEqual(summary, { accepted: 2, rejected: 0 });

    const apiRows = await selectRows(db, ClaudeCodeOtelTableName.ApiRequest);
    assert.equal(apiRows.length, 1);
    assert.equal(Number(apiRows[0].tokens_cache_read), LARGE_CACHE_READ_TOKENS);

    const usage = await db.tokenUsage.getBySession(SESSION_ID);
    assert.equal(usage.length, 1);
    assert.equal(usage[0].cacheReadTokens, LARGE_CACHE_READ_TOKENS);
  } finally {
    await cleanup();
  }
});

test("rejects unsafe Claude Code OTel token counters before writes", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db, SESSION_ID);
    const warnings: ClaudeCodeOtelPersistenceWarning[] = [];

    const summary = await persistClaudeCodeOtelSignals(
      {
        prisma: db.prisma,
        events: [
          makeTokenUsage({ cacheReadTokens: Number.MAX_SAFE_INTEGER + 1 }),
          makeApiRequest({ cacheReadTokens: 1.5 }),
        ],
      },
      { now: () => NOW, warn: (warning) => warnings.push(warning) }
    );

    assert.deepEqual(summary, { accepted: 0, rejected: 2 });
    assert.equal(await countRows(db, ClaudeCodeOtelTableName.ApiRequest), 0);
    assert.deepEqual(await db.tokenUsage.getBySession(SESSION_ID), []);
    assert.equal(warnings.length, 2);
  } finally {
    await cleanup();
  }
});

test("OTel token usage overwrites transcript rows, including all-zero totals, and dashboard aggregates see the final row", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db, SESSION_ID);
    await seedTokenUsage(db, {
      sessionId: SESSION_ID,
      model: MODEL,
      inputTokens: 900,
      outputTokens: 300,
      cacheReadTokens: 90,
      cacheWriteTokens: 30,
    });

    await persistClaudeCodeOtelSignals(
      {
        prisma: db.prisma,
        events: [
          makeTokenUsage({
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          }),
        ],
      },
      { now: () => NOW }
    );

    assert.deepEqual(await db.tokenUsage.getBySession(SESSION_ID), [
      {
        sessionId: SESSION_ID,
        model: MODEL,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0,
      },
    ]);

    // FEA-2345: getTokenAnalytics reads from token_events, not token_usage.
    // OTel writes to token_usage only — token_events has no rows for this
    // session, so the analytics payload is empty (the OTel transient gap).
    const analytics = await db.dashboard.getTokenAnalytics(new Date(NOW));
    assert.equal(analytics.totalInputTokens, 0);
    assert.equal(analytics.totalOutputTokens, 0);
    assert.equal(analytics.totalCacheReadTokens, 0);
    assert.equal(analytics.totalCacheWriteTokens, 0);
    assert.deepEqual(analytics.byModel, []);
  } finally {
    await cleanup();
  }
});

test("invalid events are rejected without writes and warnings exclude raw payload fields", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db, SESSION_ID);
    await seedTokenUsage(db, {
      sessionId: SESSION_ID,
      model: MODEL,
      inputTokens: 50,
      outputTokens: 10,
      cacheReadTokens: 5,
      cacheWriteTokens: 1,
    });
    const warnings: ClaudeCodeOtelPersistenceWarning[] = [];

    const summary = await persistClaudeCodeOtelSignals(
      {
        prisma: db.prisma,
        events: [
          makeTokenUsage({ inputTokens: 75, outputTokens: 15 }),
          makePermissionDecision({ source: "user_session" }),
          makePermissionDecision({ decision: "maybe" }),
          makeCostUsage({ observedAt: "not-a-date" }),
          makeApiRequest({ inputTokens: -1 }),
          makeApiRequest({ costUsd: Number.POSITIVE_INFINITY }),
          { type: ClaudeCodeOtelSignalType.TokenUsage, prompt: "secret body" },
        ],
      },
      { now: () => NOW, warn: (warning) => warnings.push(warning) }
    );

    assert.deepEqual(summary, { accepted: 1, rejected: 6 });
    assert.equal(
      await countRows(db, ClaudeCodeOtelTableName.PermissionEvent),
      0
    );
    assert.equal(await countRows(db, ClaudeCodeOtelTableName.CostEvent), 0);
    assert.equal(await countRows(db, ClaudeCodeOtelTableName.ApiRequest), 0);
    assert.deepEqual(await db.tokenUsage.getBySession(SESSION_ID), [
      {
        sessionId: SESSION_ID,
        model: MODEL,
        inputTokens: 75,
        outputTokens: 15,
        cacheReadTokens: 6,
        cacheWriteTokens: 3,
        estimatedCostUsd: 0.000_463_05,
      },
    ]);
    assert.equal(warnings.length, 6);
    assert.equal(JSON.stringify(warnings).includes("secret body"), false);
  } finally {
    await cleanup();
  }
});

test("Date.parse-parseable malformed timestamps are rejected before writes", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    await seedSession(db, SESSION_ID);
    const warnings: ClaudeCodeOtelPersistenceWarning[] = [];

    const summary = await persistClaudeCodeOtelSignals(
      {
        prisma: db.prisma,
        events: [
          makeCostUsage({ observedAt: "2026-02-31T00:00:00.000Z" }),
          makeApiRequest({ startedAt: "1" }),
          makeTokenUsage({ observedAt: "2026-06-18T19:00:03Z" }),
        ],
      },
      { now: () => NOW, warn: (warning) => warnings.push(warning) }
    );

    assert.deepEqual(summary, { accepted: 0, rejected: 3 });
    assert.equal(await countRows(db, ClaudeCodeOtelTableName.CostEvent), 0);
    assert.equal(await countRows(db, ClaudeCodeOtelTableName.ApiRequest), 0);
    assert.deepEqual(await db.tokenUsage.getBySession(SESSION_ID), []);
    assert.equal(warnings.length, 3);
  } finally {
    await cleanup();
  }
});

test("all-invalid batches do not enter the write queue", async () => {
  let writeCalls = 0;
  const prisma = {
    client: {},
    write: () => {
      writeCalls += 1;
      throw new Error("write should not be called");
    },
    disconnect: async () => undefined,
  } as DesktopPrisma;

  const summary = await persistClaudeCodeOtelSignals({
    prisma,
    events: [
      { type: "unknown_signal", sessionId: SESSION_ID },
      makeApiRequest({ durationMs: -1 }),
    ],
  });

  assert.deepEqual(summary, { accepted: 0, rejected: 2 });
  assert.equal(writeCalls, 0);
});

test("unknown signal warnings do not expose raw discriminators", async () => {
  let writeCalls = 0;
  const warnings: ClaudeCodeOtelPersistenceWarning[] = [];
  const rawDiscriminator = "secret prompt token should not be logged";
  const prisma = {
    client: {},
    write: () => {
      writeCalls += 1;
      throw new Error("write should not be called");
    },
    disconnect: async () => undefined,
  } as DesktopPrisma;

  const summary = await persistClaudeCodeOtelSignals(
    {
      prisma,
      events: [{ type: rawDiscriminator, sessionId: SESSION_ID }],
    },
    { warn: (warning) => warnings.push(warning) }
  );

  assert.deepEqual(summary, { accepted: 0, rejected: 1 });
  assert.equal(writeCalls, 0);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].signalType, ClaudeCodeOtelWarningSignalType.Unknown);
  assert.equal(JSON.stringify(warnings).includes(rawDiscriminator), false);
});

test("accepted database batches use one prisma.write transaction", async () => {
  let writeCalls = 0;
  let transactionCalls = 0;
  const prisma = {
    client: {},
    write: (callback) => {
      writeCalls += 1;
      const client = {
        claudeCodeCostEvent: {
          upsert: () => Promise.resolve({}),
        },
        tokenUsage: {
          upsert: () => Promise.resolve({}),
        },
        $transaction: (operations: unknown[]) => {
          transactionCalls += 1;
          assert.equal(operations.length, 2);
          return Promise.all(operations);
        },
      } as PrismaClient;
      return callback(client);
    },
    disconnect: async () => undefined,
  } as DesktopPrisma;

  const summary = await persistClaudeCodeOtelSignals(
    {
      prisma,
      events: [makeCostUsage({}), makeTokenUsage({})],
    },
    { now: () => NOW }
  );

  assert.deepEqual(summary, { accepted: 2, rejected: 0 });
  assert.equal(writeCalls, 1);
  assert.equal(transactionCalls, 1);
});

test("database transaction failure rolls back all accepted events", async () => {
  const { db, cleanup } = await openTestDatabase();
  try {
    // SQLite is dynamically typed, so the legacy PG trigger (a numeric overflow
    // on costUsd) no longer raises a DB error. Force an engine-agnostic
    // transaction failure instead: pre-seed an api_request row whose primary key
    // collides with the id the batch's api_request will generate, but with a
    // different natural key so the upsert misses on its WHERE and takes the
    // create path → primary-key violation → the whole batch must roll back.
    const collidingApiId = deterministicEventId(
      SESSION_ID,
      ClaudeCodeOtelTableName.ApiRequest,
      "2026-06-18T19:00:02.000Z",
      MODEL
    );
    await db.run(
      `INSERT INTO claude_code_api_request (
         id, session_id, model, tokens_input, tokens_output,
         tokens_cache_read, tokens_cache_creation, cost_usd, started_at,
         duration_ms, data_revision, created_at, updated_at
       )
       VALUES ($1, $2, $3, 0, 0, 0, 0, '0', $4, 0, $5, $6, $6)`,
      collidingApiId,
      SESSION_ID,
      "different-model",
      "2026-06-18T18:00:00.000Z",
      DATA_REVISION,
      NOW
    );

    await assert.rejects(
      persistClaudeCodeOtelSignals(
        {
          prisma: db.prisma,
          events: [
            makeCostUsage({ costUsd: 1.25 }),
            makeApiRequest({
              startedAt: "2026-06-18T19:00:02.000Z",
              costUsd: 1.75,
            }),
          ],
        },
        { now: () => NOW }
      )
    );

    // The cost event must not survive, and the only api_request row is the
    // pre-seeded one (the batch's insert rolled back).
    assert.equal(await countRows(db, ClaudeCodeOtelTableName.CostEvent), 0);
    assert.equal(await countRows(db, ClaudeCodeOtelTableName.ApiRequest), 1);
  } finally {
    await cleanup();
  }
});

async function openTestDatabase(): Promise<{
  db: SqliteDb;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "claude-code-otel-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
  return {
    db,
    cleanup: async () => {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function seedSession(db: SqliteDb, sessionId: string): Promise<void> {
  await db.run(
    `INSERT INTO sessions (id, status, started_at, updated_at, harness, billing_mode)
     VALUES ($1, 'completed', $2, $2, 'claude', 'metered_api')`,
    sessionId,
    "2026-06-18T18:00:00.000Z"
  );
}

async function seedTokenUsage(
  db: SqliteDb,
  token: {
    sessionId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }
): Promise<void> {
  await db.run(
    `INSERT INTO token_usage (
       session_id, model, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens, raw_input, raw_output,
       raw_cache_read, raw_cache_write, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $3, $4, $5, $6, $7, $7)`,
    token.sessionId,
    token.model,
    token.inputTokens,
    token.outputTokens,
    token.cacheReadTokens,
    token.cacheWriteTokens,
    NOW
  );
}

async function selectRows(
  db: SqliteDb,
  tableName: ClaudeCodeOtelSideTable
): Promise<Record<string, unknown>[]> {
  const result = await db.prisma.client.$queryRawUnsafe<
    Record<string, unknown>[]
  >(`SELECT * FROM ${tableName} ORDER BY id ASC`);
  return result;
}

async function countRows(
  db: SqliteDb,
  tableName: ClaudeCodeOtelSideTable
): Promise<number> {
  const result = await db.prisma.client.$queryRawUnsafe<{ count: number }[]>(
    `SELECT COUNT(*) as count FROM ${tableName}`
  );
  return Number(result[0]?.count ?? 0);
}

function makeCostUsage(overrides: Record<string, unknown>) {
  return {
    type: ClaudeCodeOtelSignalType.CostUsage,
    sessionId: SESSION_ID,
    model: MODEL,
    observedAt: "2026-06-18T19:00:00.000Z",
    costUsd: 1.25,
    ...overrides,
  };
}

function makePermissionDecision(overrides: Record<string, unknown> = {}) {
  return {
    type: ClaudeCodeOtelSignalType.PermissionDecision,
    sessionId: SESSION_ID,
    toolName: "Bash",
    observedAt: "2026-06-18T19:00:01.000Z",
    decision: ClaudeCodePermissionDecision.Allow,
    source: ClaudeCodePermissionSource.Hook,
    ...overrides,
  };
}

function makeApiRequest(overrides: Record<string, unknown>) {
  return {
    type: ClaudeCodeOtelSignalType.ApiRequest,
    sessionId: SESSION_ID,
    model: MODEL,
    startedAt: "2026-06-18T19:00:02.000Z",
    inputTokens: 100,
    outputTokens: 30,
    cacheReadTokens: 5,
    cacheCreationTokens: 2,
    costUsd: 1.75,
    durationMs: 2500,
    ...overrides,
  };
}

function makeTokenUsage(overrides: Record<string, unknown>) {
  return {
    type: ClaudeCodeOtelSignalType.TokenUsage,
    sessionId: SESSION_ID,
    model: MODEL,
    observedAt: "2026-06-18T19:00:03.000Z",
    inputTokens: 120,
    outputTokens: 40,
    cacheReadTokens: 6,
    cacheCreationTokens: 3,
    ...overrides,
  };
}
