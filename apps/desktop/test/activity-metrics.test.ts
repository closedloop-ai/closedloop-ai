/**
 * @file activity-metrics.test.ts
 * @description FEA-2273 (PRD-488 FR-12, PLN-1205) tests for the in-product
 * cohort-metrics emission. Covers the FR-12 production bar (metrics observable
 * per cohort on real ingested sessions), the module-reuse guard (no divergent
 * coverage/band re-implementation in apps/desktop), coverage correctness +
 * reconciliation, idempotency/determinism (single vs batch), version stamping +
 * boot backfill, the zero-signal degradation case, and the pure cohort-derivation
 * boundaries. DB tests use a tmpdir-backed real libSQL store via
 * `openSqliteAgentDatabase()` (cf. session-analytics-backfill-batch.test.ts).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  autonomyIndexFromTurns,
  backfillActivityMetrics,
  deriveCohorts,
  upsertActivityMetricsRollup,
  upsertActivityMetricsRollupBatch,
} from "../src/main/database/activity-metrics.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  AutonomyBand,
  LengthBand,
} from "../src/main/telemetry/attribution-metrics.js";

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const NOW = "2026-07-01T12:00:00.000Z";

// Hoisted regex literal (biome useTopLevelRegex): the missing-token_events matcher.
const MISSING_TOKEN_EVENTS_RE = /token_events|no such table/i;

async function openTempDb(): Promise<{ db: SqliteDb; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "activity-metrics-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => NOW,
  });
  // The boot backfill is fire-and-forget; let it settle then clear any rows so
  // each test controls the table from a clean slate.
  await db.whenBootMaintenanceSettled();
  await db.run("DELETE FROM session_activity_metrics");
  return { db, dir };
}

type SeedSegment = {
  id: string;
  phase: string;
  startMs: number;
  endMs: number;
  confidence: number;
  version?: number;
};

type SeedSession = {
  id: string;
  harness: string | null;
  humanTurns: number;
  agentTurns: number;
  runtimeMs: number | null;
  startedDay: string | null;
  userId?: string | null;
  organizationId?: string | null;
  segments: SeedSegment[];
  tokens: { atMs: number; costUsd: number }[];
  /** When true, skip the session_analytics row (to exercise the backfill JOIN guard). */
  noAnalytics?: boolean;
};

async function seedSession(db: SqliteDb, s: SeedSession): Promise<void> {
  await db.run(
    `INSERT INTO sessions (id, name, status, started_at, updated_at, last_activity_at, harness, user_id, organization_id)
     VALUES ($1, $1, 'completed', $2, $2, $2, $3, $4, $5)`,
    s.id,
    NOW,
    s.harness,
    s.userId ?? null,
    s.organizationId ?? null
  );
  if (!s.noAnalytics) {
    await db.run(
      `INSERT INTO session_analytics
         (session_id, harness, human_turns, agent_turns, runtime_ms, started_day, is_human, event_count, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 0, $7)`,
      s.id,
      s.harness,
      s.humanTurns,
      s.agentTurns,
      s.runtimeMs,
      s.startedDay,
      NOW
    );
  }
  for (const seg of s.segments) {
    await db.run(
      `INSERT INTO session_activity_segments
         (id, session_id, phase, start_ms, end_ms, confidence, evidence_layers, version, work_item_ref, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6, '[]', $7, NULL, $8)`,
      seg.id,
      s.id,
      seg.phase,
      seg.startMs,
      seg.endMs,
      seg.confidence,
      seg.version ?? 4,
      NOW
    );
  }
  for (const [i, tok] of s.tokens.entries()) {
    await db.run(
      `INSERT INTO token_events (session_id, model, created_at, cost_usd_estimated)
       VALUES ($1, $2, $3, $4)`,
      s.id,
      `model-${i}`,
      new Date(tok.atMs).toISOString(),
      tok.costUsd
    );
  }
}

async function rollup(db: SqliteDb, sessionId: string): Promise<void> {
  await db.prisma.write((client) =>
    client.$transaction((tx) => upsertActivityMetricsRollup(tx, sessionId, NOW))
  );
}

