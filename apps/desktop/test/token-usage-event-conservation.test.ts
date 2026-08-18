/**
 * @file token-usage-event-conservation.test.ts
 * @description FEA-3232: Conservation of token_usage.cost_usd_estimated to the
 * sum of per-request token_events prices. Pre-fix, one aggregate calcPrice call
 * landed tiered models in the long-context tier for the whole session even when
 * no individual request crossed it. These tests prove the fix is correct at every
 * layer: import path, live-hook two-append path, fail-closed branches, and the
 * boot heal pass.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Harness } from "../src/main/collectors/types.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { healTokenUsageEventConservation } from "../src/main/database/token-cost-maintenance.js";
import { estimateTokenCost } from "../src/shared/token-cost.js";
import { makeSession } from "./normalized-session-test-utils.js";

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

// Fixed db clock so sessions.updated_at is a known value before the heal bumps
// it to real-wall-clock time (healTokenUsageEventConservation uses new Date()).
const DB_NOW = "2026-06-21T12:00:00.000Z";

// Token counts used across scenarios. 100K uncached input per event puts each
// gpt-5.4 request below the 272K grand-total threshold (base tier). Three such
// events aggregate to 300K, which crosses into tier-2 — the overpricing FEA-3232
// corrects.
const PER_EVENT = {
  input: 100_000,
  output: 100,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

// ── helpers ──────────────────────────────────────────────────────────────────

async function openTempDb(opts?: {
  extractTranscript?: Parameters<
    typeof openSqliteAgentDatabase
  >[0]["extractTranscript"];
  now?: () => string;
}): Promise<{ db: SqliteDb; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "conservation-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: opts?.now ?? (() => DB_NOW),
    extractTranscript: opts?.extractTranscript,
  });
  return { db, dir };
}

async function tokenUsageCost(
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
  const v = rows[0]?.cost_usd_estimated;
  return v == null ? null : Number(v);
}

async function sessionCost(
  db: SqliteDb,
  sessionId: string
): Promise<number | null> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { cost_usd_estimated: number | null }[]
  >("SELECT cost_usd_estimated FROM sessions WHERE id = $1", sessionId);
  const v = rows[0]?.cost_usd_estimated;
  return v == null ? null : Number(v);
}

async function analyticsCost(
  db: SqliteDb,
  sessionId: string
): Promise<number | null> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { est_cost: number | null }[]
  >("SELECT est_cost FROM session_analytics WHERE session_id = $1", sessionId);
  const v = rows[0]?.est_cost;
  return v == null ? null : Number(v);
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

/** Sum of token_events.cost_usd_estimated for a session — what the conservation
 * SQL reads when choosing whether to override the aggregate estimate. */
async function tokenEventSum(db: SqliteDb, sessionId: string): Promise<number> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { event_sum: number | null }[]
  >(
    "SELECT COALESCE(SUM(cost_usd_estimated), 0) AS event_sum FROM token_events WHERE session_id = $1",
    sessionId
  );
  return Number(rows[0]?.event_sum ?? 0);
}

function price(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0
): number {
  const result = estimateTokenCost({
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  });
  if (!result) {
    throw new Error(`${model} not priced for ${inputTokens} input tokens`);
  }
  return result.costUsd;
}

// ── scenario 1 ───────────────────────────────────────────────────────────────

