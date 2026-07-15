import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { loadSessionsFromDb } from "../src/main/collectors/opencode/opencode-parser.js";
import {
  Harness,
  type NormalizedSession,
} from "../src/main/collectors/types.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { getArtifactSessionUsage } from "../src/main/database/sync-source.js";
import {
  ModelPricingCurrency,
  ModelPricingSource,
} from "../src/main/model-pricing/model-pricing-fixture.js";
import { computeExpectedTokenCost } from "./model-pricing-test-utils.js";
import { makeSession as baseSession } from "./normalized-session-test-utils.js";

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const CACHE_COST_EPSILON = 1e-12;

function assertCacheCostEpsilon(
  cCache: number | undefined,
  eventRows: Record<string, unknown>[],
  label: string
): void {
  const expectedCache =
    sumEventCost(eventRows, "cache_read_cost_usd_estimated") +
    sumEventCost(eventRows, "cache_creation_cost_usd_estimated");
  // biome-ignore lint/suspicious/noMisplacedAssertion: helper called from test blocks
  assert.ok(
    Math.abs((cCache ?? 0) - expectedCache) < CACHE_COST_EPSILON,
    `${label} cCache within epsilon: ${cCache} vs ${expectedCache}`
  );
}

test("SQLite open and reopen leave model pricing rows empty", async () => {
  const { db, dir, dataDir } = await openTempDb();
  try {
    assert.equal(await countModelPricingRows(db), 0);
    await db.close();

    const reopened = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "api",
      now: () => "2026-06-07T12:00:00.000Z",
    });
    try {
      assert.equal(await countModelPricingRows(reopened), 0);
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Codex import persists token, event, session, projection, sync, and bucket costs", async () => {
  const { db, dir } = await openTempDb();
  try {
    const session = makeSession({
      sessionId: "codex-priced",
      harness: Harness.Codex,
      model: "gpt-5-codex",
    });
    await db.importer.importSession(session, Harness.Codex);

    const usageCost = expectedCost("gpt-5-codex", {
      inputTokens: 200,
      outputTokens: 40,
      cacheReadTokens: 20,
      cacheWriteTokens: 4,
    });
    const eventCost = expectedCost("gpt-5-codex", {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 10,
      cacheWriteTokens: 2,
    });
    const tokenRows = await selectTokenUsageCosts(db, session.sessionId);
    assert.deepEqual(tokenRows, [
      {
        model: "gpt-5-codex",
        cost_usd_estimated: usageCost.costUsd,
        cost_currency: ModelPricingCurrency.Usd,
        cost_source: ModelPricingSource.GenaiPricesV1,
      },
    ]);

    const eventRows = await selectTokenEventCosts(db, session.sessionId);
    assert.deepEqual(eventRows, [
      {
        model: "gpt-5-codex",
        cost_usd_estimated: eventCost.costUsd,
        input_cost_usd_estimated: eventCost.inputCostUsd,
        output_cost_usd_estimated: eventCost.outputCostUsd,
        cache_read_cost_usd_estimated: eventCost.cacheReadCostUsd,
        cache_creation_cost_usd_estimated: eventCost.cacheWriteCostUsd,
      },
      {
        model: "gpt-5-codex",
        cost_usd_estimated: eventCost.costUsd,
        input_cost_usd_estimated: eventCost.inputCostUsd,
        output_cost_usd_estimated: eventCost.outputCostUsd,
        cache_read_cost_usd_estimated: eventCost.cacheReadCostUsd,
        cache_creation_cost_usd_estimated: eventCost.cacheWriteCostUsd,
      },
    ]);

    const sessionCost = await selectSessionCost(db, session.sessionId);
    assert.deepEqual(sessionCost, {
      cost_usd_estimated: usageCost.costUsd,
      cost_currency: ModelPricingCurrency.Usd,
      cost_source: ModelPricingSource.GenaiPricesV1,
    });

    const page = await db.sessions.getPage({ limit: 1 });
    assert.equal(page.sessions[0]?.estimatedCostUsd, usageCost.costUsd);

    const detail = await db.sessions.getDetailsById(session.sessionId);
    assert.equal(detail?.estimatedCostUsd, usageCost.costUsd);

    const synced = await db.syncSource.loadSyncedSessions(
      [session.sessionId],
      emptyAttributionCache()
    );
    assert.equal(
      synced[0].tokenUsageByModel[0].estimatedCostUsd,
      usageCost.costUsd
    );
    assert.equal(
      synced[0].activityBuckets?.[0].cIn,
      sumEventCost(eventRows, "input_cost_usd_estimated")
    );
    assert.equal(
      synced[0].activityBuckets?.[0].cOut,
      sumEventCost(eventRows, "output_cost_usd_estimated")
    );
    assertCacheCostEpsilon(
      synced[0].activityBuckets?.[0].cCache,
      eventRows,
      "synced"
    );

    const artifactSlug = "FEA-2030-codex-cost";
    await linkClosedloopArtifact(db, session.sessionId, artifactSlug);
    const [usage] = await getArtifactSessionUsage(db.prisma, [artifactSlug]);
    assert.equal(usage?.estimatedCostUsd, usageCost.costUsd);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("OpenCode parser import persists token, event, session, sync, and bucket costs", async () => {
  const { db, dir } = await openTempDb();
  try {
    const opencodeDbPath = createOpenCodeDb({
      dir,
      sessionId: "ses_priced",
      model: "gpt-5",
    });
    const [session] = loadSessionsFromDb(opencodeDbPath);
    assert.ok(session, "expected parsed OpenCode session");

    await db.importer.importSession(session, Harness.OpenCode);

    const usageCost = expectedCost("gpt-5", {
      inputTokens: 200,
      outputTokens: 40,
      cacheReadTokens: 20,
      cacheWriteTokens: 4,
    });
    assert.deepEqual(await selectTokenUsageCosts(db, session.sessionId), [
      {
        model: "gpt-5",
        cost_usd_estimated: usageCost.costUsd,
        cost_currency: ModelPricingCurrency.Usd,
        cost_source: ModelPricingSource.GenaiPricesV1,
      },
    ]);
    const eventRows = await selectTokenEventCosts(db, session.sessionId);
    assert.deepEqual(eventRows, [
      {
        model: "gpt-5",
        cost_usd_estimated: usageCost.costUsd,
        input_cost_usd_estimated: usageCost.inputCostUsd,
        output_cost_usd_estimated: usageCost.outputCostUsd,
        cache_read_cost_usd_estimated: usageCost.cacheReadCostUsd,
        cache_creation_cost_usd_estimated: usageCost.cacheWriteCostUsd,
      },
    ]);
    assert.deepEqual(await selectSessionCost(db, session.sessionId), {
      cost_usd_estimated: usageCost.costUsd,
      cost_currency: ModelPricingCurrency.Usd,
      cost_source: ModelPricingSource.GenaiPricesV1,
    });

    const synced = await db.syncSource.loadSyncedSessions(
      [session.sessionId],
      emptyAttributionCache()
    );
    assert.equal(
      synced[0].tokenUsageByModel[0].estimatedCostUsd,
      usageCost.costUsd
    );
    assert.equal(
      synced[0].activityBuckets?.[0].cIn,
      sumEventCost(eventRows, "input_cost_usd_estimated")
    );
    assert.equal(
      synced[0].activityBuckets?.[0].cOut,
      sumEventCost(eventRows, "output_cost_usd_estimated")
    );
    assertCacheCostEpsilon(
      synced[0].activityBuckets?.[0].cCache,
      eventRows,
      "synced"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("OpenCode unknown import leaves costs null and omits optional costs after replay", async () => {
  const { db, dir } = await openTempDb();
  try {
    const session = makeSession({
      sessionId: "opencode-miss",
      harness: Harness.OpenCode,
      model: "opencode-default",
    });

    await db.importer.importSession(session, Harness.OpenCode);
    await db.importer.importSession(session, Harness.OpenCode);

    assert.deepEqual(await selectTokenUsageCosts(db, session.sessionId), [
      {
        model: "opencode-default",
        cost_usd_estimated: null,
        cost_currency: null,
        cost_source: null,
      },
    ]);
    assert.deepEqual(await selectSessionCost(db, session.sessionId), {
      cost_usd_estimated: null,
      cost_currency: null,
      cost_source: null,
    });

    const synced = await db.syncSource.loadSyncedSessions(
      [session.sessionId],
      emptyAttributionCache()
    );
    assert.equal(
      Object.hasOwn(synced[0].tokenUsageByModel[0], "estimatedCostUsd"),
      false
    );
    assert.equal(synced[0].activityBuckets?.[0].cIn, 0);
    assert.equal(synced[0].activityBuckets?.[0].cOut, 0);
    assert.equal(synced[0].activityBuckets?.[0].cCache, 0);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude import persists genai-prices estimated costs (no harness gate)", async () => {
  // FEA-2134: with the FEA-1845 harness gate removed, Claude flows through the
  // same persistImportedTokenCosts path as Codex/OpenCode, so genai-prices
  // estimates are written into the cost columns at import time (previously
  // null, with cost derived only on read).
  const { db, dir } = await openTempDb();
  try {
    const session = makeSession({
      sessionId: "claude-priced",
      harness: Harness.Claude,
      model: "claude-opus-4-5",
    });
    await db.importer.importSession(session, Harness.Claude);

    const usageCost = expectedCost("claude-opus-4-5", {
      inputTokens: 200,
      outputTokens: 40,
      cacheReadTokens: 20,
      cacheWriteTokens: 4,
    });
    const eventCost = expectedCost("claude-opus-4-5", {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 10,
      cacheWriteTokens: 2,
    });

    assert.deepEqual(await selectTokenUsageCosts(db, session.sessionId), [
      {
        model: "claude-opus-4-5",
        cost_usd_estimated: usageCost.costUsd,
        cost_currency: ModelPricingCurrency.Usd,
        cost_source: ModelPricingSource.GenaiPricesV1,
      },
    ]);
    const eventRows = await selectTokenEventCosts(db, session.sessionId);
    assert.deepEqual(eventRows, [
      {
        model: "claude-opus-4-5",
        cost_usd_estimated: eventCost.costUsd,
        input_cost_usd_estimated: eventCost.inputCostUsd,
        output_cost_usd_estimated: eventCost.outputCostUsd,
        cache_read_cost_usd_estimated: eventCost.cacheReadCostUsd,
        cache_creation_cost_usd_estimated: eventCost.cacheWriteCostUsd,
      },
      {
        model: "claude-opus-4-5",
        cost_usd_estimated: eventCost.costUsd,
        input_cost_usd_estimated: eventCost.inputCostUsd,
        output_cost_usd_estimated: eventCost.outputCostUsd,
        cache_read_cost_usd_estimated: eventCost.cacheReadCostUsd,
        cache_creation_cost_usd_estimated: eventCost.cacheWriteCostUsd,
      },
    ]);
    assert.deepEqual(await selectSessionCost(db, session.sessionId), {
      cost_usd_estimated: usageCost.costUsd,
      cost_currency: ModelPricingCurrency.Usd,
      cost_source: ModelPricingSource.GenaiPricesV1,
    });

    const synced = await db.syncSource.loadSyncedSessions(
      [session.sessionId],
      emptyAttributionCache()
    );
    assert.equal(
      synced[0].tokenUsageByModel[0].estimatedCostUsd,
      usageCost.costUsd
    );

    const page = await db.sessions.getPage({ limit: 1 });
    assert.equal(page.sessions[0]?.estimatedCostUsd, usageCost.costUsd);

    const artifactSlug = "FEA-2134-claude-cost";
    await linkClosedloopArtifact(db, session.sessionId, artifactSlug);
    const [usage] = await getArtifactSessionUsage(db.prisma, [artifactSlug]);
    assert.equal(usage?.estimatedCostUsd, usageCost.costUsd);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("live hook transcript path persists token, event, session, sync, and bucket costs", async () => {
  const { db, dir } = await openTempDb({
    extractTranscript: () => ({
      tokensByModel: new Map([
        [
          "gpt-5-codex",
          { input: 200, output: 40, cacheRead: 20, cacheWrite: 4 },
        ],
      ]),
      latestModel: "gpt-5-codex",
      compactionCount: 0,
      records: [
        {
          timestamp: "2026-06-07T11:01:00.000Z",
          model: "gpt-5-codex",
          input: 200,
          output: 40,
          cacheRead: 20,
          cacheWrite: 4,
        },
      ],
    }),
  });
  try {
    await db.processEvent(
      "PostToolUse",
      {
        session_id: "codex-live-priced",
        session_name: "Codex live pricing",
        cwd: "/workspace/codex-live-priced",
        model: "gpt-5-codex",
        transcript_path: "/tmp/codex-live-priced.jsonl",
      },
      Harness.Codex
    );

    const usageCost = expectedCost("gpt-5-codex", {
      inputTokens: 200,
      outputTokens: 40,
      cacheReadTokens: 20,
      cacheWriteTokens: 4,
    });
    assert.deepEqual(await selectTokenUsageCosts(db, "codex-live-priced"), [
      {
        model: "gpt-5-codex",
        cost_usd_estimated: usageCost.costUsd,
        cost_currency: ModelPricingCurrency.Usd,
        cost_source: ModelPricingSource.GenaiPricesV1,
      },
    ]);
    const eventRows = await selectTokenEventCosts(db, "codex-live-priced");
    assert.deepEqual(eventRows, [
      {
        model: "gpt-5-codex",
        cost_usd_estimated: usageCost.costUsd,
        input_cost_usd_estimated: usageCost.inputCostUsd,
        output_cost_usd_estimated: usageCost.outputCostUsd,
        cache_read_cost_usd_estimated: usageCost.cacheReadCostUsd,
        cache_creation_cost_usd_estimated: usageCost.cacheWriteCostUsd,
      },
    ]);
    assert.deepEqual(await selectSessionCost(db, "codex-live-priced"), {
      cost_usd_estimated: usageCost.costUsd,
      cost_currency: ModelPricingCurrency.Usd,
      cost_source: ModelPricingSource.GenaiPricesV1,
    });

    const synced = await db.syncSource.loadSyncedSessions(
      ["codex-live-priced"],
      emptyAttributionCache()
    );
    assert.equal(
      synced[0].tokenUsageByModel[0].estimatedCostUsd,
      usageCost.costUsd
    );
    assert.equal(
      synced[0].activityBuckets?.[0].cIn,
      sumEventCost(eventRows, "input_cost_usd_estimated")
    );
    assert.equal(
      synced[0].activityBuckets?.[0].cOut,
      sumEventCost(eventRows, "output_cost_usd_estimated")
    );
    assertCacheCostEpsilon(
      synced[0].activityBuckets?.[0].cCache,
      eventRows,
      "synced"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("live hook transcript replay prices only newly appended unknown events", async () => {
  let now = "2026-06-07T12:00:00.000Z";
  const transcriptRecords = [
    {
      timestamp: "2026-06-07T11:01:00.000Z",
      model: "unknown-codex-model",
      input: 200,
      output: 40,
      cacheRead: 20,
      cacheWrite: 4,
    },
  ];
  const { db, dir } = await openTempDb({
    extractTranscript: () => ({
      tokensByModel: new Map([
        ["unknown-codex-model", sumTokenEventRecords(transcriptRecords)],
      ]),
      latestModel: "unknown-codex-model",
      compactionCount: 0,
      records: transcriptRecords,
    }),
    now: () => now,
  });
  try {
    await db.processEvent(
      "PostToolUse",
      {
        session_id: "codex-live-unknown-replay",
        session_name: "Codex live unknown replay",
        cwd: "/workspace/codex-live-unknown-replay",
        model: "unknown-codex-model",
        transcript_path: "/tmp/codex-live-unknown-replay.jsonl",
      },
      Harness.Codex
    );
    assert.equal(await countTokenEventRows(db, "codex-live-unknown-replay"), 1);

    transcriptRecords.push({
      timestamp: "2026-06-07T11:02:00.000Z",
      model: "unknown-codex-model",
      input: 100,
      output: 20,
      cacheRead: 10,
      cacheWrite: 2,
    });
    now = "2026-06-07T12:01:00.000Z";
    await db.processEvent(
      "PostToolUse",
      {
        session_id: "codex-live-unknown-replay",
        session_name: "Codex live unknown replay",
        cwd: "/workspace/codex-live-unknown-replay",
        model: "unknown-codex-model",
        transcript_path: "/tmp/codex-live-unknown-replay.jsonl",
      },
      Harness.Codex
    );

    assert.equal(await countTokenEventRows(db, "codex-live-unknown-replay"), 2);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function openTempDb(input?: {
  extractTranscript?: Parameters<
    typeof openSqliteAgentDatabase
  >[0]["extractTranscript"];
  now?: () => string;
}): Promise<{
  db: SqliteDb;
  dir: string;
  dataDir: string;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "model-pricing-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "api",
    extractTranscript: input?.extractTranscript,
    now: input?.now ?? (() => "2026-06-07T12:00:00.000Z"),
  });
  return { db, dir, dataDir };
}

async function countModelPricingRows(db: SqliteDb): Promise<number> {
  const result = await db.prisma.client.$queryRawUnsafe<{ count: number }[]>(
    "SELECT COUNT(*) AS count FROM model_pricing"
  );
  return Number(result[0].count);
}

async function countTokenEventRows(
  db: SqliteDb,
  sessionId: string
): Promise<number> {
  const result = await db.prisma.client.$queryRawUnsafe<{ count: number }[]>(
    "SELECT COUNT(*) AS count FROM token_events WHERE session_id = $1",
    sessionId
  );
  return Number(result[0].count);
}

async function selectTokenUsageCosts(
  db: SqliteDb,
  sessionId: string
): Promise<
  Array<{
    model: string;
    cost_usd_estimated: number | null;
    cost_currency: string | null;
    cost_source: string | null;
  }>
> {
  const result = await db.prisma.client.$queryRawUnsafe<
    {
      model: string;
      cost_usd_estimated: number | null;
      cost_currency: string | null;
      cost_source: string | null;
    }[]
  >(
    `SELECT model, cost_usd_estimated, cost_currency, cost_source
     FROM token_usage
     WHERE session_id = $1
     ORDER BY model ASC`,
    sessionId
  );
  return result;
}

async function selectTokenEventCosts(
  db: SqliteDb,
  sessionId: string
): Promise<
  Array<{
    model: string;
    cost_usd_estimated: number | null;
    input_cost_usd_estimated: number | null;
    output_cost_usd_estimated: number | null;
    cache_read_cost_usd_estimated: number | null;
    cache_creation_cost_usd_estimated: number | null;
  }>
> {
  const result = await db.prisma.client.$queryRawUnsafe<
    {
      model: string;
      cost_usd_estimated: number | null;
      input_cost_usd_estimated: number | null;
      output_cost_usd_estimated: number | null;
      cache_read_cost_usd_estimated: number | null;
      cache_creation_cost_usd_estimated: number | null;
    }[]
  >(
    `SELECT
       model,
       cost_usd_estimated,
       input_cost_usd_estimated,
       output_cost_usd_estimated,
       cache_read_cost_usd_estimated,
       cache_creation_cost_usd_estimated
     FROM token_events
     WHERE session_id = $1
     ORDER BY created_at ASC`,
    sessionId
  );
  return result;
}

async function selectSessionCost(
  db: SqliteDb,
  sessionId: string
): Promise<{
  cost_usd_estimated: number | null;
  cost_currency: string | null;
  cost_source: string | null;
}> {
  const result = await db.prisma.client.$queryRawUnsafe<
    {
      cost_usd_estimated: number | null;
      cost_currency: string | null;
      cost_source: string | null;
    }[]
  >(
    `SELECT cost_usd_estimated, cost_currency, cost_source
     FROM sessions
     WHERE id = $1`,
    sessionId
  );
  return result[0];
}

function sumEventCost(
  rows: Awaited<ReturnType<typeof selectTokenEventCosts>>,
  key:
    | "input_cost_usd_estimated"
    | "output_cost_usd_estimated"
    | "cache_read_cost_usd_estimated"
    | "cache_creation_cost_usd_estimated"
): number {
  const sum = rows.reduce((total, row) => total + (row[key] ?? 0), 0);
  return Math.round(sum * 1_000_000) / 1_000_000;
}

function makeSession(input: {
  sessionId: string;
  harness: Harness;
  model: string;
}): NormalizedSession {
  return baseSession({
    sessionId: input.sessionId,
    name: `${input.harness} pricing session`,
    cwd: `/workspace/${input.sessionId}`,
    model: input.model,
    version: "1.0.0",
    slug: input.sessionId,
    gitBranch: "fea-1845",
    startedAt: "2026-06-07T11:00:00.000Z",
    endedAt: "2026-06-07T11:10:00.000Z",
    userMessages: 1,
    assistantMessages: 1,
    tokensByModel: {
      [input.model]: {
        input: 200,
        output: 40,
        cacheRead: 20,
        cacheWrite: 4,
      },
    },
    tokenSeries: [
      {
        timestamp: "2026-06-07T11:01:00.000Z",
        model: input.model,
        input: 100,
        output: 20,
        cacheRead: 10,
        cacheWrite: 2,
      },
      {
        timestamp: "2026-06-07T11:02:00.000Z",
        model: input.model,
        input: 100,
        output: 20,
        cacheRead: 10,
        cacheWrite: 2,
      },
    ],
    messageTimestamps: ["2026-06-07T11:01:00.000Z"],
    entrypoint: input.harness,
  });
}

async function linkClosedloopArtifact(
  db: SqliteDb,
  sessionId: string,
  slug: string
): Promise<void> {
  const observedAt = "2026-06-07T12:00:00.000Z";
  const artifactId = `artifact-${slug}`;
  await db.run(
    `INSERT INTO artifacts
       (id, identity_key, kind, slug, observed_at, created_at, last_seen_at)
     VALUES ($1, $2, 'closedloop_artifact', $3, $4, $4, $4)`,
    artifactId,
    `cldoc:${slug}`,
    slug,
    observedAt
  );
  await db.run(
    `INSERT INTO session_artifact_links
       (id, session_id, artifact_id, relation, method, evidence, is_primary,
        status, extractor_version, observed_at, created_at)
     VALUES ($1, $2, $3, 'referenced', 'test_fixture', '{}', FALSE, 'candidate', 1, $4, $4)`,
    `${sessionId}:${artifactId}:referenced`,
    sessionId,
    artifactId,
    observedAt
  );
}

function emptyAttributionCache() {
  return {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
}

function sumTokenEventRecords(
  records: Array<{
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  }>
) {
  return records.reduce(
    (total, record) => ({
      input: total.input + record.input,
      output: total.output + record.output,
      cacheRead: total.cacheRead + record.cacheRead,
      cacheWrite: total.cacheWrite + record.cacheWrite,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  );
}

function expectedCost(
  model: string,
  counts: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }
) {
  return computeExpectedTokenCost({
    model,
    ...counts,
    timestamp: new Date("2026-06-07T11:01:00.000Z"),
  });
}

function createOpenCodeDb(input: {
  dir: string;
  sessionId: string;
  model: string;
}): string {
  const dbPath = path.join(input.dir, `${input.sessionId}.opencode.db`);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, slug TEXT, directory TEXT NOT NULL, title TEXT NOT NULL,
      version TEXT NOT NULL, agent TEXT, model TEXT, permission TEXT,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL,
      tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
      tokens_cache_write INTEGER DEFAULT 0 NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO session (
      id, slug, directory, title, version, agent, model, permission,
      time_created, time_updated, tokens_input, tokens_output,
      tokens_reasoning, tokens_cache_read, tokens_cache_write
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.sessionId,
    "priced-open",
    "/workspace/priced-open",
    "Priced OpenCode session",
    "1.15.5",
    "build",
    JSON.stringify({ id: input.model, providerID: "opencode" }),
    "",
    1_780_830_000_000,
    1_780_830_060_000,
    200,
    40,
    0,
    20,
    4
  );
  db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
  ).run(
    `${input.sessionId}_msg_user`,
    input.sessionId,
    1_780_830_000_000,
    1_780_830_000_000,
    JSON.stringify({ role: "user", time: { created: 1_780_830_000_000 } })
  );
  db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
  ).run(
    `${input.sessionId}_msg_assistant`,
    input.sessionId,
    1_780_830_030_000,
    1_780_830_030_000,
    JSON.stringify({
      role: "assistant",
      model: { id: input.model, providerID: "opencode" },
      path: { cwd: "/workspace/priced-open", root: "/workspace/priced-open" },
      time: { created: 1_780_830_030_000 },
      tokens: {
        input: 200,
        output: 40,
        cacheRead: 20,
        cacheWrite: 4,
      },
    })
  );
  db.close();
  return dbPath;
}
