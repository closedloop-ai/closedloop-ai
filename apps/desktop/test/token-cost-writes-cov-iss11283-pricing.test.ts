/**
 * @file token-cost-writes-cov-iss11283-pricing.test.ts
 * @description ISS-11283: the `token-cost-writes.ts` arms the existing cost
 * suites leave unexercised —
 *   - `persistImportedTokenCosts` pricing an event that carries no timestamp
 *     (the fallback observed-at), an event and a usage row it cannot price at
 *     all (no cost written, a pricing miss reported), a usage row with no
 *     `created_at`, and an explicit EMPTY model filter (no usage row re-priced);
 *   - `chooseConservedUsageCost` refusing the event sum when the usage row and
 *     the series disagree about whether a TTL split was reported;
 *   - `conservationSumsFromRow` reading a NULL cost sum as 0;
 *   - `updateSessionCostRollupBatch` issuing nothing for an empty id set.
 * Driven against a real migrated store (`openTestDb`) — this module's
 * behavior is its SQL.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import {
  TokenSourceIdentityAvailability,
  TokenSourceIdentityUnavailableReason,
} from "@repo/api/src/types/token-cost-provenance";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Harness } from "../src/main/collectors/types.js";
import type { SqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  chooseConservedUsageCost,
  conservationSumsFromRow,
  persistImportedTokenCosts,
  type TokenEventConservationSums,
  updateSessionCostRollupBatch,
} from "../src/main/database/token-cost-writes.js";
import type { PersistedTokenEventRecord } from "../src/main/database/token-event-contract.js";
import { createWriteQueue } from "../src/main/database/write-queue.js";
import { ModelPricingSource } from "../src/main/model-pricing/model-pricing-fixture.js";
import { Observability } from "../src/main/telemetry/observability.js";
import type { EnrichedTelemetryEvent } from "../src/main/telemetry/telemetry-service.js";
import type { EstimateTokenCostResult } from "../src/shared/token-cost.js";
import { openTestDb } from "./agent-db-test-utils.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const SESSION = "iss11283-cost";
const PRICED_MODEL = "claude-haiku-4-5-20251001";
// An empty model id is the one input `estimateTokenCost` refuses outright
// (`unknown_model`, excluded from the unknown-model fallback tier).
const UNPRICEABLE_MODEL = "";
const EVENT_FALLBACK_AT = "2026-06-20T09:00:00.000Z";
const USAGE_OBSERVED_AT = "2026-06-20T10:00:00.000Z";
const STORED_USAGE_COST = 9.99;
const PRICING_MISS_CATEGORY = "token_cost.pricing_miss";
const IMPORTED_SURFACE = "imported_token_costs";
const ROLLUP_SQL = /token_usage|UPDATE sessions/;

type EventCostRow = {
  cost_usd_estimated: number | null;
  input_cost_usd_estimated: number | null;
  output_cost_usd_estimated: number | null;
  cache_read_cost_usd_estimated: number | null;
  cache_creation_cost_usd_estimated: number | null;
  cost_currency: string | null;
  cost_source: string | null;
  cost_observed_at: string | null;
};

type UsageCostRow = {
  model: string;
  cost_usd_estimated: number | null;
  cost_source: string | null;
  cost_observed_at: string | null;
};

function event(
  overrides: Partial<PersistedTokenEventRecord>
): PersistedTokenEventRecord {
  return {
    timestamp: "2026-06-20T08:00:00.000Z",
    model: PRICED_MODEL,
    input: 1000,
    output: 200,
    cacheRead: 0,
    cacheWrite: 0,
    transportId: "transport-1",
    sourceIdentity: {
      availability: TokenSourceIdentityAvailability.Unavailable,
      reason: TokenSourceIdentityUnavailableReason.Malformed,
    },
    ...overrides,
  };
}

async function seedSession(db: SqliteAgentDatabase): Promise<void> {
  await db.run(
    `INSERT INTO sessions (id, status, updated_at, last_activity_at, data_revision)
     VALUES ($1, $3, $2, $2, 1)`,
    SESSION,
    USAGE_OBSERVED_AT,
    SESSION_STATUS.INACTIVE
  );
}

async function seedEventRow(
  db: SqliteAgentDatabase,
  record: PersistedTokenEventRecord
): Promise<void> {
  await db.run(
    `INSERT INTO token_events (session_id, transport_id, model, created_at, input_tokens, output_tokens)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    SESSION,
    record.transportId,
    record.model,
    record.timestamp,
    record.input,
    record.output
  );
}

async function seedUsageRow(
  db: SqliteAgentDatabase,
  model: string,
  createdAt: string | null,
  costUsd: number | null = null
): Promise<void> {
  await db.run(
    `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, created_at, cost_usd_estimated)
     VALUES ($1, $2, 1000, 200, $3, $4)`,
    SESSION,
    model,
    createdAt,
    costUsd
  );
}

async function eventCosts(db: SqliteAgentDatabase): Promise<EventCostRow[]> {
  return await db.prisma.client.$queryRawUnsafe<EventCostRow[]>(
    `SELECT cost_usd_estimated, input_cost_usd_estimated, output_cost_usd_estimated,
            cache_read_cost_usd_estimated, cache_creation_cost_usd_estimated,
            cost_currency, cost_source, cost_observed_at
       FROM token_events WHERE session_id = $1`,
    SESSION
  );
}

async function usageCosts(db: SqliteAgentDatabase): Promise<UsageCostRow[]> {
  return await db.prisma.client.$queryRawUnsafe<UsageCostRow[]>(
    `SELECT model, cost_usd_estimated, cost_source, cost_observed_at
       FROM token_usage WHERE session_id = $1 ORDER BY model`,
    SESSION
  );
}

async function persist(
  db: SqliteAgentDatabase,
  tokenEvents: PersistedTokenEventRecord[],
  tokenUsageModels?: string[]
): Promise<void> {
  await db.prisma.write((client) =>
    client.$transaction((tx) =>
      persistImportedTokenCosts(tx, {
        sessionId: SESSION,
        harness: Harness.Claude,
        tokenUsageObservedAt: USAGE_OBSERVED_AT,
        ...(tokenUsageModels === undefined ? {} : { tokenUsageModels }),
        tokenEvents,
        tokenEventObservedAtFallback: EVENT_FALLBACK_AT,
      })
    )
  );
}

const UNPRICED_EVENT_COSTS: EventCostRow = {
  cost_usd_estimated: null,
  input_cost_usd_estimated: null,
  output_cost_usd_estimated: null,
  cache_read_cost_usd_estimated: null,
  cache_creation_cost_usd_estimated: null,
  cost_currency: null,
  cost_source: null,
  cost_observed_at: null,
};

describe("persistImportedTokenCosts uncovered arms (ISS-11283)", () => {
  let dir: string;
  let db: SqliteAgentDatabase;
  let telemetry: EnrichedTelemetryEvent[];

  beforeEach(async () => {
    Observability.reset();
    telemetry = [];
    Observability.init({ telemetrySend: (sent) => telemetry.push(sent) });
    dir = await mkdtemp(path.join(os.tmpdir(), "iss11283-token-cost-"));
    db = await openTestDb(dir);
    await seedSession(db);
  });

  afterEach(async () => {
    Observability.reset();
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  function pricingMisses() {
    return telemetry
      .filter((sent) => sent.category === PRICING_MISS_CATEGORY)
      .map((sent) => sent.diagnostics?.tokenCostPricingMiss);
  }

  it("prices a timestamp-less event at the fallback observed-at, and re-prices no usage row under an empty model filter", async () => {
    const timeless = event({ timestamp: "", cacheRead: 500, cacheWrite: 300 });
    await seedEventRow(db, timeless);
    await seedUsageRow(db, PRICED_MODEL, USAGE_OBSERVED_AT, STORED_USAGE_COST);

    await persist(db, [timeless], []);

    const [priced] = await eventCosts(db);
    expect(priced?.cost_observed_at).toBe(EVENT_FALLBACK_AT);
    expect(priced?.cost_source).toBe(ModelPricingSource.GenaiPricesV1);
    expect(priced?.cost_usd_estimated).toBeGreaterThan(0);
    // Every per-component cost is written from the estimate, not dropped.
    expect(priced?.input_cost_usd_estimated).toBeGreaterThan(0);
    expect(priced?.output_cost_usd_estimated).toBeGreaterThan(0);
    expect(priced?.cache_read_cost_usd_estimated).toBeGreaterThan(0);
    expect(priced?.cache_creation_cost_usd_estimated).toBeGreaterThan(0);
    // `[]` selects NO model — distinct from an omitted filter, which selects
    // every row — so the stored usage cost is left exactly as it was.
    expect(await usageCosts(db)).toEqual([
      {
        model: PRICED_MODEL,
        cost_usd_estimated: STORED_USAGE_COST,
        cost_source: null,
        cost_observed_at: null,
      },
    ]);
    expect(pricingMisses()).toEqual([]);
  });

  it("writes no cost for an event it cannot price and reports the miss", async () => {
    const unpriceable = event({ model: UNPRICEABLE_MODEL });
    await seedEventRow(db, unpriceable);

    await persist(db, [unpriceable], []);

    expect(await eventCosts(db)).toEqual([UNPRICED_EVENT_COSTS]);
    expect(pricingMisses()).toEqual([
      {
        model: UNPRICEABLE_MODEL,
        reason: "unknown_model",
        surface: IMPORTED_SURFACE,
        sessionId: SESSION,
      },
    ]);
  });

  it("writes no cost for a usage row it cannot price, and stamps a created_at-less row with the usage observed-at", async () => {
    await seedUsageRow(db, UNPRICEABLE_MODEL, USAGE_OBSERVED_AT);
    await seedUsageRow(db, PRICED_MODEL, null);

    await persist(db, []);

    const [unpriced, priced] = await usageCosts(db);
    expect(unpriced).toEqual({
      model: UNPRICEABLE_MODEL,
      cost_usd_estimated: null,
      cost_source: null,
      cost_observed_at: null,
    });
    expect(priced?.model).toBe(PRICED_MODEL);
    expect(priced?.cost_observed_at).toBe(USAGE_OBSERVED_AT);
    expect(priced?.cost_source).toBe(ModelPricingSource.GenaiPricesV1);
    expect(priced?.cost_usd_estimated).toBeGreaterThan(0);
    expect(pricingMisses()).toEqual([
      {
        model: UNPRICEABLE_MODEL,
        reason: "unknown_model",
        surface: IMPORTED_SURFACE,
        sessionId: SESSION,
      },
    ]);
    const sessions = await db.prisma.client.$queryRawUnsafe<
      { cost_usd_estimated: number | null }[]
    >("SELECT cost_usd_estimated FROM sessions WHERE id = $1", SESSION);
    expect(sessions[0]?.cost_usd_estimated).toBe(priced?.cost_usd_estimated);
  });
});

const AGGREGATE: EstimateTokenCostResult = {
  costUsd: 1,
  inputCostUsd: 0.5,
  outputCostUsd: 0.5,
  cacheReadCostUsd: 0,
  cacheWriteCostUsd: 0,
  cacheWriteTtlPremiumUsd: 0,
  unknownModelFallbackApplied: false,
};
const EFFECTIVE = {
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 10,
  cacheWriteTokens: 40,
};

function sums(
  overrides: Partial<TokenEventConservationSums>
): TokenEventConservationSums {
  return {
    ...EFFECTIVE,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    ttlReportedCount: 0,
    costUsd: 2,
    unpricedCount: 0,
    eventCount: 3,
    ...overrides,
  };
}

describe("chooseConservedUsageCost TTL-report parity (ISS-11283)", () => {
  it("keeps the aggregate when the usage row reports a TTL split the series never reported", () => {
    const chosen = chooseConservedUsageCost(
      AGGREGATE,
      EFFECTIVE,
      true,
      sums({ ttlReportedCount: 0 }),
      { fiveM: 0, oneH: 0 }
    );
    expect(chosen).toBe(AGGREGATE);
  });

  it("keeps the aggregate when the series reports a TTL split the usage row does not", () => {
    const chosen = chooseConservedUsageCost(
      AGGREGATE,
      EFFECTIVE,
      true,
      sums({ ttlReportedCount: 2 }),
      { fiveM: null, oneH: null }
    );
    expect(chosen).toBe(AGGREGATE);
  });

  it("takes the event sum once the TTL reports agree (control for the two refusals above)", () => {
    const chosen = chooseConservedUsageCost(
      AGGREGATE,
      EFFECTIVE,
      true,
      sums({
        ttlReportedCount: 2,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
      }),
      { fiveM: 0, oneH: 0 }
    );
    expect(chosen).toEqual({ ...AGGREGATE, costUsd: 2 });
  });
});

describe("conservationSumsFromRow (ISS-11283)", () => {
  it("reads a NULL cost sum as 0 dollars", () => {
    const read = conservationSumsFromRow({
      model: PRICED_MODEL,
      i: 1,
      o: 2,
      cr: 3,
      cw: 4,
      cw5m: 0,
      cw1h: 0,
      ttl_reported: 0,
      cost: null,
      unpriced: 1,
      event_count: 1,
    });
    expect(read.costUsd).toBe(0);
    expect(read.inputTokens).toBe(1);
    expect(read.unpricedCount).toBe(1);
  });

  it("reads a present cost sum as that number (control for the NULL case)", () => {
    const read = conservationSumsFromRow({
      model: PRICED_MODEL,
      i: 1,
      o: 2,
      cr: 3,
      cw: 4,
      cw5m: 0,
      cw1h: 0,
      ttl_reported: 0,
      cost: 1.5,
      unpriced: 0,
      event_count: 1,
    });
    expect(read.costUsd).toBe(1.5);
  });
});

describe("updateSessionCostRollupBatch (ISS-11283)", () => {
  it("issues no rollup statement for an empty id set", async () => {
    const statements: string[] = [];
    const opened = await openTestPrisma(createWriteQueue(), {
      onStatementSettled: (sql) => {
        statements.push(sql);
      },
    });
    try {
      const before = statements.length;
      await opened.prisma.write((client) =>
        client.$transaction((tx) => updateSessionCostRollupBatch(tx, []))
      );
      expect(
        statements.slice(before).filter((sql) => ROLLUP_SQL.test(sql))
      ).toEqual([]);

      // Control: the same capture DOES see the rollup for a non-empty set.
      const withIds = statements.length;
      await opened.prisma.write((client) =>
        client.$transaction((tx) =>
          updateSessionCostRollupBatch(tx, ["no-such-session"])
        )
      );
      expect(
        statements.slice(withIds).some((sql) => ROLLUP_SQL.test(sql))
      ).toBe(true);
    } finally {
      await opened.close();
    }
  });
});