test("tiered multi-event import: conservation uses Σ(per-event base-tier prices), not aggregate tier-2 price", async () => {
  const { db, dir } = await openTempDb();
  try {
    const sessionId = "sess-conservation-import";
    const model = "gpt-5.4";

    const perEventCostUsd = price(model, PER_EVENT.input, PER_EVENT.output);
    const aggregateCostUsd = price(model, 300_000, 300);

    // Test must be meaningful: aggregate crosses into tier-2 and exceeds event sum.
    assert.ok(
      3 * perEventCostUsd < aggregateCostUsd,
      `Expected 3×perEventCost (${3 * perEventCostUsd}) < aggregate (${aggregateCostUsd})`
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
          ...PER_EVENT,
        },
        {
          timestamp: "2026-06-20T08:01:00.000Z",
          model,
          ...PER_EVENT,
        },
        {
          timestamp: "2026-06-20T08:02:00.000Z",
          model,
          ...PER_EVENT,
        },
      ],
    });

    await db.importer.importSession(session, Harness.Claude);

    // Conservation must store the event-series sum, not the aggregate price.
    const dbEventSum = await tokenEventSum(db, sessionId);
    const storedCost = await tokenUsageCost(db, sessionId, model);
    assert.ok(storedCost !== null, "token_usage.cost must be set");
    assert.equal(
      storedCost,
      dbEventSum,
      `token_usage.cost (${storedCost}) must equal DB event sum (${dbEventSum})`
    );
    assert.ok(
      storedCost < aggregateCostUsd,
      `token_usage.cost (${storedCost}) must be less than aggregate tier-2 (${aggregateCostUsd})`
    );

    // Both cost snapshots must cascade to the conserved value.
    const sess = await sessionCost(db, sessionId);
    assert.equal(
      sess,
      dbEventSum,
      `sessions.cost_usd_estimated (${sess}) must equal event sum (${dbEventSum})`
    );
    const analytics = await analyticsCost(db, sessionId);
    assert.equal(
      analytics,
      dbEventSum,
      `session_analytics.est_cost (${analytics}) must equal event sum (${dbEventSum})`
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ── scenario 2 ───────────────────────────────────────────────────────────────

test("single event over 272K: event sum equals aggregate (both tier-2), conservation trivially satisfied", async () => {
  const { db, dir } = await openTempDb();
  try {
    const sessionId = "sess-single-large-event";
    const model = "gpt-5.4";

    // 280K grand total puts a single request in tier-2. Conservation holds
    // trivially because the one event IS the full series — sum === aggregate.
    const expectedCostUsd = price(model, 280_000, 100);

    const session = makeSession({
      sessionId,
      model,
      tokensByModel: {
        [model]: {
          input: 280_000,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
      tokenSeries: [
        {
          timestamp: "2026-06-20T08:00:00.000Z",
          model,
          input: 280_000,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
        },
      ],
    });

    await db.importer.importSession(session, Harness.Claude);

    const storedCost = await tokenUsageCost(db, sessionId, model);
    assert.equal(storedCost, expectedCostUsd);

    // Event sum and stored cost must agree (no divergence to conserve away).
    const dbEventSum = await tokenEventSum(db, sessionId);
    assert.equal(storedCost, dbEventSum);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ── scenario 3 ───────────────────────────────────────────────────────────────

test("flat-rate model: Σ(events) equals aggregate within epsilon, conservation keeps aggregate unchanged", async () => {
  const { db, dir } = await openTempDb();
  try {
    const sessionId = "sess-flat-rate-codex";
    const model = "gpt-5-codex";

    // gpt-5-codex has linear (non-tiered) pricing: Σ(2×100K) = cost(200K).
    // The conservation epsilon check sees |sum - aggregate| ≤ eps → keeps aggregate.
    const aggregateCostUsd = price(model, 200_000, 200);
    const perEventCostUsd = price(model, 100_000, 100);

    // Confirm the two values are within the conservation epsilon (1e-9 × max).
    const eps =
      1e-9 *
      Math.max(1, Math.abs(aggregateCostUsd), Math.abs(2 * perEventCostUsd));
    assert.ok(
      Math.abs(aggregateCostUsd - 2 * perEventCostUsd) <= eps,
      "Expected aggregate ≈ 2×per-event within eps for flat-rate model"
    );

    const session = makeSession({
      sessionId,
      model,
      tokensByModel: {
        [model]: { input: 200_000, output: 200, cacheRead: 0, cacheWrite: 0 },
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
      ],
    });

    await db.importer.importSession(session, Harness.Claude);

    // The epsilon fallback keeps the aggregate estimate bit-for-bit unchanged.
    const storedCost = await tokenUsageCost(db, sessionId, model);
    assert.equal(
      storedCost,
      aggregateCostUsd,
      "flat-rate model must keep aggregate (conservation epsilon fallback)"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ── scenario 4 ───────────────────────────────────────────────────────────────

test("live-hook two-append: second append reads full persisted event series, not just the newly appended subset", async () => {
  // `processEvent` is the CLAUDE-ONLY hook path (`HookHarness` is the literal
  // "claude"; Codex hooks were removed in PRD-431), so the session is attributed
  // to Claude. Pricing is per-MODEL and billing mode is fixed to "api" here, so
  // the harness label does not participate in the conservation math under test.
  const model = "gpt-5.4";
  const T1 = "2026-06-20T08:00:00.000Z";
  const T2 = "2026-06-20T08:01:00.000Z";

  // 150K per event keeps each request below the 272K threshold (base tier).
  // Two events aggregate to 300K which crosses into tier-2.
  const perEventCostUsd = price(model, 150_000, 100);
  const aggregateCostUsd = price(model, 300_000, 200);

  assert.ok(
    2 * perEventCostUsd < aggregateCostUsd,
    `Expected 2×perEventCost (${2 * perEventCostUsd}) < aggregate tier-2 (${aggregateCostUsd})`
  );

  // Mutable records array: the extractTranscript closure reads its current
  // state on each call, so processEvent sees the accumulated records.
  const records: {
    timestamp: string;
    model: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  }[] = [
    {
      timestamp: T1,
      model,
      input: 150_000,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
    },
  ];

  let hookNow = "2026-06-20T09:00:00.000Z";

  const { db, dir } = await openTempDb({
    now: () => hookNow,
    extractTranscript: () => ({
      tokensByModel: new Map([
        [
          model,
          records.reduce(
            (acc, r) => ({
              input: acc.input + r.input,
              output: acc.output + r.output,
              cacheRead: acc.cacheRead + r.cacheRead,
              cacheWrite: acc.cacheWrite + r.cacheWrite,
            }),
            { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
          ),
        ],
      ]),
      latestModel: model,
      compactionCount: 0,
      records,
      hasTrailingApiError: false,
    }),
  });

  try {
    const sessionId = "sess-two-append";

    // First append: 1 event at 150K. aggregate(150K) ≈ event_sum(150K) → within
    // epsilon for this single-event case → aggregate kept (base tier).
    await db.processEvent(
      "PostToolUse",
      {
        session_id: sessionId,
        session_name: "two-append conservation test",
        cwd: "/workspace/two-append",
        model,
        transcript_path: "/tmp/two-append.jsonl",
      },
      Harness.Claude
    );

    const costAfterFirst = await tokenUsageCost(db, sessionId, model);
    assert.ok(costAfterFirst !== null, "cost must be set after first append");

    // Second append: push a new event (T2 > T1 so HWM filter admits it).
    // appendTokenEvents inserts only T2; persistImportedTokenCosts receives
    // only [T2], but selectTokenEventConservationSums reads T1+T2 from the store.
    records.push({
      timestamp: T2,
      model,
      input: 150_000,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
    });
    hookNow = "2026-06-20T09:01:00.000Z";

    await db.processEvent(
      "PostToolUse",
      {
        session_id: sessionId,
        session_name: "two-append conservation test",
        cwd: "/workspace/two-append",
        model,
        transcript_path: "/tmp/two-append.jsonl",
      },
      Harness.Claude
    );

    // Conservation must apply against the FULL two-event series, yielding
    // 2×base-tier price — NOT the aggregate tier-2 price that a naive reprice
    // of the 300K effective total would produce.
    const costAfterSecond = await tokenUsageCost(db, sessionId, model);
    const dbEventSum = await tokenEventSum(db, sessionId);

    assert.ok(costAfterSecond !== null, "cost must be set after second append");
    assert.equal(
      costAfterSecond,
      dbEventSum,
      `token_usage.cost (${costAfterSecond}) must equal DB event sum (${dbEventSum})`
    );
    assert.ok(
      costAfterSecond < aggregateCostUsd,
      `token_usage.cost (${costAfterSecond}) must be less than aggregate tier-2 (${aggregateCostUsd})`
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ── scenario 5 ───────────────────────────────────────────────────────────────

test("fail-closed branches: unpriced event, count mismatch, and OTel source each prevent heal", async () => {
  const model = "gpt-5.4";
  const aggregateCostUsd = price(model, 300_000, 300);

  // ── 5a: one event with NULL cost → heal skips (unpriced events in series) ──
  {
    const { db, dir } = await openTempDb();
    try {
      const sessionId = "sess-null-event-cost";
      const session = makeSession({
        sessionId,
        model,
        tokensByModel: {
          [model]: {
            input: 300_000,
            output: 300,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
        tokenSeries: [
          {
            timestamp: "2026-06-20T08:00:00.000Z",
            model,
            ...PER_EVENT,
          },
          {
            timestamp: "2026-06-20T08:01:00.000Z",
            model,
            ...PER_EVENT,
          },
          {
            timestamp: "2026-06-20T08:02:00.000Z",
            model,
            ...PER_EVENT,
          },
        ],
      });
      await db.importer.importSession(session, Harness.Claude);

      // Revert token_usage to a "pre-fix" aggregate cost so the heal WOULD
      // trigger — but can't because we also NULL one event's price.
      await db.prisma.write((client) =>
        client.$executeRawUnsafe(
          "UPDATE token_usage SET cost_usd_estimated = $1 WHERE session_id = $2 AND model = $3",
          aggregateCostUsd,
          sessionId,
          model
        )
      );
      await db.prisma.write((client) =>
        client.$executeRawUnsafe(
          "UPDATE token_events SET cost_usd_estimated = NULL WHERE session_id = $1 AND created_at = $2",
          sessionId,
          "2026-06-20T08:00:00.000Z"
        )
      );

      const logs: string[] = [];
      await healTokenUsageEventConservation(db.prisma, (m) => logs.push(m));

      // Heal must skip: unpriced event → e.unpriced = 1 → QUALIFIES predicate fails.
      assert.equal(
        await tokenUsageCost(db, sessionId, model),
        aggregateCostUsd,
        "5a: token_usage.cost must remain at aggregate (heal skipped)"
      );
      assert.equal(logs.length, 0, "5a: no heal log when nothing qualifies");
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ── 5b: baseline_input > 0 creates count mismatch → heal skips ──
  {
    const { db, dir } = await openTempDb();
    try {
      const sessionId = "sess-baseline-mismatch";
      // Import a single-event session (100K). After import conservation is
      // trivially satisfied (one event = aggregate). Then bump baseline_input
      // so effective = 300K while events only cover 100K.
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
            ...PER_EVENT,
          },
        ],
      });
      await db.importer.importSession(session, Harness.Claude);

      // Set baseline_input so effective = 300K (> 272K → tier-2 aggregate),
      // then store the tier-2 aggregate so there is a divergence to potentially
      // heal — except the count mismatch blocks it.
      await db.prisma.write((client) =>
        client.$executeRawUnsafe(
          `UPDATE token_usage
               SET baseline_input = 200000,
                   cost_usd_estimated = $1
             WHERE session_id = $2 AND model = $3`,
          aggregateCostUsd,
          sessionId,
          model
        )
      );

      const logs: string[] = [];
      await healTokenUsageEventConservation(db.prisma, (m) => logs.push(m));

      // Heal must skip: e.i (100K events) ≠ u.input_tokens + u.baseline_input
      // (100K + 200K = 300K) → QUALIFIES predicate fails.
      assert.equal(
        await tokenUsageCost(db, sessionId, model),
        aggregateCostUsd,
        "5b: token_usage.cost must remain at aggregate (count mismatch)"
      );
      assert.equal(logs.length, 0, "5b: no heal log on count mismatch");
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  }

  // ── 5c: OTel-sourced row is excluded from parity filter → heal skips ──
  {
    const { db, dir } = await openTempDb();
    try {
      const sessionId = "sess-otel-source";
      // Import a 3-event session so the token_events table is fully priced,
      // then flip usage_source to 'otel_log_payload' and store the aggregate
      // as the token_usage cost. The heal excludes OTel rows entirely.
      const session = makeSession({
        sessionId,
        model,
        tokensByModel: {
          [model]: {
            input: 300_000,
            output: 300,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
        tokenSeries: [
          { timestamp: "2026-06-20T08:00:00.000Z", model, ...PER_EVENT },
          { timestamp: "2026-06-20T08:01:00.000Z", model, ...PER_EVENT },
          { timestamp: "2026-06-20T08:02:00.000Z", model, ...PER_EVENT },
        ],
      });
      await db.importer.importSession(session, Harness.Claude);

      await db.prisma.write((client) =>
        client.$executeRawUnsafe(
          `UPDATE token_usage
               SET usage_source = 'otel_log_payload',
                   cost_usd_estimated = $1
             WHERE session_id = $2 AND model = $3`,
          aggregateCostUsd,
          sessionId,
          model
        )
      );

      const logs: string[] = [];
      await healTokenUsageEventConservation(db.prisma, (m) => logs.push(m));

      // Heal must skip: TOKEN_USAGE_EVENT_PARITY_SOURCE_FILTER excludes
      // otel_log_payload rows from the candidate JOIN.
      assert.equal(
        await tokenUsageCost(db, sessionId, model),
        aggregateCostUsd,
        "5c: OTel row must be untouched by heal"
      );
      assert.equal(logs.length, 0, "5c: no heal log for OTel row");
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
});

// ── scenario 6 + 7 ───────────────────────────────────────────────────────────

test("boot heal corrects divergent rows, cascades to sessions and session_analytics, and is idempotent", async () => {
  const { db, dir } = await openTempDb();
  try {
    const sessionId = "sess-heal-e2e";
    const model = "gpt-5.4";

    const aggregateCostUsd = price(model, 300_000, 300);

    const session = makeSession({
      sessionId,
      model,
      tokensByModel: {
        [model]: { input: 300_000, output: 300, cacheRead: 0, cacheWrite: 0 },
      },
      tokenSeries: [
        { timestamp: "2026-06-20T08:00:00.000Z", model, ...PER_EVENT },
        { timestamp: "2026-06-20T08:01:00.000Z", model, ...PER_EVENT },
        { timestamp: "2026-06-20T08:02:00.000Z", model, ...PER_EVENT },
      ],
    });

    await db.importer.importSession(session, Harness.Claude);

    // Capture the event-sum from the DB — this is what the heal must restore.
    const dbEventSum = await tokenEventSum(db, sessionId);
    assert.ok(dbEventSum > 0, "event sum must be positive after import");

    // Simulate the pre-fix state: revert both cost snapshots to the aggregate
    // tier-2 value so the heal has something to correct.
    await db.prisma.write((client) =>
      client.$executeRawUnsafe(
        "UPDATE token_usage SET cost_usd_estimated = $1 WHERE session_id = $2 AND model = $3",
        aggregateCostUsd,
        sessionId,
        model
      )
    );
    await db.prisma.write((client) =>
      client.$executeRawUnsafe(
        "UPDATE sessions SET cost_usd_estimated = $1 WHERE id = $2",
        aggregateCostUsd,
        sessionId
      )
    );
    // (session_analytics.est_cost also needs resetting so the cascade assertion
    // is meaningful — leave it at its post-import value to make the cascade
    // unconditionally clear: after heal it must match the event sum.)

    const preHealUpdatedAt = await sessionUpdatedAt(db, sessionId);
    assert.ok(preHealUpdatedAt, "sessions.updated_at must be set before heal");

    const logs: string[] = [];
    await healTokenUsageEventConservation(db.prisma, (m) => logs.push(m));

    // ── conservation applied ──
    const storedCost = await tokenUsageCost(db, sessionId, model);
    assert.equal(
      storedCost,
      dbEventSum,
      `token_usage.cost (${storedCost}) must be healed to event sum (${dbEventSum})`
    );
    assert.ok(
      storedCost < aggregateCostUsd,
      "healed cost must be less than aggregate tier-2"
    );

    // ── cascade: sessions and session_analytics ──
    const sessAfterHeal = await sessionCost(db, sessionId);
    assert.equal(
      sessAfterHeal,
      dbEventSum,
      "sessions.cost_usd_estimated must cascade to event sum"
    );
    const analyticsAfterHeal = await analyticsCost(db, sessionId);
    assert.equal(
      analyticsAfterHeal,
      dbEventSum,
      "session_analytics.est_cost must cascade to event sum"
    );

    // ── scenario 7: tokenUsage.getBySession also sees the corrected cost ──
    const usageRows = await db.prisma.client.$queryRawUnsafe<
      { cost_usd_estimated: number | null }[]
    >(
      "SELECT cost_usd_estimated FROM token_usage WHERE session_id = $1 AND model = $2",
      sessionId,
      model
    );
    assert.equal(
      Number(usageRows[0]?.cost_usd_estimated),
      dbEventSum,
      "direct token_usage read must see the corrected conservation value"
    );

    // ── sessions.updated_at bumped in ISO 'T' form ──
    const postHealUpdatedAt1 = await sessionUpdatedAt(db, sessionId);
    assert.ok(
      postHealUpdatedAt1?.includes("T"),
      `sessions.updated_at (${postHealUpdatedAt1}) must be ISO 'T'-form after heal`
    );
    assert.ok(
      postHealUpdatedAt1! > preHealUpdatedAt,
      `sessions.updated_at (${postHealUpdatedAt1}) must be > pre-heal value (${preHealUpdatedAt})`
    );

    // ── heal log emitted ──
    assert.ok(
      logs.some((m) => m.includes("cost-conservation heal")),
      `expected heal log, got: ${logs.join(" | ")}`
    );

    // ── idempotency: second run finds no divergent rows → no changes ──
    const logs2: string[] = [];
    await healTokenUsageEventConservation(db.prisma, (m) => logs2.push(m));

    assert.equal(logs2.length, 0, "second heal must be a no-op");
    assert.equal(
      await tokenUsageCost(db, sessionId, model),
      dbEventSum,
      "cost must be unchanged after second heal"
    );
    const postHealUpdatedAt2 = await sessionUpdatedAt(db, sessionId);
    assert.equal(
      postHealUpdatedAt2,
      postHealUpdatedAt1,
      "sessions.updated_at must be unchanged after second (no-op) heal"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ── twin-predicate agreement (review: mikeangstadt) ─────────────────────────

test("SQL QUALIFIES predicate (heal) and chooseConservedUsageCost (reprice) agree branch-for-branch", async () => {
  // Each fixture runs the SAME stored state through BOTH deciders:
  // JS twin — NULL the usage cost and let repriceUnpricedTokenUsage decide;
  // SQL twin — reset the usage cost to a wrong sentinel and let the heal decide.
  // CONSERVE fixtures must land both deciders on Σ(events) (within the shared
  // epsilon); SKIP fixtures must leave the JS decider on the aggregate and the
  // SQL decider on the untouched sentinel. A future edit that changes one twin
  // but not the other breaks a row here long before it surfaces as golden drift.
  const model = "gpt-5.4";
  const flatModel = "gpt-5-codex";
  const SENTINEL = 999;
  const fixtures: {
    name: string;
    fixtureModel: string;
    mutate?: string;
    expect: "conserve" | "skip";
  }[] = [
    { name: "tiered-conserve", fixtureModel: model, expect: "conserve" },
    {
      name: "baseline-count-mismatch",
      fixtureModel: model,
      mutate:
        "UPDATE token_usage SET baseline_input = 200000 WHERE session_id = $1",
      expect: "skip",
    },
    { name: "flat-epsilon", fixtureModel: flatModel, expect: "conserve" },
    {
      name: "otel-excluded",
      fixtureModel: model,
      mutate:
        "UPDATE token_usage SET usage_source = 'otel_log_payload' WHERE session_id = $1",
      expect: "skip",
    },
  ];

  const { db, dir } = await openTempDb();
  try {
    for (const fixture of fixtures) {
      const sessionId = `sess-twin-${fixture.name}`;
      const session = makeSession({
        sessionId,
        model: fixture.fixtureModel,
        tokensByModel: {
          [fixture.fixtureModel]: {
            input: 300_000,
            output: 300,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
        tokenSeries: [0, 1, 2].map((i) => ({
          timestamp: `2026-06-20T08:0${i}:00.000Z`,
          model: fixture.fixtureModel,
          input: 100_000,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
        })),
      });
      await db.importer.importSession(session, Harness.Claude);
      const mutateSql = fixture.mutate;
      if (mutateSql) {
        await db.prisma.write((client) =>
          client.$executeRawUnsafe(mutateSql, sessionId)
        );
      }
      const eventSum = await tokenEventSum(db, sessionId);
      const eps = 1e-9 * Math.max(1, eventSum, SENTINEL);

      // JS twin via the reprice path.
      await db.prisma.write((client) =>
        client.$executeRawUnsafe(
          "UPDATE token_usage SET cost_usd_estimated = NULL WHERE session_id = $1",
          sessionId
        )
      );
      const { repriceUnpricedTokenUsage: reprice } = await import(
        "../src/main/database/token-cost-maintenance.js"
      );
      await reprice(db.prisma, () => undefined);
      const jsValue = await tokenUsageCost(db, sessionId, fixture.fixtureModel);
      assert.ok(jsValue !== null, `${fixture.name}: JS decider must price`);

      // SQL twin via the heal path.
      await db.prisma.write((client) =>
        client.$executeRawUnsafe(
          "UPDATE token_usage SET cost_usd_estimated = $1 WHERE session_id = $2",
          SENTINEL,
          sessionId
        )
      );
      await healTokenUsageEventConservation(db.prisma, () => undefined);
      const sqlValue = await tokenUsageCost(
        db,
        sessionId,
        fixture.fixtureModel
      );
      assert.ok(sqlValue !== null, `${fixture.name}: SQL decider must price`);

      if (fixture.expect === "conserve") {
        assert.ok(
          Math.abs(jsValue - eventSum) <= eps,
          `${fixture.name}: JS decider must land on Σ(events) (got ${jsValue}, Σ ${eventSum})`
        );
        assert.ok(
          Math.abs(sqlValue - eventSum) <= eps,
          `${fixture.name}: SQL decider must land on Σ(events) (got ${sqlValue}, Σ ${eventSum})`
        );
      } else {
        assert.notEqual(
          jsValue,
          eventSum,
          `${fixture.name}: JS decider must fail closed (not conserve)`
        );
        assert.equal(
          sqlValue,
          SENTINEL,
          `${fixture.name}: SQL decider must skip the row (sentinel untouched)`
        );
      }
    }
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