type MetricsRow = {
  session_id: string;
  harness: string | null;
  autonomy_band: string;
  closedloop_user: number;
  length_band: string;
  started_day: string | null;
  coverage: number;
  covered_spend_usd: number;
  total_spend_usd: number;
  spend_low_conf_usd: number;
  spend_medium_conf_usd: number;
  spend_high_conf_usd: number;
  segment_count: number;
  covered_segment_count: number;
  version: number;
  updated_at: string | null;
};

async function readMetrics(
  db: SqliteDb,
  sessionId: string
): Promise<MetricsRow | undefined> {
  const rows = await db.prisma.client.$queryRawUnsafe<MetricsRow[]>(
    "SELECT * FROM session_activity_metrics WHERE session_id = $1",
    sessionId
  );
  return rows[0];
}

const close = 1e-9;
function approx(a: number, b: number): boolean {
  return Math.abs(a - b) <= close;
}

// A five-minute window helper (segments are epoch-ms spans).
const MIN = 60_000;

// ── Test 1: metrics observable per cohort on real sessions (FR-12 bar) ─────────

test("emits one cohort-keyed metrics row per session; coverage resolves and differs per cohort", async () => {
  const { db, dir } = await openTempDb();
  try {
    // claude_code, human-steered, closedloop user, short: 3.00 covered / 4.00 total.
    await seedSession(db, {
      id: "s-cc-human",
      harness: "claude_code",
      humanTurns: 10,
      agentTurns: 0,
      runtimeMs: 1 * MIN,
      startedDay: "2026-07-01",
      userId: "user-1",
      segments: [
        {
          id: "a1",
          phase: "implement",
          startMs: 0,
          endMs: 100,
          confidence: 0.9,
        },
        { id: "a2", phase: "other", startMs: 100, endMs: 200, confidence: 0.9 },
      ],
      tokens: [
        { atMs: 50, costUsd: 3.0 },
        { atMs: 150, costUsd: 1.0 },
      ],
    });
    // claude_code, mixed, closedloop (org), medium: 2.00 covered / 2.00 total.
    await seedSession(db, {
      id: "s-cc-mixed",
      harness: "claude_code",
      humanTurns: 1,
      agentTurns: 1,
      runtimeMs: 10 * MIN,
      startedDay: "2026-07-01",
      organizationId: "org-1",
      segments: [
        { id: "b1", phase: "review", startMs: 0, endMs: 100, confidence: 0.95 },
      ],
      tokens: [{ atMs: 50, costUsd: 2.0 }],
    });
    // codex, agentic, external, long: 0 covered / 5.00 total (all low-confidence).
    await seedSession(db, {
      id: "s-cx-agent",
      harness: "codex",
      humanTurns: 0,
      agentTurns: 10,
      runtimeMs: 40 * MIN,
      startedDay: "2026-07-01",
      segments: [
        {
          id: "c1",
          phase: "implement",
          startMs: 0,
          endMs: 100,
          confidence: 0.2,
        },
      ],
      tokens: [{ atMs: 50, costUsd: 5.0 }],
    });

    for (const id of ["s-cc-human", "s-cc-mixed", "s-cx-agent"]) {
      await rollup(db, id);
    }

    // One row per session, with the expected cohort keys.
    const human = await readMetrics(db, "s-cc-human");
    assert.ok(human);
    assert.equal(human.harness, "claude_code");
    assert.equal(human.autonomy_band, AutonomyBand.HumanSteered);
    assert.equal(human.closedloop_user, 1);
    assert.equal(human.length_band, LengthBand.Short);
    assert.ok(approx(human.coverage, 0.75));

    const mixed = await readMetrics(db, "s-cc-mixed");
    assert.ok(mixed);
    assert.equal(mixed.autonomy_band, AutonomyBand.Mixed);
    assert.equal(mixed.closedloop_user, 1);
    assert.equal(mixed.length_band, LengthBand.Medium);
    assert.ok(approx(mixed.coverage, 1.0));

    const agent = await readMetrics(db, "s-cx-agent");
    assert.ok(agent);
    assert.equal(agent.harness, "codex");
    assert.equal(agent.autonomy_band, AutonomyBand.Agentic);
    assert.equal(agent.closedloop_user, 0);
    assert.equal(agent.length_band, LengthBand.Long);
    assert.ok(approx(agent.coverage, 0.0));

    // Per-cohort GROUP BY resolves coverage that DIFFERS across the harness axis.
    const byHarness = await db.prisma.client.$queryRawUnsafe<
      { harness: string; covered: number; total: number; n: number | bigint }[]
    >(
      `SELECT harness,
              SUM(covered_spend_usd) AS covered,
              SUM(total_spend_usd)   AS total,
              COUNT(*)               AS n
       FROM session_activity_metrics
       GROUP BY harness
       ORDER BY harness`
    );
    const cc = byHarness.find((r) => r.harness === "claude_code");
    const cx = byHarness.find((r) => r.harness === "codex");
    assert.ok(cc && cx);
    assert.equal(Number(cc.n), 2);
    // claude_code coverage = (3+2)/(4+2) = 0.8333…, codex = 0/5 = 0 → they differ.
    assert.ok(approx(cc.covered / cc.total, 5 / 6));
    assert.ok(approx(cx.covered / cx.total, 0));
    assert.notEqual(cc.covered / cc.total, cx.covered / cx.total);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Test 3: coverage correctness + reconciliation to token_events ─────────────

test("coverage = confident non-other spend / total, and reconciles to token_events", async () => {
  const { db, dir } = await openTempDb();
  try {
    await seedSession(db, {
      id: "s-cov",
      harness: "claude_code",
      humanTurns: 3,
      agentTurns: 1,
      runtimeMs: 2 * MIN,
      startedDay: "2026-07-01",
      userId: "u",
      segments: [
        // Confident + real → covered.
        {
          id: "seg-a",
          phase: "implement",
          startMs: 0,
          endMs: 100,
          confidence: 0.9,
        },
        // Confident but `other` → excluded.
        {
          id: "seg-b",
          phase: "other",
          startMs: 100,
          endMs: 200,
          confidence: 0.9,
        },
      ],
      tokens: [
        { atMs: 50, costUsd: 3.0 }, // → seg-a (covered)
        { atMs: 150, costUsd: 1.0 }, // → seg-b (excluded)
      ],
    });
    await rollup(db, "s-cov");

    const row = await readMetrics(db, "s-cov");
    assert.ok(row);
    assert.ok(approx(row.covered_spend_usd, 3.0));
    assert.ok(approx(row.total_spend_usd, 4.0));
    assert.ok(approx(row.coverage, 0.75));
    // Reconciliation: total equals the summed token_events cost.
    const tot = await db.prisma.client.$queryRawUnsafe<{ s: number | null }[]>(
      "SELECT SUM(cost_usd_estimated) AS s FROM token_events WHERE session_id = 's-cov'"
    );
    assert.ok(approx(row.total_spend_usd, Number(tot[0]?.s ?? 0)));
    // Confidence distribution: both segments are high-confidence → all spend high.
    assert.ok(approx(row.spend_high_conf_usd, 4.0));
    assert.ok(approx(row.spend_low_conf_usd, 0));
    assert.ok(approx(row.spend_medium_conf_usd, 0));
    assert.equal(row.segment_count, 2);
    assert.equal(row.covered_segment_count, 1);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Test 4: idempotency / determinism (double import + single vs batch) ───────

test("re-import is byte-identical, and the single path == the batch path", async () => {
  const { db, dir } = await openTempDb();
  try {
    const seed = (id: string): SeedSession => ({
      id,
      harness: "claude_code",
      humanTurns: 2,
      agentTurns: 2,
      runtimeMs: 8 * MIN,
      startedDay: "2026-07-01",
      userId: "u",
      segments: [
        {
          id: `${id}-a`,
          phase: "plan",
          startMs: 0,
          endMs: 100,
          confidence: 0.7,
        },
        {
          id: `${id}-b`,
          phase: "implement",
          startMs: 100,
          endMs: 200,
          confidence: 0.9,
        },
      ],
      tokens: [
        { atMs: 50, costUsd: 1.5 },
        { atMs: 150, costUsd: 2.5 },
      ],
    });
    await seedSession(db, seed("s-one"));
    await seedSession(db, seed("s-two"));

    // Double import of the same session yields a byte-identical row.
    await rollup(db, "s-one");
    const first = await readMetrics(db, "s-one");
    await rollup(db, "s-one");
    const second = await readMetrics(db, "s-one");
    assert.deepEqual(second, first);

    // Single-path rows (already have s-one; add s-two) vs a wiped batch recompute.
    await rollup(db, "s-two");
    const singleOne = await readMetrics(db, "s-one");
    const singleTwo = await readMetrics(db, "s-two");
    await db.run("DELETE FROM session_activity_metrics");
    await db.prisma.write((client) =>
      client.$transaction((tx) =>
        upsertActivityMetricsRollupBatch(tx, ["s-one", "s-two"], NOW)
      )
    );
    assert.deepEqual(await readMetrics(db, "s-one"), singleOne);
    assert.deepEqual(await readMetrics(db, "s-two"), singleTwo);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Test 5: version stamping + boot backfill (+ the analytics-JOIN guard) ──────

test("backfill fills segment-having rows, stamps the classifier version, and re-derives on bump", async () => {
  const { db, dir } = await openTempDb();
  try {
    // Has segments + analytics but no metrics row → backfill should fill it.
    await seedSession(db, {
      id: "s-fill",
      harness: "claude_code",
      humanTurns: 5,
      agentTurns: 0,
      runtimeMs: 3 * MIN,
      startedDay: "2026-07-01",
      userId: "u",
      segments: [
        {
          id: "f1",
          phase: "implement",
          startMs: 0,
          endMs: 100,
          confidence: 0.9,
          version: 4,
        },
      ],
      tokens: [{ atMs: 50, costUsd: 2.0 }],
    });
    // Has segments but NO analytics row → the backfill JOIN must skip it (no row,
    // and it is not re-selected forever).
    await seedSession(db, {
      id: "s-noanalytics",
      harness: "codex",
      humanTurns: 0,
      agentTurns: 3,
      runtimeMs: 3 * MIN,
      startedDay: "2026-07-01",
      noAnalytics: true,
      segments: [
        {
          id: "n1",
          phase: "implement",
          startMs: 0,
          endMs: 100,
          confidence: 0.9,
          version: 4,
        },
      ],
      tokens: [{ atMs: 50, costUsd: 2.0 }],
    });

    const logs: string[] = [];
    await backfillActivityMetrics(db.prisma, (m) => logs.push(m));

    const filled = await readMetrics(db, "s-fill");
    assert.ok(filled, "session with segments + analytics got a metrics row");
    assert.equal(
      filled.version,
      4,
      "row stamped with the segments' classifier version"
    );
    assert.equal(
      await readMetrics(db, "s-noanalytics"),
      undefined,
      "session lacking an analytics rollup is skipped by the JOIN guard"
    );
    assert.ok(
      logs.some((m) => m.includes("activity-metrics backfill complete: 1/1")),
      `expected a 1/1 completion log, got: ${logs.join(" | ")}`
    );

    // Idempotent: a second backfill finds nothing missing.
    const logs2: string[] = [];
    await backfillActivityMetrics(db.prisma, (m) => logs2.push(m));
    assert.equal(logs2.length, 0, "nothing missing on the second pass");

    // A classifier-version bump re-derives the row in the import path.
    await db.run(
      "UPDATE session_activity_segments SET version = 5 WHERE session_id = 's-fill'"
    );
    await rollup(db, "s-fill");
    assert.equal((await readMetrics(db, "s-fill"))?.version, 5);

    // The version-aware boot backfill also re-derives a row left BEHIND by a
    // re-tile that bumped the segments but never refreshed metrics (the separate
    // backfillActivitySegmentsFromTranscripts pathway). Bump segments to 6 WITHOUT
    // re-importing; the next backfill must re-select the now-stale row.
    await db.run(
      "UPDATE session_activity_segments SET version = 6 WHERE session_id = 's-fill'"
    );
    const logs3: string[] = [];
    await backfillActivityMetrics(db.prisma, (m) => logs3.push(m));
    assert.equal(
      (await readMetrics(db, "s-fill"))?.version,
      6,
      "the version-aware backfill re-derived the stale (version-behind) row"
    );
    assert.ok(
      logs3.some((m) => m.includes("activity-metrics backfill complete: 1/1")),
      `expected the stale row to be re-selected, got: ${logs3.join(" | ")}`
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Test 6: degradation — the zero-signal cohort is VISIBLE, not crashed ───────

test("an all-other/low-confidence session still gets a row with coverage 0 (weak cohort visible)", async () => {
  const { db, dir } = await openTempDb();
  try {
    await seedSession(db, {
      id: "s-weak",
      harness: "codex",
      humanTurns: 0,
      agentTurns: 4,
      runtimeMs: 6 * MIN,
      startedDay: "2026-07-01",
      segments: [
        // `other` (excluded even though confident) + a low-confidence `implement`.
        { id: "w1", phase: "other", startMs: 0, endMs: 100, confidence: 0.99 },
        {
          id: "w2",
          phase: "implement",
          startMs: 100,
          endMs: 200,
          confidence: 0.1,
        },
      ],
      tokens: [
        { atMs: 50, costUsd: 2.0 },
        { atMs: 150, costUsd: 3.0 },
      ],
    });
    await rollup(db, "s-weak");

    const row = await readMetrics(db, "s-weak");
    assert.ok(row, "a metrics row exists (not null, not a crash)");
    assert.equal(row.coverage, 0, "coverage is exactly 0, not null");
    assert.ok(approx(row.covered_spend_usd, 0));
    assert.ok(approx(row.total_spend_usd, 5.0), "total spend still counted");
    assert.equal(row.covered_segment_count, 0);
    assert.equal(row.segment_count, 2);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Best-effort dependency: a missing token_events surfaces (import wrapper catches) ──

test("metric emission reads token_events; a missing table surfaces an error the import wrapper tolerates", async () => {
  const { db, dir } = await openTempDb();
  try {
    await seedSession(db, {
      id: "s-drop",
      harness: "claude_code",
      humanTurns: 1,
      agentTurns: 0,
      runtimeMs: 1 * MIN,
      startedDay: "2026-07-01",
      userId: "u",
      segments: [
        {
          id: "d1",
          phase: "implement",
          startMs: 0,
          endMs: 100,
          confidence: 0.9,
        },
      ],
      tokens: [{ atMs: 50, costUsd: 1.0 }],
    });
    // Drop the spend source so the metric read fails. This documents WHY
    // importPhaseDerivedRollups wraps the emission in try/catch: the metrics are a
    // secondary rollup and must never abort the primary analytics rollup. The
    // tolerance itself (analytics rollup still commits) is pinned by
    // import-isolated-transactions.test.ts.
    await db.run("DROP TABLE token_events");
    await assert.rejects(
      db.prisma.write((client) =>
        client.$transaction((tx) =>
          upsertActivityMetricsRollup(tx, "s-drop", NOW)
        )
      ),
      MISSING_TOKEN_EVENTS_RE
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Cohort refresh on analytics recompute (HIGH review finding) ────────────────

test("recomputeAnalyticsRollups refreshes the metrics row's stale cohort (analytics changed, segment version did not)", async () => {
  const { db, dir } = await openTempDb();
  try {
    // Seed a session whose stored analytics is DELIBERATELY stale/misclassified —
    // agentic + long — the pre-recompute state a metrics row derives its cohort
    // from. Two human events make the recompute reclassify it (with a surviving
    // analytics row) to a DIFFERENT autonomy band.
    await seedSession(db, {
      id: "s-recompute",
      harness: "claude_code",
      humanTurns: 0,
      agentTurns: 99, // stale → agentic
      runtimeMs: 60 * MIN, // stale → long
      startedDay: "2026-07-01",
      userId: "u",
      segments: [
        {
          id: "rc1",
          phase: "implement",
          startMs: 0,
          endMs: 100,
          confidence: 0.9,
          version: 4,
        },
      ],
      tokens: [{ atMs: 50, costUsd: 2.0 }],
    });
    await db.run(
      `INSERT INTO events (id, session_id, event_type, tool_name, created_at)
       VALUES ('rc-e1', 's-recompute', 'user', NULL, '2026-07-01T12:00:01.000Z'),
              ('rc-e2', 's-recompute', 'prompt', NULL, '2026-07-01T12:00:02.000Z')`
    );
    await rollup(db, "s-recompute");
    const before = await readMetrics(db, "s-recompute");
    assert.ok(before);
    assert.equal(
      before.autonomy_band,
      AutonomyBand.Agentic,
      "metrics derived from the stale agentic analytics"
    );

    // recomputeAnalyticsRollups rewrites session_analytics from source events
    // WITHOUT bumping session_activity_segments.version — so the version-gated boot
    // backfill would never re-select this row and its cohort keys would go
    // permanently stale. FEA-2273 refreshes the metrics row in lock-step here.
    await db.recomputeAnalyticsRollups(["s-recompute"]);

    const [analytics] = await db.prisma.client.$queryRawUnsafe<
      {
        human_turns: number;
        agent_turns: number;
        runtime_ms: number | null;
        harness: string | null;
      }[]
    >(
      "SELECT human_turns, agent_turns, runtime_ms, harness FROM session_analytics WHERE session_id = 's-recompute'"
    );
    assert.ok(analytics, "recompute kept an analytics row");
    const expected = deriveCohorts(
      {
        harness: analytics.harness,
        humanTurns: analytics.human_turns,
        agentTurns: analytics.agent_turns,
        runtimeMs: analytics.runtime_ms,
      },
      { userId: "u", organizationId: null }
    );
    const after = await readMetrics(db, "s-recompute");
    assert.ok(after);
    // The metrics row now agrees with the recomputed analytics...
    assert.equal(after.autonomy_band, expected.autonomyBand);
    assert.equal(after.length_band, expected.lengthBand);
    // ...and it actually CHANGED (the refresh is not a no-op): agentic is gone.
    assert.notEqual(after.autonomy_band, AutonomyBand.Agentic);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5071: a FAILED metrics refresh counts into `failed` so the data-revision stamp is withheld", async () => {
  const { db, dir } = await openTempDb();
  try {
    // The sibling test above covers the happy path: the metrics row is refreshed
    // in lock-step because the version-gated boot backfill would never re-select
    // it. This pins what happens when that refresh FAILS.
    //
    // Before ISS-5071 the refresh swallowed its own error and returned void, so
    // recomputeAnalyticsRollups still reported `failed: 0`. data-revision rebuild
    // gates its `data_revision` stamp on exactly that number, so it read 0 as
    // "repaired" and SEALED the session with stale cohort keys — and the boot
    // backfill could not heal it, because backfillActivityMetrics selects
    // `WHERE sam.session_id IS NULL OR sam.version < seg.version` and this
    // recompute deliberately does not bump the segment version.
    await seedSession(db, {
      id: "s-metrics-fail",
      harness: "claude_code",
      humanTurns: 0,
      agentTurns: 99,
      runtimeMs: 60 * MIN,
      startedDay: "2026-07-01",
      userId: "u",
      segments: [
        {
          id: "mf1",
          phase: "implement",
          startMs: 0,
          endMs: 100,
          confidence: 0.9,
          version: 4,
        },
      ],
      tokens: [{ atMs: 50, costUsd: 2.0 }],
    });
    await db.run(
      `INSERT INTO events (id, session_id, event_type, tool_name, created_at)
       VALUES ('mf-e1', 's-metrics-fail', 'user', NULL, '2026-07-01T12:00:01.000Z'),
              ('mf-e2', 's-metrics-fail', 'prompt', NULL, '2026-07-01T12:00:02.000Z')`
    );
    await rollup(db, "s-metrics-fail");

    // Force ONLY the metrics refresh to throw, leaving the analytics rollup's own
    // transaction intact — the exact split the finding describes.
    await db.run("DROP TABLE session_activity_metrics");

    const result = await db.recomputeAnalyticsRollups(["s-metrics-fail"]);

    assert.equal(
      result.failed,
      1,
      "a metrics-refresh failure must be reported, not swallowed — data-revision gates the stamp on this"
    );
    assert.equal(result.attempted, 1);
    // ISS-5071 (@wongk): `failed` and `committed` are independent axes. The
    // PRIMARY analytics transaction committed here, so `committed` must say so
    // — that is the number post-boot maintenance invalidates its caches on, and
    // reporting 0 would leave mounted Insights queries stale against rows that
    // WERE rewritten.
    assert.equal(
      result.committed,
      1,
      "the committed analytics transaction must be reported separately from the metrics-only failure"
    );

    // ...and the analytics rollup itself must NOT have been rolled back: the
    // refresh stays best-effort in the sense that matters. Only the STAMP is
    // withheld, which is what leaves the session retryable.
    const [analytics] = await db.prisma.client.$queryRawUnsafe<
      { human_turns: number }[]
    >(
      "SELECT human_turns FROM session_analytics WHERE session_id = 's-metrics-fail'"
    );
    assert.ok(
      analytics,
      "the committed analytics recompute must survive a metrics-refresh failure"
    );
    // A surviving ROW is not evidence of a surviving RECOMPUTE — the row was
    // pre-seeded, so `assert.ok(analytics)` alone also passes when the primary
    // transaction never ran. The seed set human_turns = 0; the two human events
    // above make the recompute rewrite it to 2, so pin that value: this
    // assertion fails if the primary recompute regresses or is rolled back by
    // the metrics failure.
    assert.equal(
      Number(analytics.human_turns),
      2,
      "the primary recompute rewrote human_turns from the seeded 0 to the 2 human events, and the metrics failure did not roll it back"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Confidence-tier reconciliation with gap spend (MEDIUM review finding) ──────

test("confidence tiers sum to the segment-attributed spend (not total) when gap spend exists", async () => {
  const { db, dir } = await openTempDb();
  try {
    await seedSession(db, {
      id: "s-gap",
      harness: "claude_code",
      humanTurns: 3,
      agentTurns: 1,
      runtimeMs: 2 * MIN,
      startedDay: "2026-07-01",
      userId: "u",
      segments: [
        {
          id: "g1",
          phase: "implement",
          startMs: 0,
          endMs: 100,
          confidence: 0.9,
        },
      ],
      tokens: [
        { atMs: 50, costUsd: 2.0 }, // inside seg g1 → attributed (high-confidence)
        { atMs: 5000, costUsd: 3.0 }, // outside every segment → gap spend
      ],
    });
    await rollup(db, "s-gap");

    const row = await readMetrics(db, "s-gap");
    assert.ok(row);
    assert.ok(approx(row.total_spend_usd, 5.0), "total includes gap spend");
    const tierSum =
      row.spend_low_conf_usd +
      row.spend_medium_conf_usd +
      row.spend_high_conf_usd;
    // The three tiers partition ONLY the 2.00 segment-attributed spend, NOT the
    // 5.00 total — the out-of-segment 3.00 belongs to no confidence bucket.
    assert.ok(
      approx(tierSum, 2.0),
      `tiers sum to attributed spend, got ${tierSum}`
    );
    assert.ok(approx(row.spend_high_conf_usd, 2.0));
    assert.ok(
      tierSum < row.total_spend_usd,
      "gap spend sits in total but in no confidence tier"
    );
    // Coverage denominator still includes the gap (2.00 covered / 5.00 total).
    assert.ok(approx(row.covered_spend_usd, 2.0));
    assert.ok(approx(row.coverage, 0.4));
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Non-ISO token_events timestamps excluded (human review question) ───────────

test("a non-ISO token_events.created_at is excluded, so it cannot depress coverage", async () => {
  const { db, dir } = await openTempDb();
  try {
    await seedSession(db, {
      id: "s-noniso",
      harness: "claude_code",
      humanTurns: 3,
      agentTurns: 1,
      runtimeMs: 2 * MIN,
      startedDay: "2026-07-01",
      userId: "u",
      segments: [
        {
          id: "iso1",
          phase: "implement",
          startMs: 0,
          endMs: 100,
          confidence: 0.9,
        },
      ],
      tokens: [{ atMs: 50, costUsd: 2.0 }], // ISO, inside seg → covered
    });
    // A legacy/pre-migration row whose created_at is NOT ISO (epoch-ms as text).
    // The ISO GLOB guard excludes it from BOTH numerator and denominator; without
    // the guard it would fall into gapSpend and artificially depress coverage.
    await db.run(
      `INSERT INTO token_events (session_id, model, created_at, cost_usd_estimated)
       VALUES ('s-noniso', 'legacy', '1719835200000', 10.0)`
    );
    await rollup(db, "s-noniso");

    const row = await readMetrics(db, "s-noniso");
    assert.ok(row);
    // The 10.00 non-ISO row is excluded: total is the 2.00 ISO spend only.
    assert.ok(
      approx(row.total_spend_usd, 2.0),
      `non-ISO row excluded from total, got ${row.total_spend_usd}`
    );
    assert.ok(approx(row.covered_spend_usd, 2.0));
    assert.ok(
      approx(row.coverage, 1.0),
      "coverage is not depressed by the unparseable-timestamp row"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Test 7: cohort-derivation boundaries (pure, table-driven) ──────────────────

test("autonomyIndexFromTurns maps turn counts to a 0..100 index", () => {
  assert.equal(autonomyIndexFromTurns(0, 0), 0); // turn-less → 0
  assert.equal(autonomyIndexFromTurns(10, 0), 0); // all human → 0
  assert.equal(autonomyIndexFromTurns(0, 10), 100); // all agent → 100
  assert.equal(autonomyIndexFromTurns(1, 1), 50); // even split → 50
});

test("deriveCohorts buckets autonomy/length/identity/harness at the band boundaries", () => {
  const base = {
    harness: "claude_code",
    humanTurns: 1,
    agentTurns: 1,
    runtimeMs: 0,
  };
  const noIdentity = { userId: null, organizationId: null };

  // Autonomy bands (cut-points 34 / 67, from the module):
  // index 33.33 (human_steered) | 34 (mixed) | 66.67 (mixed) | 67 (agentic).
  assert.equal(
    deriveCohorts({ ...base, humanTurns: 2, agentTurns: 1 }, noIdentity)
      .autonomyBand,
    AutonomyBand.HumanSteered
  );
  assert.equal(
    deriveCohorts({ ...base, humanTurns: 66, agentTurns: 34 }, noIdentity)
      .autonomyBand,
    AutonomyBand.Mixed
  );
  assert.equal(
    deriveCohorts({ ...base, humanTurns: 33, agentTurns: 67 }, noIdentity)
      .autonomyBand,
    AutonomyBand.Agentic
  );

  // Length bands (cut-points 5min / 30min):
  assert.equal(
    deriveCohorts({ ...base, runtimeMs: 0 }, noIdentity).lengthBand,
    LengthBand.Short
  );
  assert.equal(
    deriveCohorts({ ...base, runtimeMs: 5 * MIN - 1 }, noIdentity).lengthBand,
    LengthBand.Short
  );
  assert.equal(
    deriveCohorts({ ...base, runtimeMs: 5 * MIN }, noIdentity).lengthBand,
    LengthBand.Medium
  );
  assert.equal(
    deriveCohorts({ ...base, runtimeMs: 30 * MIN - 1 }, noIdentity).lengthBand,
    LengthBand.Medium
  );
  assert.equal(
    deriveCohorts({ ...base, runtimeMs: 30 * MIN }, noIdentity).lengthBand,
    LengthBand.Long
  );
  assert.equal(
    deriveCohorts({ ...base, runtimeMs: null }, noIdentity).lengthBand,
    LengthBand.Short
  );

  // ClosedLoop-user axis: any non-null identity ⇒ true.
  assert.equal(
    deriveCohorts(base, { userId: "u", organizationId: null }).closedloopUser,
    true
  );
  assert.equal(
    deriveCohorts(base, { userId: null, organizationId: "o" }).closedloopUser,
    true
  );
  assert.equal(deriveCohorts(base, noIdentity).closedloopUser, false);

  // Harness passes through (including null).
  assert.equal(deriveCohorts(base, noIdentity).harness, "claude_code");
  assert.equal(
    deriveCohorts({ ...base, harness: null }, noIdentity).harness,
    null
  );
});
