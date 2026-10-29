/**
 * @file token-cost-maintenance-coverage.test.ts
 * @description ISS-10514 coverage for token-cost-maintenance.ts against a real
 * migrated SQLite store: the cache-cost-split heal end to end, the unpriceable
 * and NULL-column arms of the reprice pass, and the per-chunk failure isolation
 * of every heal. A chunk failure is produced by a real SQLite trigger that
 * aborts the chunk's UPDATE, so no database layer is faked.
 * Pins CURRENT behavior only.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import {
  TokenCostBasis,
  TokenCostCompleteness,
  TokenCostCompletenessReason,
} from "@repo/api/src/types/token-cost-provenance";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  healCacheCostSplit,
  healSessionLastActivityAtFloor,
  healSessionRollupAfterTtlPremiumRemoval,
  healTokenUsageEventConservation,
  repriceUnpricedTokenUsage,
  runCostRollupHealPasses,
} from "../src/main/database/token-cost-maintenance.js";
import { parseStoredTokenCostSummary } from "../src/main/database/token-event-contract.js";
import { estimateTokenCost } from "../src/shared/token-cost.js";

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const STORE_NOW = "2026-06-21T12:00:00.000Z";
const WALL_NOW = new Date("2026-07-01T09:30:00.000Z");
const EVENT_AT = "2026-06-20T08:00:00.000Z";
const OPUS = "claude-opus-4-5";
// claude-opus-4-5 @ 1000 input tokens prices to $0.005 (token-cost.test.ts).
const OPUS_INPUT_TOKENS = 1000;
const OPUS_REPRICED_COST = 0.005;
const UNPRICEABLE_MODEL = "";
const BAD_ID = "bad";
const GOOD_ID = "good";
const INJECTED_FAILURE = "injected chunk failure";

const REPRICE_CHUNK_FAILED_RE =
  /^token-usage re-pricing failed for chunk \[\d, \d\): [\s\S]*injected chunk failure/;
const TTL_CHUNK_FAILED_RE =
  /^ttl-premium-removal rollup heal failed for chunk \[0, 1\): [\s\S]*injected chunk failure/;
const CACHE_SPLIT_CHUNK_FAILED_RE =
  /^cache-cost-split heal failed for chunk \[0, 1\): [\s\S]*injected chunk failure/;
const CONSERVATION_CHUNK_FAILED_RE =
  /^token-usage cost-conservation heal failed for chunk \[0, 1\): [\s\S]*injected chunk failure/;
const FLOOR_CHUNK_FAILED_RE =
  /^last-activity floor heal failed for chunk \[\d, \d\): [\s\S]*injected chunk failure/;

let db: SqliteDb;
let dir: string;
let logs: string[];
const log = (message: string) => {
  logs.push(message);
};

beforeEach(async () => {
  logs = [];
  dir = await mkdtemp(path.join(os.tmpdir(), "token-cost-maint-cov-"));
  db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => STORE_NOW,
  });
  await db.whenBootMaintenanceSettled();
});

afterEach(async () => {
  vi.useRealTimers();
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

async function insertSession(
  id: string,
  fields: {
    status?: string;
    startedAt?: string;
    lastActivityAt?: string;
    cost?: number | null;
    metadata?: string | null;
  } = {}
) {
  await db.run(
    `INSERT INTO sessions (id, status, harness, started_at, updated_at, last_activity_at, cost_usd_estimated, metadata)
     VALUES ($1, $2, 'claude_code', $3, $4, $5, $6, $7)`,
    id,
    fields.status ?? SESSION_STATUS.INACTIVE,
    fields.startedAt ?? EVENT_AT,
    STORE_NOW,
    fields.lastActivityAt ?? fields.startedAt ?? EVENT_AT,
    fields.cost ?? null,
    fields.metadata ?? null
  );
}

async function insertUsage(
  sessionId: string,
  model: string,
  fields: {
    input?: number;
    cacheRead?: number;
    cost?: number | null;
    createdAt?: string | null;
  } = {}
) {
  await db.run(
    `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at, cost_usd_estimated)
     VALUES ($1, $2, $3, 0, $4, 0, $5, $6)`,
    sessionId,
    model,
    fields.input ?? OPUS_INPUT_TOKENS,
    fields.cacheRead ?? 0,
    fields.createdAt === undefined ? EVENT_AT : fields.createdAt,
    fields.cost ?? null
  );
}

type EventFields = {
  transportId?: string | null;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite5m?: number | null;
  cacheWrite1h?: number | null;
  cost?: number | null;
  costSummary?: string | null;
};

async function insertEvent(
  sessionId: string,
  model: string,
  fields: EventFields = {}
) {
  await db.run(
    `INSERT INTO token_events (session_id, transport_id, model, created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cost_usd_estimated, cost_summary)
     VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9, $10, $11)`,
    sessionId,
    fields.transportId ?? null,
    model,
    EVENT_AT,
    fields.input ?? OPUS_INPUT_TOKENS,
    fields.cacheRead ?? 0,
    fields.cacheWrite ?? 0,
    fields.cacheWrite5m ?? null,
    fields.cacheWrite1h ?? null,
    fields.cost ?? null,
    fields.costSummary ?? null
  );
}

async function failUpdatesOf(table: string, idColumn: string) {
  await db.run(
    `CREATE TRIGGER fail_${table}_update BEFORE UPDATE ON ${table}
     WHEN OLD.${idColumn} = '${BAD_ID}'
     BEGIN SELECT RAISE(ABORT, '${INJECTED_FAILURE}'); END`
  );
}

async function usageRow(sessionId: string, model: string) {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { cost_usd_estimated: number | null; cost_observed_at: string | null }[]
  >(
    "SELECT cost_usd_estimated, cost_observed_at FROM token_usage WHERE session_id = $1 AND model = $2",
    sessionId,
    model
  );
  return rows[0];
}

async function eventCosts(sessionId: string) {
  return await db.prisma.client.$queryRawUnsafe<
    {
      cost_usd_estimated: number | null;
      input_cost_usd_estimated: number | null;
      cache_read_cost_usd_estimated: number | null;
      cache_creation_cost_usd_estimated: number | null;
      cost_summary: string | null;
    }[]
  >(
    `SELECT cost_usd_estimated, input_cost_usd_estimated, cache_read_cost_usd_estimated,
            cache_creation_cost_usd_estimated, cost_summary
       FROM token_events WHERE session_id = $1`,
    sessionId
  );
}

async function sessionRow(id: string) {
  const rows = await db.prisma.client.$queryRawUnsafe<
    {
      cost_usd_estimated: number | null;
      last_activity_at: string | null;
      updated_at: string | null;
    }[]
  >(
    "SELECT cost_usd_estimated, last_activity_at, updated_at FROM sessions WHERE id = $1",
    id
  );
  return rows[0];
}

describe("repriceUnpricedTokenUsage", () => {
  it("leaves an unpriceable usage row and its unpriceable events NULL and reports zero repriced", async () => {
    await insertSession("s1");
    await insertUsage("s1", UNPRICEABLE_MODEL);
    await insertEvent("s1", UNPRICEABLE_MODEL, { transportId: "t-unpriced" });

    await repriceUnpricedTokenUsage(db.prisma, log);

    expect((await usageRow("s1", UNPRICEABLE_MODEL))?.cost_usd_estimated).toBe(
      null
    );
    expect(await eventCosts("s1")).toEqual([
      {
        cost_usd_estimated: null,
        input_cost_usd_estimated: null,
        cache_read_cost_usd_estimated: null,
        cache_creation_cost_usd_estimated: null,
        cost_summary: null,
      },
    ]);
    expect(logs).toEqual([
      "token-usage re-pricing complete: repriced 0 row(s) across 0 session(s)",
    ]);
  });

  it("stamps a usage row with no created_at at the pass's own wall-clock instant", async () => {
    await insertSession("s1");
    await insertUsage("s1", OPUS, { createdAt: null });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(WALL_NOW);

    await repriceUnpricedTokenUsage(db.prisma, log);

    expect(await usageRow("s1", OPUS)).toEqual({
      cost_usd_estimated: OPUS_REPRICED_COST,
      cost_observed_at: WALL_NOW.toISOString(),
    });
  });

  it("treats a pre-marker source-identity-unavailable API estimate as local and refreshes it", async () => {
    const staleSubtotal = 0.001;
    await insertSession("s1");
    await insertUsage("s1", OPUS);
    await insertEvent("s1", OPUS, {
      transportId: "t-1",
      costSummary: JSON.stringify({
        completeness: TokenCostCompleteness.Partial,
        reason: TokenCostCompletenessReason.SourceIdentityUnavailable,
        subtotalUsd: staleSubtotal,
        lanes: [
          { basis: TokenCostBasis.ApiEstimated, subtotalUsd: staleSubtotal },
        ],
      }),
    });

    await repriceUnpricedTokenUsage(db.prisma, log);

    const [event] = await eventCosts("s1");
    expect(event?.cost_usd_estimated).toBe(OPUS_REPRICED_COST);
    expect(parseStoredTokenCostSummary(event?.cost_summary)).toEqual({
      completeness: TokenCostCompleteness.Partial,
      reason: TokenCostCompletenessReason.LegacyRecord,
      subtotalUsd: OPUS_REPRICED_COST,
      lanes: [
        { basis: TokenCostBasis.ApiEstimated, subtotalUsd: OPUS_REPRICED_COST },
      ],
    });
  });

  it("isolates a failed chunk: the other session still reprices and the failure is logged", async () => {
    await insertSession(GOOD_ID);
    await insertSession(BAD_ID);
    await insertUsage(GOOD_ID, OPUS);
    await insertUsage(BAD_ID, OPUS);
    await failUpdatesOf("token_usage", "session_id");

    await repriceUnpricedTokenUsage(db.prisma, log, 1);

    expect((await usageRow(GOOD_ID, OPUS))?.cost_usd_estimated).toBe(
      OPUS_REPRICED_COST
    );
    expect((await usageRow(BAD_ID, OPUS))?.cost_usd_estimated).toBe(null);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(REPRICE_CHUNK_FAILED_RE);
    expect(logs[1]).toBe(
      "token-usage re-pricing complete: repriced 1 row(s) across 1 session(s)"
    );
  });
});

describe("healSessionRollupAfterTtlPremiumRemoval", () => {
  const premiumMetadata = JSON.stringify({
    usageExtras: { cache_creation: { ephemeral_1h_input_tokens: 10 } },
  });

  it("recomputes a candidate with no priced usage to a NULL cost and counts it as changed", async () => {
    await insertSession("s1", { cost: 5, metadata: premiumMetadata });

    await healSessionRollupAfterTtlPremiumRemoval(db.prisma, log);

    expect((await sessionRow("s1"))?.cost_usd_estimated).toBe(null);
    expect(logs).toEqual([
      "ttl-premium-removal rollup heal: recomputed 1 session(s) of 1 candidate(s)",
    ]);
  });

  it("logs a failed chunk with the failed-chunk suffix and keeps the stored cost", async () => {
    await insertSession(BAD_ID, { cost: 5, metadata: premiumMetadata });
    await failUpdatesOf("sessions", "id");

    await healSessionRollupAfterTtlPremiumRemoval(db.prisma, log);

    expect((await sessionRow(BAD_ID))?.cost_usd_estimated).toBe(5);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(TTL_CHUNK_FAILED_RE);
    expect(logs[1]).toBe(
      "ttl-premium-removal rollup heal: recomputed 0 session(s) of 1 candidate(s) (1 chunk(s) failed)"
    );
  });
});

describe("healCacheCostSplit", () => {
  const cacheTokens = { cacheRead: 2000, cacheWrite: 400 };

  it("re-splits a folded cache cost through the boot heal sequence and leaves the total untouched", async () => {
    const foldedTotal = 9;
    await insertSession("s1");
    await insertEvent("s1", OPUS, { ...cacheTokens, cost: foldedTotal });
    const expected = estimateTokenCost({
      model: OPUS,
      inputTokens: OPUS_INPUT_TOKENS,
      outputTokens: 0,
      cacheReadTokens: cacheTokens.cacheRead,
      cacheWriteTokens: cacheTokens.cacheWrite,
      observedAt: EVENT_AT,
    });

    await runCostRollupHealPasses(db.prisma, log);

    const [event] = await eventCosts("s1");
    expect(event).toMatchObject({
      cost_usd_estimated: foldedTotal,
      input_cost_usd_estimated: expected?.inputCostUsd,
      cache_read_cost_usd_estimated: expected?.cacheReadCostUsd,
      cache_creation_cost_usd_estimated: expected?.cacheWriteCostUsd,
    });
    expect(logs).toContain(
      "cache-cost-split heal: re-split 1 row(s) across 1 session(s)"
    );
  });

  it("prices the cache-write lane from the persisted TTL split", async () => {
    await insertSession("plain");
    await insertSession("split");
    await insertEvent("plain", OPUS, { ...cacheTokens, cost: 1 });
    await insertEvent("split", OPUS, {
      ...cacheTokens,
      cacheWrite5m: 100,
      cacheWrite1h: 300,
      cost: 1,
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(WALL_NOW);

    await healCacheCostSplit(db.prisma, log);

    const [plain] = await eventCosts("plain");
    const [split] = await eventCosts("split");
    const expectedSplit = estimateTokenCost({
      model: OPUS,
      inputTokens: OPUS_INPUT_TOKENS,
      outputTokens: 0,
      cacheReadTokens: cacheTokens.cacheRead,
      cacheWriteTokens: cacheTokens.cacheWrite,
      cacheWrite1hTokens: 300,
      observedAt: EVENT_AT,
    });
    expect(split?.cache_creation_cost_usd_estimated).toBe(
      expectedSplit?.cacheWriteCostUsd
    );
    expect(split?.cache_creation_cost_usd_estimated).toBeGreaterThan(
      plain?.cache_creation_cost_usd_estimated ?? Number.POSITIVE_INFINITY
    );
    expect((await sessionRow("plain"))?.updated_at).toBe(
      WALL_NOW.toISOString()
    );
    expect((await sessionRow("split"))?.updated_at).toBe(
      WALL_NOW.toISOString()
    );
    expect(logs).toEqual([
      "cache-cost-split heal: re-split 2 row(s) across 2 session(s)",
    ]);
  });

  it("skips an unpriceable row without writing or logging", async () => {
    await insertSession("s1");
    await insertEvent("s1", UNPRICEABLE_MODEL, { ...cacheTokens, cost: 3 });

    await healCacheCostSplit(db.prisma, log);

    expect((await eventCosts("s1"))[0]?.cache_creation_cost_usd_estimated).toBe(
      null
    );
    expect((await sessionRow("s1"))?.updated_at).toBe(STORE_NOW);
    expect(logs).toEqual([]);
  });

  it("logs a failed chunk with the failed-chunk suffix and leaves the row unsplit", async () => {
    await insertSession(BAD_ID);
    await insertEvent(BAD_ID, OPUS, { ...cacheTokens, cost: 3 });
    await failUpdatesOf("token_events", "session_id");

    await healCacheCostSplit(db.prisma, log);

    expect(
      (await eventCosts(BAD_ID))[0]?.cache_creation_cost_usd_estimated
    ).toBe(null);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(CACHE_SPLIT_CHUNK_FAILED_RE);
    expect(logs[1]).toBe(
      "cache-cost-split heal: re-split 0 row(s) across 0 session(s) (1 chunk(s) failed)"
    );
  });
});

describe("healTokenUsageEventConservation", () => {
  it("logs a failed chunk with the failed-chunk suffix and keeps the divergent aggregate", async () => {
    const aggregateCost = 5;
    await insertSession(BAD_ID);
    await insertUsage(BAD_ID, OPUS, { cost: aggregateCost });
    await insertEvent(BAD_ID, OPUS, { cost: 1 });
    await failUpdatesOf("token_usage", "session_id");

    await healTokenUsageEventConservation(db.prisma, log);

    expect((await usageRow(BAD_ID, OPUS))?.cost_usd_estimated).toBe(
      aggregateCost
    );
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(CONSERVATION_CHUNK_FAILED_RE);
    expect(logs[1]).toBe(
      "token-usage cost-conservation heal: conserved 0 row(s) across 0 session(s) (1 chunk(s) failed)"
    );
  });
});

describe("healSessionLastActivityAtFloor", () => {
  it("reports the failed chunk, heals the other one, and logs the retry notice", async () => {
    const startedAt = "2026-06-20T10:00:00.000Z";
    const preStart = "2026-06-20T09:00:00.000Z";
    await insertSession(GOOD_ID, { startedAt, lastActivityAt: preStart });
    await insertSession(BAD_ID, { startedAt, lastActivityAt: preStart });
    await failUpdatesOf("sessions", "id");

    const result = await healSessionLastActivityAtFloor(
      db.prisma,
      STORE_NOW,
      log,
      1
    );

    expect(result).toEqual({ healed: 1, failedChunks: 1 });
    expect((await sessionRow(GOOD_ID))?.last_activity_at).toBe(startedAt);
    expect((await sessionRow(BAD_ID))?.last_activity_at).toBe(preStart);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(FLOOR_CHUNK_FAILED_RE);
    expect(logs[1]).toBe(
      "last-activity floor heal: 1 chunk(s) failed, will retry next boot"
    );
  });
});
