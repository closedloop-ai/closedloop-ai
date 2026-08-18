import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  TokenCostBasis,
  TokenCostCompleteness,
  TokenCostCompletenessReason,
  TokenSourceIdentityAvailability,
  TokenSourceIdentityUnavailableReason,
} from "@repo/api/src/types/token-cost-provenance";
import { Harness } from "../src/main/collectors/types.js";
import { upsertSessionAnalyticsRollup } from "../src/main/database/session-analytics-rollup.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  healTokenUsageEventConservation,
  repriceUnpricedTokenUsage,
} from "../src/main/database/token-cost-maintenance.js";
import { parseStoredTokenCostSummary } from "../src/main/database/token-event-contract.js";
import { estimateTokenCost } from "../src/shared/token-cost.js";
import { makeSession } from "./normalized-session-test-utils.js";
import { ROLLUP_OPTS } from "./rollup-options-test-utils.js";

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const NOW = "2026-06-21T12:00:00.000Z";

// claude-opus-4-5 @ 1000 input tokens prices to exactly $0.005 (see
// token-cost.test.ts) — the value the boot pass must resolve and persist.
const OPUS_INPUT_TOKENS = 1000;
const OPUS_REPRICED_COST = 0.005;
// A pre-priced row that the pass must leave untouched (it is not NULL).
const PREPRICED_COST = 2;
// FEA-3546: a model genai-prices can't price (`totally-made-up-model-xyz`) is no
// longer left NULL — the boot pass reprices it at the Opus-standard fallback via
// the same `estimateTokenCost` the importer uses. 500 input tokens → $0.0025.
const UNKNOWN_MODEL_INPUT_TOKENS = 500;
const UNKNOWN_MODEL_FALLBACK_COST = (() => {
  const result = estimateTokenCost({
    model: "totally-made-up-model-xyz",
    inputTokens: UNKNOWN_MODEL_INPUT_TOKENS,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  if (!result) {
    throw new Error("expected the unknown-model fallback to produce a cost");
  }
  return result.costUsd;
})();

async function openTempDb(): Promise<{ db: SqliteDb; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "token-usage-reprice-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => NOW,
  });
  return { db, dir };
}

async function insertSession(db: SqliteDb, id: string): Promise<void> {
  await db.run(
    `INSERT INTO sessions (id, status, harness, started_at, updated_at)
     VALUES ($1, $2, $3, $4, $5)`,
    id,
    "completed",
    "claude_code",
    "2026-06-20T08:00:00.000Z",
    NOW
  );
}

async function insertToken(
  db: SqliteDb,
  sessionId: string,
  model: string,
  inputTokens: number,
  cost: number | null
): Promise<void> {
  await db.run(
    `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at, cost_usd_estimated)
     VALUES ($1, $2, $3, 0, 0, 0, $4, $5)`,
    sessionId,
    model,
    inputTokens,
    "2026-06-20T08:00:00.000Z",
    cost
  );
}

async function tokenCost(
  db: SqliteDb,
  sessionId: string,
  model: string
): Promise<number | null> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { cost_usd_estimated: number | null }[]
  >(
    "SELECT cost_usd_estimated FROM token_usage WHERE session_id = $1 AND model = $2",
    sessionId,
    model
  );
  const value = rows[0]?.cost_usd_estimated;
  return value == null ? null : Number(value);
}

async function analyticsCost(
  db: SqliteDb,
  sessionId: string
): Promise<number | null> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { est_cost: number | null }[]
  >("SELECT est_cost FROM session_analytics WHERE session_id = $1", sessionId);
  const value = rows[0]?.est_cost;
  return value == null ? null : Number(value);
}

async function sessionCost(
  db: SqliteDb,
  sessionId: string
): Promise<number | null> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { cost_usd_estimated: number | null }[]
  >("SELECT cost_usd_estimated FROM sessions WHERE id = $1", sessionId);
  const value = rows[0]?.cost_usd_estimated;
  return value == null ? null : Number(value);
}

