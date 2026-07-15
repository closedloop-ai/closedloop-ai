/**
 * @file component-model-analytics.test.ts
 * @description Unit tests for the desktop optimization analytics IPC handlers
 * (FEA-2923 / AC-022 / T-18.7). Seeds a temp libSQL store with
 * AgentComponent, AgentComponentSessionUsage, token_events, and
 * claude_code_api_request rows, then executes the same SQL the IPC handlers
 * use and asserts the expected per-(component,model) bucket shapes.
 *
 * No live DB is required — all tests run against an ephemeral on-disk SQLite
 * database created by the production migration runner (via openTestPrisma).
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { localDay } from "../src/main/database/db-helpers.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { openTestPrisma } from "./prisma-test-utils.js";

// FEA-3006: the optimization-analytics Day axis buckets sessions by the user's
// LOCAL day (localDay of the raw started_at), not the storage-only UTC
// started_day column (FEA-2430). Pin a non-UTC timezone so these local-day
// assertions are deterministic across machines/CI — mirrors
// attribution-day-bucketing.test.ts.
const originalTz = process.env.TZ;
process.env.TZ = "America/Chicago";
// Restore the exact previous TZ so a co-located runner mode (files sharing one
// process) doesn't leak Chicago into later tests, per the root AGENTS.md Test
// Practices rule (unset → delete the property, not assign "undefined").
after(() => {
  if (originalTz === undefined) {
    Reflect.deleteProperty(process.env, "TZ");
  } else {
    process.env.TZ = originalTz;
  }
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function insertSession(
  prisma: DesktopPrisma,
  id: string,
  startedAt: string
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
       VALUES ($1, $1, 'completed', $2, $2, 'claude')`,
      id,
      startedAt
    )
  );
}

async function insertAgentComponent(
  prisma: DesktopPrisma,
  id: string,
  componentKind: string,
  componentKey: string
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO agent_components
         (id, component_kind, external_id, component_key, first_seen_at, last_seen_at)
       VALUES ($1, $2, $1, $3, '2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`,
      id,
      componentKind,
      componentKey
    )
  );
}

async function insertUsage(
  prisma: DesktopPrisma,
  sessionId: string,
  componentKind: string,
  componentKey: string,
  invocations: number,
  startedDay: string
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO agent_component_session_usage
         (session_id, component_kind, component_key, invocations, error_count,
          started_day)
       VALUES ($1, $2, $3, $4, 0, $5)`,
      sessionId,
      componentKind,
      componentKey,
      invocations,
      startedDay
    )
  );
}

async function insertTokenEvent(
  prisma: DesktopPrisma,
  sessionId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  costUsd: number | null,
  createdAt: string
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO token_events
         (session_id, model, created_at, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cost_usd_estimated)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      sessionId,
      model,
      createdAt,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      costUsd
    )
  );
}

async function insertApiRequest(
  prisma: DesktopPrisma,
  id: string,
  sessionId: string,
  model: string,
  durationMs: number,
  startedAt: string
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO claude_code_api_request
         (id, session_id, model, tokens_input, tokens_output, tokens_cache_read,
          tokens_cache_creation, cost_usd, started_at, duration_ms, data_revision)
       VALUES ($1, $2, $3, 0, 0, 0, 0, 0.0, $4, $5, 1)`,
      id,
      sessionId,
      model,
      startedAt,
      durationMs
    )
  );
}

// ---------------------------------------------------------------------------
// The same SQL the IPC handlers use (extracted for testability without Electron)
// ---------------------------------------------------------------------------

type TokenRow = {
  day: string;
  model: string;
  input_tokens: bigint;
  output_tokens: bigint;
  cache_read_tokens: bigint;
  cache_write_tokens: bigint;
  cost_usd: number | null;
};

type LatencyRow = {
  day: string;
  model: string;
  avg_ms: number | null;
  max_ms: number | null;
};

type CompactionRow = {
  day: string;
  model: string;
  compaction_count: bigint;
};

type ComponentModelTrendPoint = {
  day: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number | null;
  latencyAvgMs: number | null;
  latencyMaxMs: number | null;
  compactionCount: number;
};

async function queryComponentModelTrend(
  prisma: DesktopPrisma,
  componentKind: string,
  componentKey: string,
  cutoffDay: string,
  modelFilter: string | null = null
): Promise<ComponentModelTrendPoint[]> {
  const modelFilter_ = modelFilter ? "AND te.model = ?" : "";
  // The latency query joins claude_code_api_request (`car`), not token_events
  // (`te`), so its model predicate must reference car.model. Mirrors the
  // production query in agent-dashboard-design-system-runtime.ts.
  const latencyModelFilter_ = modelFilter ? "AND car.model = ?" : "";
  const modelArgs_ = modelFilter ? [modelFilter] : [];

  // FEA-2999: mirrors the production queries in
  // agent-dashboard-design-system-runtime.ts — day buckets are re-derived from
  // the raw session timestamp in LOCAL time (strftime(..., 'localtime')) via a
  // sessions join, never the storage-only UTC started_day column. started_day is
  // kept only as the (UTC) window pre-filter.
  const tokenRows = await prisma.client.$queryRawUnsafe<TokenRow[]>(
    `SELECT
      ${localDay("s.started_at")} AS day,
      te.model,
      COALESCE(SUM(te.input_tokens), 0) AS input_tokens,
      COALESCE(SUM(te.output_tokens), 0) AS output_tokens,
      COALESCE(SUM(te.cache_read_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(te.cache_write_tokens), 0) AS cache_write_tokens,
      COALESCE(SUM(te.cost_usd_estimated), 0) AS cost_usd
    FROM agent_component_session_usage acsu
    INNER JOIN sessions s ON s.id = acsu.session_id
    INNER JOIN token_events te ON te.session_id = acsu.session_id
    WHERE acsu.component_kind = ?
      AND acsu.component_key = ?
      AND ${localDay("s.started_at")} >= ?
      ${modelFilter_}
    GROUP BY day, te.model
    ORDER BY day ASC, te.model ASC`,
    componentKind,
    componentKey,
    cutoffDay,
    ...modelArgs_
  );

  const latencyRows = await prisma.client.$queryRawUnsafe<LatencyRow[]>(
    `SELECT
      ${localDay("s.started_at")} AS day,
      car.model,
      AVG(car.duration_ms) AS avg_ms,
      MAX(car.duration_ms) AS max_ms
    FROM agent_component_session_usage acsu
    INNER JOIN sessions s ON s.id = acsu.session_id
    INNER JOIN claude_code_api_request car ON car.session_id = acsu.session_id
    WHERE acsu.component_kind = ?
      AND acsu.component_key = ?
      AND ${localDay("s.started_at")} >= ?
      ${latencyModelFilter_}
    GROUP BY day, car.model
    ORDER BY day ASC, car.model ASC`,
    componentKind,
    componentKey,
    cutoffDay,
    ...modelArgs_
  );

  const compactionRows = await prisma.client.$queryRawUnsafe<CompactionRow[]>(
    `SELECT
      ${localDay("s.started_at")} AS day,
      te.model,
      COUNT(DISTINCT acsu.session_id) AS compaction_count
    FROM agent_component_session_usage acsu
    INNER JOIN sessions s ON s.id = acsu.session_id
    INNER JOIN token_events te ON te.session_id = acsu.session_id
    INNER JOIN events ev
      ON ev.session_id = acsu.session_id
      AND ev.event_type = 'Compaction'
    WHERE acsu.component_kind = ?
      AND acsu.component_key = ?
      AND ${localDay("s.started_at")} >= ?
      ${modelFilter_}
    GROUP BY day, te.model`,
    componentKind,
    componentKey,
    cutoffDay,
    ...modelArgs_
  );

  const latencyByKey = new Map<
    string,
    { avg_ms: number | null; max_ms: number | null }
  >();
  for (const r of latencyRows) {
    latencyByKey.set(`${r.day}:${r.model}`, {
      avg_ms: r.avg_ms,
      max_ms: r.max_ms,
    });
  }
  const compactionByKey = new Map<string, number>();
  for (const r of compactionRows) {
    compactionByKey.set(`${r.day}:${r.model}`, Number(r.compaction_count));
  }

  return tokenRows.map((r) => {
    const key = `${r.day}:${r.model}`;
    const latency = latencyByKey.get(key);
    return {
      day: r.day,
      model: r.model,
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      cacheReadTokens: Number(r.cache_read_tokens),
      cacheWriteTokens: Number(r.cache_write_tokens),
      estimatedCostUsd: r.cost_usd ?? null,
      latencyAvgMs: latency?.avg_ms ?? null,
      latencyMaxMs: latency?.max_ms ?? null,
      compactionCount: compactionByKey.get(key) ?? 0,
    };
  });
}

async function insertCompactionEvent(
  prisma: DesktopPrisma,
  sessionId: string,
  createdAt: string
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO events (id, session_id, agent_id, event_type, summary, created_at)
       VALUES ($1, $2, $2, 'Compaction', 'Context compaction', $3)`,
      `evt-${sessionId}-${createdAt}`,
      sessionId,
      createdAt
    )
  );
}

type SubagentFrequencyPoint = {
  day: string;
  sessionCount: number;
  invocations: number;
};

async function querySubagentFrequency(
  prisma: DesktopPrisma,
  subagentKey: string,
  cutoffDay: string
): Promise<SubagentFrequencyPoint[]> {
  // FEA-2999: mirrors production — LOCAL-day bucket via the sessions join, with
  // the UTC started_day kept only as the window pre-filter.
  const rows = await prisma.client.$queryRawUnsafe<
    { day: string; session_count: bigint; invocations: bigint }[]
  >(
    `SELECT
      ${localDay("s.started_at")} AS day,
      COUNT(DISTINCT acsu.session_id) AS session_count,
      SUM(acsu.invocations) AS invocations
    FROM agent_component_session_usage acsu
    INNER JOIN sessions s ON s.id = acsu.session_id
    WHERE acsu.component_kind = 'subagent'
      AND acsu.component_key = ?
      AND ${localDay("s.started_at")} >= ?
    GROUP BY day
    ORDER BY day ASC`,
    subagentKey,
    cutoffDay
  );
  return rows.map((r) => ({
    day: r.day,
    sessionCount: Number(r.session_count),
    invocations: Number(r.invocations),
  }));
}

type SkillLoadedResult = {
  existsInInventory: boolean;
  hasUsage: boolean;
  totalInvocations: number;
  lastUsedAt: string | null;
};

async function queryIsSkillLoaded(
  prisma: DesktopPrisma,
  skillKey: string
): Promise<SkillLoadedResult> {
  const [inventoryRow, usageRow] = await Promise.all([
    prisma.client.agentComponent.findFirst({
      where: { componentKind: "skill", componentKey: skillKey },
      select: { id: true },
    }),
    prisma.client.$queryRawUnsafe<
      { total_invocations: bigint; last_used_at: string | null }[]
    >(
      `SELECT
        COALESCE(SUM(invocations), 0) AS total_invocations,
        MAX(last_invoked_at) AS last_used_at
      FROM agent_component_session_usage
      WHERE component_kind = 'skill'
        AND component_key = ?`,
      skillKey
    ),
  ]);

  const usage = usageRow[0];
  const totalInvocations = Number(usage?.total_invocations ?? 0);
  return {
    existsInInventory: inventoryRow !== null,
    hasUsage: totalInvocations > 0,
    totalInvocations,
    lastUsedAt: usage?.last_used_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// A stable past cutoff that includes all seeded data in the window.
const CUTOFF_DAY = "2026-05-01";

test("getComponentModelTrend: per-(command,model) buckets group correctly across two models", async () => {
  // Seed: command "review" used in two sessions on different days, each with
  // token events from two distinct models. The query must produce one point per
  // (day × model) pair.
  const { prisma, close } = await openTestPrisma();
  try {
    await insertSession(prisma, "s-cmd-1", "2026-06-01T10:00:00.000Z");
    await insertSession(prisma, "s-cmd-2", "2026-06-02T10:00:00.000Z");

    // Two usage rows — one per session day.
    await insertUsage(prisma, "s-cmd-1", "command", "review", 3, "2026-06-01");
    await insertUsage(prisma, "s-cmd-2", "command", "review", 5, "2026-06-02");

    // Day 1: model-a and model-b.
    await insertTokenEvent(
      prisma,
      "s-cmd-1",
      "model-a",
      1000,
      200,
      50,
      0,
      0.01,
      "2026-06-01T10:01:00.000Z"
    );
    await insertTokenEvent(
      prisma,
      "s-cmd-1",
      "model-b",
      500,
      100,
      20,
      0,
      0.005,
      "2026-06-01T10:02:00.000Z"
    );
    // Day 2: only model-a.
    await insertTokenEvent(
      prisma,
      "s-cmd-2",
      "model-a",
      800,
      150,
      30,
      10,
      0.008,
      "2026-06-02T10:01:00.000Z"
    );

    const points = await queryComponentModelTrend(
      prisma,
      "command",
      "review",
      CUTOFF_DAY
    );

    // Expect three points: (2026-06-01, model-a), (2026-06-01, model-b),
    // (2026-06-02, model-a) — ordered by day ASC, model ASC.
    assert.equal(points.length, 3, "three (day,model) buckets");

    const pt0 = points[0];
    assert.equal(pt0.day, "2026-06-01");
    assert.equal(pt0.model, "model-a");
    assert.equal(pt0.inputTokens, 1000);
    assert.equal(pt0.outputTokens, 200);
    assert.equal(pt0.cacheReadTokens, 50);
    assert.equal(pt0.cacheWriteTokens, 0);

    const pt1 = points[1];
    assert.equal(pt1.day, "2026-06-01");
    assert.equal(pt1.model, "model-b");
    assert.equal(pt1.inputTokens, 500);

    const pt2 = points[2];
    assert.equal(pt2.day, "2026-06-02");
    assert.equal(pt2.model, "model-a");
    assert.equal(pt2.inputTokens, 800);
    assert.equal(pt2.cacheWriteTokens, 10);
  } finally {
    await close();
  }
});

test("getComponentModelTrend: modelFilter restricts to a single model", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertSession(prisma, "s-filter-1", "2026-06-10T10:00:00.000Z");
    await insertUsage(
      prisma,
      "s-filter-1",
      "command",
      "deploy",
      2,
      "2026-06-10"
    );
    await insertTokenEvent(
      prisma,
      "s-filter-1",
      "model-x",
      400,
      80,
      10,
      0,
      null,
      "2026-06-10T10:01:00.000Z"
    );
    await insertTokenEvent(
      prisma,
      "s-filter-1",
      "model-y",
      600,
      120,
      20,
      0,
      null,
      "2026-06-10T10:02:00.000Z"
    );

    const pointsAll = await queryComponentModelTrend(
      prisma,
      "command",
      "deploy",
      CUTOFF_DAY
    );
    assert.equal(pointsAll.length, 2, "two models without filter");

    const pointsFiltered = await queryComponentModelTrend(
      prisma,
      "command",
      "deploy",
      CUTOFF_DAY,
      "model-x"
    );
    assert.equal(pointsFiltered.length, 1, "one model with model-x filter");
    assert.equal(pointsFiltered[0].model, "model-x");
    assert.equal(pointsFiltered[0].inputTokens, 400);
  } finally {
    await close();
  }
});

test("getComponentModelTrend: cost column aggregates and compaction counts real compaction events", async () => {
  // Three sessions on the same (day, model): two recorded an actual Compaction
  // event, one did not. compactionCount must be 2 (COUNT DISTINCT session_id
  // over sessions with a 'Compaction' event) — NOT 3. This proves the metric
  // tracks real compaction events, not merely session count / cache writes.
  const { prisma, close } = await openTestPrisma();
  try {
    await insertSession(prisma, "s-trunc-a", "2026-06-15T10:00:00.000Z");
    await insertSession(prisma, "s-trunc-b", "2026-06-15T11:00:00.000Z");
    await insertSession(prisma, "s-trunc-c", "2026-06-15T12:00:00.000Z");

    await insertUsage(
      prisma,
      "s-trunc-a",
      "skill",
      "code-review",
      1,
      "2026-06-15"
    );
    await insertUsage(
      prisma,
      "s-trunc-b",
      "skill",
      "code-review",
      1,
      "2026-06-15"
    );
    await insertUsage(
      prisma,
      "s-trunc-c",
      "skill",
      "code-review",
      1,
      "2026-06-15"
    );

    // All three sessions use model-z with cache_write_tokens > 0 (the OLD proxy
    // would have counted all 3). Only two record an actual Compaction event.
    await insertTokenEvent(
      prisma,
      "s-trunc-a",
      "model-z",
      200,
      50,
      5,
      25,
      0.002,
      "2026-06-15T10:01:00.000Z"
    );
    await insertTokenEvent(
      prisma,
      "s-trunc-b",
      "model-z",
      300,
      70,
      8,
      30,
      0.003,
      "2026-06-15T11:01:00.000Z"
    );
    await insertTokenEvent(
      prisma,
      "s-trunc-c",
      "model-z",
      100,
      20,
      2,
      15,
      0.001,
      "2026-06-15T12:01:00.000Z"
    );

    // Only sessions a and b actually compacted.
    await insertCompactionEvent(
      prisma,
      "s-trunc-a",
      "2026-06-15T10:05:00.000Z"
    );
    await insertCompactionEvent(
      prisma,
      "s-trunc-b",
      "2026-06-15T11:05:00.000Z"
    );

    const points = await queryComponentModelTrend(
      prisma,
      "skill",
      "code-review",
      CUTOFF_DAY
    );

    assert.equal(points.length, 1, "single (day,model) bucket");
    const pt = points[0];
    assert.equal(pt.day, "2026-06-15");
    assert.equal(pt.model, "model-z");
    // Tokens from all three sessions are summed.
    assert.equal(pt.inputTokens, 600);
    assert.equal(pt.outputTokens, 140);
    // Cost should be approximately 0.006 (sum of 0.002 + 0.003 + 0.001).
    assert.ok(
      Math.abs((pt.estimatedCostUsd ?? 0) - 0.006) < 1e-9,
      `cost ≈ 0.006, got ${pt.estimatedCostUsd}`
    );
    // Only two of three sessions recorded a Compaction event → compactionCount = 2.
    assert.equal(pt.compactionCount, 2, "two sessions actually compacted");
  } finally {
    await close();
  }
});

test("getComponentModelTrend: latency columns populated from claude_code_api_request", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertSession(prisma, "s-lat-1", "2026-06-20T09:00:00.000Z");
    await insertUsage(prisma, "s-lat-1", "command", "build", 1, "2026-06-20");
    // Token event provides the bucket.
    await insertTokenEvent(
      prisma,
      "s-lat-1",
      "model-fast",
      100,
      20,
      0,
      0,
      null,
      "2026-06-20T09:01:00.000Z"
    );
    // API request provides the latency.
    await insertApiRequest(
      prisma,
      "req-lat-1",
      "s-lat-1",
      "model-fast",
      320,
      "2026-06-20T09:01:00.000Z"
    );

    const points = await queryComponentModelTrend(
      prisma,
      "command",
      "build",
      CUTOFF_DAY
    );

    assert.equal(points.length, 1);
    const pt = points[0];
    assert.ok(pt.latencyAvgMs !== null, "latencyAvgMs should be set");
    assert.ok(pt.latencyMaxMs !== null, "latencyMaxMs should be set");
    // With a single request, AVG = MAX = 320.
    assert.equal(Math.round(pt.latencyAvgMs ?? 0), 320);
    assert.equal(pt.latencyMaxMs, 320);
  } finally {
    await close();
  }
});

test("getComponentModelTrend: cutoff day excludes older buckets", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // Midday UTC so the LOCAL (Chicago) calendar day equals the UTC day the
    // assertions below use — a T00:00:00Z seed would fall on the prior local day.
    await insertSession(prisma, "s-old-1", "2026-01-01T12:00:00.000Z");
    await insertSession(prisma, "s-new-1", "2026-06-25T12:00:00.000Z");

    await insertUsage(
      prisma,
      "s-old-1",
      "command",
      "test-cmd",
      1,
      "2026-01-01"
    );
    await insertUsage(
      prisma,
      "s-new-1",
      "command",
      "test-cmd",
      1,
      "2026-06-25"
    );
    await insertTokenEvent(
      prisma,
      "s-old-1",
      "model-m",
      100,
      10,
      0,
      0,
      null,
      "2026-01-01T01:00:00.000Z"
    );
    await insertTokenEvent(
      prisma,
      "s-new-1",
      "model-m",
      200,
      20,
      0,
      0,
      null,
      "2026-06-25T01:00:00.000Z"
    );

    // Only include data on or after the 2026-06-01 UTC window boundary
    // (started_day pre-filter), so s-old-1 (started_day 2026-01-01) drops.
    const points = await queryComponentModelTrend(
      prisma,
      "command",
      "test-cmd",
      "2026-06-01"
    );

    assert.equal(
      points.length,
      1,
      "only the recent session survives the cutoff"
    );
    // FEA-3006: s-new-1 started at 2026-06-25T12:00:00Z — midday UTC, so its
    // LOCAL (Chicago) calendar day is still 2026-06-25. The Day axis buckets by
    // that local day via localDay(s.started_at), not the storage-only UTC
    // started_day column.
    assert.equal(points[0].day, "2026-06-25");
    assert.equal(points[0].inputTokens, 200);
  } finally {
    await close();
  }
});

test("getComponentModelTrend: buckets the Day axis in LOCAL time, not the stored UTC started_day (FEA-3006)", async () => {
  // A late local-evening session: 2026-06-30T04:30Z is 2026-06-29 23:30 in
  // Chicago (CDT, UTC-5). Its stored started_day is the UTC day 2026-06-30, but
  // every other Insights view buckets it on the LOCAL day 2026-06-29. This panel
  // must agree — reading the raw started_at in localtime, never started_day.
  const { prisma, close } = await openTestPrisma();
  try {
    await insertSession(prisma, "s-tz-1", "2026-06-30T04:30:00.000Z");
    // started_day carries the UTC day, exactly as write-core.ts stores it.
    await insertUsage(prisma, "s-tz-1", "command", "review", 1, "2026-06-30");
    await insertTokenEvent(
      prisma,
      "s-tz-1",
      "model-a",
      100,
      10,
      0,
      0,
      null,
      "2026-06-30T04:31:00.000Z"
    );

    const points = await queryComponentModelTrend(
      prisma,
      "command",
      "review",
      CUTOFF_DAY
    );

    assert.equal(points.length, 1);
    assert.equal(
      points[0].day,
      "2026-06-29",
      "buckets on the LOCAL day, not the stored UTC started_day 2026-06-30"
    );
  } finally {
    await close();
  }
});

test("getSubagentFrequency: counts distinct sessions per startedDay", async () => {
  // Two sessions on day-1, one on day-2. The query should return
  // sessionCount=2 for day-1 and sessionCount=1 for day-2.
  const { prisma, close } = await openTestPrisma();
  try {
    await insertSession(prisma, "s-sa-1", "2026-06-10T10:00:00.000Z");
    await insertSession(prisma, "s-sa-2", "2026-06-10T12:00:00.000Z");
    await insertSession(prisma, "s-sa-3", "2026-06-11T09:00:00.000Z");

    await insertUsage(
      prisma,
      "s-sa-1",
      "subagent",
      "researcher",
      2,
      "2026-06-10"
    );
    await insertUsage(
      prisma,
      "s-sa-2",
      "subagent",
      "researcher",
      3,
      "2026-06-10"
    );
    await insertUsage(
      prisma,
      "s-sa-3",
      "subagent",
      "researcher",
      1,
      "2026-06-11"
    );

    const points = await querySubagentFrequency(
      prisma,
      "researcher",
      CUTOFF_DAY
    );

    assert.equal(points.length, 2, "two distinct day buckets");

    const day1 = points[0];
    assert.equal(day1.day, "2026-06-10");
    assert.equal(day1.sessionCount, 2, "two sessions on 2026-06-10");
    assert.equal(day1.invocations, 5, "invocations summed: 2+3=5");

    const day2 = points[1];
    assert.equal(day2.day, "2026-06-11");
    assert.equal(day2.sessionCount, 1);
    assert.equal(day2.invocations, 1);
  } finally {
    await close();
  }
});

test("getSubagentFrequency: buckets by LOCAL calendar day, not stored UTC started_day (FEA-2999)", async () => {
  // Regression for FEA-2999: a session that started just after midnight UTC but
  // in the previous LOCAL day must land on its local calendar day, matching the
  // rest of the desktop Insights dashboard (local-insights.ts). Two sessions
  // share the SAME stored UTC started_day (2026-06-25) but straddle the local
  // midnight in the pinned America/Chicago zone, so they split across two LOCAL
  // days — a UTC started_day read would have collapsed them onto one.
  const { prisma, close } = await openTestPrisma();
  try {
    // 2026-06-25T02:00:00Z → 2026-06-24 21:00 CDT → local day 2026-06-24.
    await insertSession(prisma, "s-tz-prev", "2026-06-25T02:00:00.000Z");
    // 2026-06-25T18:00:00Z → 2026-06-25 13:00 CDT → local day 2026-06-25.
    await insertSession(prisma, "s-tz-same", "2026-06-25T18:00:00.000Z");

    // Both usage rows carry the identical UTC started_day.
    await insertUsage(
      prisma,
      "s-tz-prev",
      "subagent",
      "planner",
      2,
      "2026-06-25"
    );
    await insertUsage(
      prisma,
      "s-tz-same",
      "subagent",
      "planner",
      4,
      "2026-06-25"
    );

    const points = await querySubagentFrequency(prisma, "planner", CUTOFF_DAY);

    assert.equal(
      points.length,
      2,
      "one bucket per LOCAL day, despite a shared UTC started_day"
    );
    assert.equal(
      points[0].day,
      "2026-06-24",
      "post-midnight-UTC lands on prev local day"
    );
    assert.equal(points[0].invocations, 2);
    assert.equal(points[1].day, "2026-06-25");
    assert.equal(points[1].invocations, 4);
  } finally {
    await close();
  }
});

test("getSubagentFrequency: kind filter excludes non-subagent rows", async () => {
  // A skill row with the same key should NOT appear in subagent frequency.
  const { prisma, close } = await openTestPrisma();
  try {
    await insertSession(prisma, "s-kind-1", "2026-06-12T10:00:00.000Z");
    await insertUsage(
      prisma,
      "s-kind-1",
      "skill",
      "researcher",
      4,
      "2026-06-12"
    );

    const points = await querySubagentFrequency(
      prisma,
      "researcher",
      CUTOFF_DAY
    );
    assert.equal(
      points.length,
      0,
      "skill rows must not appear in subagent frequency"
    );
  } finally {
    await close();
  }
});

test("isSkillLoaded: returns false for installed-but-zero-usage skill", async () => {
  // A skill that exists in the inventory (agent_components) but has no usage
  // rows should be flagged as existsInInventory=true, hasUsage=false. This is
  // the "skill loaded or not" triage path (AC-022).
  const { prisma, close } = await openTestPrisma();
  try {
    await insertAgentComponent(
      prisma,
      "comp-silent-skill",
      "skill",
      "silent-skill"
    );
    // No agent_component_session_usage rows for this skill.

    const result = await queryIsSkillLoaded(prisma, "silent-skill");
    assert.equal(result.existsInInventory, true, "inventory row present");
    assert.equal(result.hasUsage, false, "no usage rows");
    assert.equal(result.totalInvocations, 0);
    assert.equal(result.lastUsedAt, null);
  } finally {
    await close();
  }
});

test("isSkillLoaded: returns true for a skill with usage", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await insertAgentComponent(
      prisma,
      "comp-active-skill",
      "skill",
      "active-skill"
    );
    await insertSession(prisma, "s-sk-1", "2026-06-18T10:00:00.000Z");
    await prisma.write((client) =>
      client.$executeRawUnsafe(
        `INSERT INTO agent_component_session_usage
           (session_id, component_kind, component_key, invocations, error_count,
            started_day, last_invoked_at)
         VALUES ($1, 'skill', 'active-skill', 7, 0, '2026-06-18',
                 '2026-06-18T10:05:00.000Z')`,
        "s-sk-1"
      )
    );

    const result = await queryIsSkillLoaded(prisma, "active-skill");
    assert.equal(result.existsInInventory, true);
    assert.equal(result.hasUsage, true);
    assert.equal(result.totalInvocations, 7);
    assert.equal(result.lastUsedAt, "2026-06-18T10:05:00.000Z");
  } finally {
    await close();
  }
});

test("isSkillLoaded: returns false for a skill not in inventory", async () => {
  // A skill that has never been discovered (no agent_components row).
  const { prisma, close } = await openTestPrisma();
  try {
    const result = await queryIsSkillLoaded(prisma, "ghost-skill");
    assert.equal(result.existsInInventory, false);
    assert.equal(result.hasUsage, false);
    assert.equal(result.totalInvocations, 0);
    assert.equal(result.lastUsedAt, null);
  } finally {
    await close();
  }
});

test("getComponentModelTrend: a session running two commands attributes per-model tokens to both (session-granularity caveat)", async () => {
  // This is the documented session-granularity attribution behavior: a session
  // that exercised BOTH command-A and command-B will have its token_events
  // attributed to BOTH commands (since the join is on session_id only).
  // The test asserts this is the expected behavior (not a bug) per AC-022 /
  // T-18.7 spec: "session-granularity attribution caveat is the asserted behavior."
  const { prisma, close } = await openTestPrisma();
  try {
    await insertSession(prisma, "s-dual-1", "2026-06-22T10:00:00.000Z");

    // Same session has usage for two different commands.
    await insertUsage(
      prisma,
      "s-dual-1",
      "command",
      "cmd-alpha",
      2,
      "2026-06-22"
    );
    await insertUsage(
      prisma,
      "s-dual-1",
      "command",
      "cmd-beta",
      3,
      "2026-06-22"
    );

    // One token event on this session.
    await insertTokenEvent(
      prisma,
      "s-dual-1",
      "model-shared",
      1000,
      200,
      0,
      0,
      0.01,
      "2026-06-22T10:01:00.000Z"
    );

    const alphaPoints = await queryComponentModelTrend(
      prisma,
      "command",
      "cmd-alpha",
      CUTOFF_DAY
    );
    const betaPoints = await queryComponentModelTrend(
      prisma,
      "command",
      "cmd-beta",
      CUTOFF_DAY
    );

    // Both commands see the SAME token event — this is the session-granularity
    // attribution behavior (each command claims the full session's tokens).
    assert.equal(alphaPoints.length, 1, "cmd-alpha has one point");
    assert.equal(betaPoints.length, 1, "cmd-beta has one point");
    assert.equal(alphaPoints[0].inputTokens, 1000);
    assert.equal(betaPoints[0].inputTokens, 1000);
  } finally {
    await close();
  }
});

test("getComponentModelTrend: empty result when component key has no usage rows", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const points = await queryComponentModelTrend(
      prisma,
      "command",
      "nonexistent-cmd",
      CUTOFF_DAY
    );
    assert.equal(points.length, 0, "no points for unknown component");
  } finally {
    await close();
  }
});