async function sessionUpdatedAt(
  db: SqliteDb,
  sessionId: string
): Promise<string | null> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { updated_at: string | null }[]
  >("SELECT updated_at FROM sessions WHERE id = $1", sessionId);
  return rows[0]?.updated_at ?? null;
}

test("boot re-pricing prices newly-priceable rows and heals both cost snapshots", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db, "sess-mixed");
    // A model that was unpriceable at import (NULL cost) but the current pricing
    // table now prices; a model genai-prices STILL can't map, now healed by the
    // FEA-3546 Opus-standard fallback (previously left NULL); and a row already
    // priced at import.
    await insertToken(
      db,
      "sess-mixed",
      "claude-opus-4-5",
      OPUS_INPUT_TOKENS,
      null
    );
    await insertToken(
      db,
      "sess-mixed",
      "totally-made-up-model-xyz",
      UNKNOWN_MODEL_INPUT_TOKENS,
      null
    );
    await insertToken(
      db,
      "sess-mixed",
      "claude-sonnet-4-5",
      100,
      PREPRICED_COST
    );

    // Materialize the rollup the way ingest does. est_cost / sessions cost see
    // only the one priced row — the snapshot the dashboard KPI would undercount.
    await db.prisma.write((client) =>
      client.$transaction((tx) =>
        upsertSessionAnalyticsRollup(tx, "sess-mixed", NOW, ROLLUP_OPTS)
      )
    );
    // The analytics rollup sees only the one priced row (the dashboard KPI the
    // bug undercounts). `sessions.cost_usd_estimated` is computed by a separate
    // ingest-time pass this raw-seed test bypasses, so it starts NULL.
    assert.equal(await analyticsCost(db, "sess-mixed"), PREPRICED_COST);
    assert.equal(await sessionCost(db, "sess-mixed"), null);

    const logs: string[] = [];
    await repriceUnpricedTokenUsage(db.prisma, (m) => logs.push(m));

    // Both newly-priceable rows are persisted (the library-priced Opus row AND
    // the FEA-3546 fallback-priced unknown-model row); the pre-priced row is
    // untouched.
    assert.equal(
      await tokenCost(db, "sess-mixed", "claude-opus-4-5"),
      OPUS_REPRICED_COST
    );
    assert.equal(
      await tokenCost(db, "sess-mixed", "totally-made-up-model-xyz"),
      UNKNOWN_MODEL_FALLBACK_COST
    );
    assert.equal(
      await tokenCost(db, "sess-mixed", "claude-sonnet-4-5"),
      PREPRICED_COST
    );

    // Both materialized snapshots now include every re-priced cost, so they agree
    // with the read-time re-pricing surfaces.
    const expected =
      PREPRICED_COST + OPUS_REPRICED_COST + UNKNOWN_MODEL_FALLBACK_COST;
    assert.equal(await analyticsCost(db, "sess-mixed"), expected);
    assert.equal(await sessionCost(db, "sess-mixed"), expected);

    assert.ok(
      logs.some((m) =>
        m.includes("token-usage re-pricing complete: repriced 2 row(s)")
      ),
      `expected completion log, got: ${logs.join(" | ")}`
    );

    // SYNC INVARIANT (FEA-3485): both rebuilt snapshots sync to the cloud as-is
    // (`est_cost` → `estimatedCostUsd`, `sessions.cost_usd_estimated`), so the
    // repriced session's sync watermark advances past the seed `NOW` — an install
    // that already uploaded the stale cost re-syncs the corrected value.
    const bumped = await sessionUpdatedAt(db, "sess-mixed");
    assert.ok(
      (bumped ?? "") > NOW,
      `expected repriced session watermark to advance past ${NOW}, got ${bumped}`
    );

    // Idempotent: a second run finds the row priced (no longer NULL) and changes
    // nothing — including the watermark, which is not re-bumped.
    await repriceUnpricedTokenUsage(db.prisma, () => undefined);
    assert.equal(await analyticsCost(db, "sess-mixed"), expected);
    assert.equal(await sessionCost(db, "sess-mixed"), expected);
    assert.equal(await sessionUpdatedAt(db, "sess-mixed"), bumped);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("boot re-pricing is a no-op when every token_usage row is already priced", async () => {
  const { db, dir } = await openTempDb();
  try {
    await insertSession(db, "sess-priced");
    await insertToken(
      db,
      "sess-priced",
      "claude-sonnet-4-5",
      100,
      PREPRICED_COST
    );

    const logs: string[] = [];
    await repriceUnpricedTokenUsage(db.prisma, (m) => logs.push(m));

    assert.equal(
      await tokenCost(db, "sess-priced", "claude-sonnet-4-5"),
      PREPRICED_COST
    );
    // No NULL rows → the pass returns before emitting a completion log.
    assert.equal(logs.length, 0);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("boot re-pricing refreshes local legacy evidence and preserves producer unavailable evidence", async () => {
  const { db, dir } = await openTempDb();
  const sessionId = "sess-source-identity-reprice";
  const producerSummary = {
    completeness: TokenCostCompleteness.Unavailable,
    reason: TokenCostCompletenessReason.SourceIdentityUnavailable,
  } as const;
  try {
    await db.importer.importSession(
      makeSession({
        sessionId,
        model: "claude-opus-4-5",
        tokensByModel: {
          "claude-opus-4-5": {
            input: OPUS_INPUT_TOKENS * 2,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
        tokenSeries: [
          {
            transportId: "local-unavailable",
            timestamp: "2026-06-20T08:00:00.000Z",
            model: "claude-opus-4-5",
            input: OPUS_INPUT_TOKENS,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          {
            transportId: "producer-summary",
            timestamp: "2026-06-20T08:01:00.000Z",
            model: "claude-opus-4-5",
            input: OPUS_INPUT_TOKENS,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            sourceIdentity: {
              availability: TokenSourceIdentityAvailability.Unavailable,
              reason:
                TokenSourceIdentityUnavailableReason.MissingSourceRecordId,
            },
            costSummary: producerSummary,
          },
        ],
      }),
      Harness.Claude
    );
    await db.prisma.write((client) =>
      client.$executeRawUnsafe(
        `UPDATE token_usage
            SET cost_usd_estimated = NULL, cost_currency = NULL,
                cost_source = NULL, cost_observed_at = NULL
          WHERE session_id = $1`,
        sessionId
      )
    );
    await db.prisma.write((client) =>
      client.$executeRawUnsafe(
        `UPDATE token_events
            SET cost_usd_estimated = NULL,
                input_cost_usd_estimated = NULL,
                output_cost_usd_estimated = NULL,
                cache_read_cost_usd_estimated = NULL,
                cache_creation_cost_usd_estimated = NULL,
                cost_currency = NULL, cost_source = NULL, cost_observed_at = NULL
          WHERE session_id = $1`,
        sessionId
      )
    );

    await repriceUnpricedTokenUsage(db.prisma, () => undefined);

    const rows = await db.prisma.client.$queryRawUnsafe<
      { transport_id: string; cost_summary: string }[]
    >(
      `SELECT transport_id, cost_summary
         FROM token_events
        WHERE session_id = $1
        ORDER BY transport_id`,
      sessionId
    );
    const localSummary = parseStoredTokenCostSummary(rows[0]?.cost_summary);
    assert.deepEqual(localSummary, {
      completeness: TokenCostCompleteness.Partial,
      reason: TokenCostCompletenessReason.LegacyRecord,
      subtotalUsd: OPUS_REPRICED_COST,
      lanes: [
        {
          basis: TokenCostBasis.ApiEstimated,
          subtotalUsd: OPUS_REPRICED_COST,
        },
      ],
    });
    assert.deepEqual(
      JSON.parse(rows[1]?.cost_summary ?? "null"),
      producerSummary
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("boot re-pricing spans multiple chunks across sessions", async () => {
  const { db, dir } = await openTempDb();
  try {
    const sessionIds = ["sess-a", "sess-b", "sess-c"];
    for (const id of sessionIds) {
      await insertSession(db, id);
      await insertToken(db, id, "claude-opus-4-5", OPUS_INPUT_TOKENS, null);
      await db.prisma.write((client) =>
        client.$transaction((tx) =>
          upsertSessionAnalyticsRollup(tx, id, NOW, ROLLUP_OPTS)
        )
      );
    }

    // chunkSize=1 forces one transaction per session, exercising the loop
    // boundary the default 500-chunk path never hits in test.
    await repriceUnpricedTokenUsage(db.prisma, () => undefined, 1);

    for (const id of sessionIds) {
      assert.equal(
        await tokenCost(db, id, "claude-opus-4-5"),
        OPUS_REPRICED_COST
      );
      assert.equal(await analyticsCost(db, id), OPUS_REPRICED_COST);
      assert.equal(await sessionCost(db, id), OPUS_REPRICED_COST);
    }
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ── FEA-3232 conservation tests ──────────────────────────────────────────────

async function tokenEventSum(db: SqliteDb, sessionId: string): Promise<number> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { event_sum: number | null }[]
  >(
    "SELECT COALESCE(SUM(cost_usd_estimated), 0) AS event_sum FROM token_events WHERE session_id = $1",
    sessionId
  );
  return Number(rows[0]?.event_sum ?? 0);
}

async function tokenCostObservedAt(
  db: SqliteDb,
  sessionId: string,
  model: string
): Promise<string | null> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { cost_observed_at: string | null }[]
  >(
    "SELECT cost_observed_at FROM token_usage WHERE session_id = $1 AND model = $2",
    sessionId,
    model
  );
  return rows[0]?.cost_observed_at ?? null;
}

test("FEA-3232: repriceUnpricedTokenUsage for tiered model applies conservation, not aggregate-tier price", async () => {
  const { db, dir } = await openTempDb();
  try {
    const sessionId = "sess-reprice-conserve";
    const model = "gpt-5.4";

    // Three 100K-input events: each below the 272K grand-total threshold
    // (base tier), aggregate = 300K which crosses into tier-2. After import the
    // conservation fix already stores the event sum. Nulling the cost forces
    // repriceUnpricedTokenUsage to recompute — and it must apply conservation
    // rather than the raw aggregate-tier price.
    const perEventCostUsd = (() => {
      const r = estimateTokenCost({
        model,
        inputTokens: 100_000,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      if (!r) {
        throw new Error(`${model} not priced`);
      }
      return r.costUsd;
    })();

    const aggregateCostUsd = (() => {
      const r = estimateTokenCost({
        model,
        inputTokens: 300_000,
        outputTokens: 300,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      if (!r) {
        throw new Error(`${model} aggregate not priced`);
      }
      return r.costUsd;
    })();

    assert.ok(
      3 * perEventCostUsd < aggregateCostUsd,
      "test requires aggregate tier-2 > event sum"
    );

    const session = makeSession({
      sessionId,
      model,
      tokensByModel: {
        [model]: { input: 300_000, output: 300, cacheRead: 0, cacheWrite: 0 },
      },
      tokenSeries: [
        {
          timestamp: "2026-06-20T08:00:00.000Z",
          model,
          input: 100_000,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
        },
        {
          timestamp: "2026-06-20T08:01:00.000Z",
          model,
          input: 100_000,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
        },
        {
          timestamp: "2026-06-20T08:02:00.000Z",
          model,
          input: 100_000,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
        },
      ],
    });

    await db.importer.importSession(session, Harness.Claude);

    // Capture the event sum before nulling the usage cost (event rows keep
    // their own costs — only token_usage is reset to simulate a pre-priced hole).
    const dbEventSum = await tokenEventSum(db, sessionId);

    // NULL the usage cost to trigger the reprice pass.
    await db.prisma.write((client) =>
      client.$executeRawUnsafe(
        "UPDATE token_usage SET cost_usd_estimated = NULL, cost_observed_at = NULL WHERE session_id = $1 AND model = $2",
        sessionId,
        model
      )
    );

    const logs: string[] = [];
    await repriceUnpricedTokenUsage(db.prisma, (m) => logs.push(m));

    // Conservation must apply: stored cost = event sum, not aggregate tier-2.
    const storedCost = await tokenCost(db, sessionId, model);
    assert.ok(storedCost !== null, "cost must be set after reprice");
    assert.equal(
      storedCost,
      dbEventSum,
      `repriced cost (${storedCost}) must equal event sum (${dbEventSum}), not aggregate (${aggregateCostUsd})`
    );
    assert.ok(
      storedCost < aggregateCostUsd,
      "repriced cost must be less than aggregate tier-2"
    );

    // Both cost snapshots must also be updated.
    assert.equal(
      await analyticsCost(db, sessionId),
      dbEventSum,
      "session_analytics.est_cost must reflect conservation"
    );
    assert.equal(
      await sessionCost(db, sessionId),
      dbEventSum,
      "sessions.cost_usd_estimated must reflect conservation"
    );

    // Convergence guard: second run must leave cost_observed_at unchanged
    // because storedCost === conserved value → the write is skipped.
    const observedAt1 = await tokenCostObservedAt(db, sessionId, model);
    assert.ok(observedAt1, "cost_observed_at must be set after first reprice");

    const logs2: string[] = [];
    await repriceUnpricedTokenUsage(db.prisma, (m) => logs2.push(m));

    assert.equal(logs2.length, 0, "second reprice must be a no-op");
    const observedAt2 = await tokenCostObservedAt(db, sessionId, model);
    assert.equal(
      observedAt2,
      observedAt1,
      "cost_observed_at must be unchanged after no-op reprice (convergence guard)"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3232: baseline_input > 0 count mismatch blocks conservation in reprice and heal passes", async () => {
  const { db, dir } = await openTempDb();
  try {
    const sessionId = "sess-baseline-reprice";
    const model = "gpt-5.4";

    // Import a single 100K-input event. After import the row has
    // input_tokens=100K, baseline_input=0, cost = base-tier estimate.
    // Then we simulate a compacted session: set baseline_input=200K so the
    // effective total becomes 300K (> 272K → tier-2 aggregate), but events
    // only cover 100K. The count mismatch (e.i ≠ u.input + u.baseline) must
    // block conservation in both the reprice and the heal passes.
    const session = makeSession({
      sessionId,
      model,
      tokensByModel: {
        [model]: {
          input: 100_000,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
      tokenSeries: [
        {
          timestamp: "2026-06-20T08:00:00.000Z",
          model,
          input: 100_000,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
        },
      ],
    });

    await db.importer.importSession(session, Harness.Claude);

    // Simulate a compacted session: set baseline_input so effective = 300K,
    // and NULL cost_usd_estimated so the reprice pass re-prices from scratch.
    const aggregateEffectiveCost = (() => {
      const r = estimateTokenCost({
        model,
        inputTokens: 300_000,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      if (!r) {
        throw new Error(`${model} effective not priced`);
      }
      return r.costUsd;
    })();

    await db.prisma.write((client) =>
      client.$executeRawUnsafe(
        `UPDATE token_usage
             SET baseline_input = 200000,
                 cost_usd_estimated = NULL,
                 cost_observed_at = NULL
           WHERE session_id = $1 AND model = $2`,
        sessionId,
        model
      )
    );

    // ── reprice pass: effective-total aggregate (no conservation) ──
    await repriceUnpricedTokenUsage(db.prisma, () => undefined);

    const repricedCost = await tokenCost(db, sessionId, model);
    assert.equal(
      repricedCost,
      aggregateEffectiveCost,
      `reprice must use effective-total aggregate (${aggregateEffectiveCost}), not event-only sum`
    );

    // ── heal pass: count mismatch blocks it ──
    const costBeforeHeal = repricedCost;
    await healTokenUsageEventConservation(db.prisma, () => undefined);

    assert.equal(
      await tokenCost(db, sessionId, model),
      costBeforeHeal,
      "heal must not change cost when event sum does not cover effective counts"
    );

    // ── write-stable: repeated runs keep the same value ──
    await repriceUnpricedTokenUsage(db.prisma, () => undefined);
    assert.equal(
      await tokenCost(db, sessionId, model),
      costBeforeHeal,
      "second reprice must be a no-op (convergence guard)"
    );

    await healTokenUsageEventConservation(db.prisma, () => undefined);
    assert.equal(
      await tokenCost(db, sessionId, model),
      costBeforeHeal,
      "second heal must be a no-op"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3232: pricing-table upgrade reprices NULL event rows so conservation applies, not the aggregate tier", async () => {
  const { db, dir } = await openTempDb();
  try {
    const sessionId = "sess-table-upgrade";
    const model = "gpt-5.4";

    // Three 100K-input events: each below the 272K per-request threshold, the
    // 300K aggregate above it — the shape where aggregate-only pricing
    // overcharges. Import prices everything; NULLing every cost column
    // afterwards simulates a session imported while the model was UNKNOWN to
    // the pricing table (usage AND events NULL) that a table upgrade has now
    // made priceable.
    const session = makeSession({
      sessionId,
      model,
      tokensByModel: {
        [model]: { input: 300_000, output: 300, cacheRead: 0, cacheWrite: 0 },
      },
      tokenSeries: [
        {
          timestamp: "2026-06-20T08:00:00.000Z",
          model,
          input: 100_000,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
        },
        {
          timestamp: "2026-06-20T08:01:00.000Z",
          model,
          input: 100_000,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
        },
        {
          timestamp: "2026-06-20T08:02:00.000Z",
          model,
          input: 100_000,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
        },
      ],
    });
    await db.importer.importSession(session, Harness.Claude);

    const conservedCost = await tokenEventSum(db, sessionId);
    assert.ok(conservedCost > 0, "import must price the event series");

    await db.prisma.write((client) =>
      client.$executeRawUnsafe(
        `UPDATE token_usage SET cost_usd_estimated = NULL, cost_currency = NULL,
                cost_source = NULL, cost_observed_at = NULL
          WHERE session_id = $1`,
        sessionId
      )
    );
    await db.prisma.write((client) =>
      client.$executeRawUnsafe(
        `UPDATE token_events SET cost_usd_estimated = NULL,
                input_cost_usd_estimated = NULL, output_cost_usd_estimated = NULL,
                cache_read_cost_usd_estimated = NULL,
                cache_creation_cost_usd_estimated = NULL, cost_currency = NULL,
                cost_source = NULL, cost_observed_at = NULL
          WHERE session_id = $1`,
        sessionId
      )
    );

    await repriceUnpricedTokenUsage(db.prisma, () => undefined);

    // Event rows must be repriced per-request (base tier), and the usage row
    // must conserve to their sum — NOT the >272K aggregate-tier price the
    // pre-review reprice would have stored.
    const eventSumAfter = await tokenEventSum(db, sessionId);
    assert.equal(
      eventSumAfter,
      conservedCost,
      "reprice must restore the per-request event prices"
    );
    const unpriced = await db.prisma.client.$queryRawUnsafe<
      { cnt: number | bigint }[]
    >(
      "SELECT COUNT(*) AS cnt FROM token_events WHERE session_id = $1 AND cost_usd_estimated IS NULL",
      sessionId
    );
    assert.equal(Number(unpriced[0]?.cnt ?? -1), 0, "no event row stays NULL");

    const aggregate = estimateTokenCost({
      model,
      inputTokens: 300_000,
      outputTokens: 300,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    assert.ok(aggregate, "aggregate must price");
    assert.equal(
      await tokenCost(db, sessionId, model),
      conservedCost,
      "usage row must conserve to the event sum"
    );
    assert.ok(
      conservedCost < aggregate.costUsd,
      "conserved value must undercut the aggregate tier-2 price"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
