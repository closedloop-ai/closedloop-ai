/**
 * @file activity-metrics-metric-version.test.ts
 * @description ISS-6759 — the SECOND staleness axis on
 * `session_activity_metrics`.
 *
 * `ATTRIBUTION_METRIC_VERSION` exists so a change to the Coverage math forces
 * every persisted row to be recomputed, but nothing in production imported it:
 * the row's `version` column is the segment CLASSIFIER version, and
 * `backfillActivityMetrics` re-selected only on `sam.version < seg.version`. A
 * formula bump moves neither side of that comparison, so old rows survived it and
 * the table would hold two formulas at once. Migration 0059 adds
 * `metric_version`, the rollup stamps it, and the backfill ORs it into the
 * predicate.
 *
 * The first two assertions pull in opposite directions, which is the whole reason
 * both exist:
 *  1. a row stamped BELOW the current metric version is re-selected and actually
 *     RECOMPUTED (not merely re-stamped), even though its classifier version is
 *     current on both sides;
 *  2. a row that predates migration 0059 and therefore adopts the column's DDL
 *     default is NOT re-selected. The default is 1 because
 *     `ATTRIBUTION_METRIC_VERSION` has been 1 since FEA-2266 introduced it and
 *     this table was created later (migration 0027), so those rows genuinely are
 *     current. A 0 floor would pass (1) and fail (2) by declaring every session on
 *     every install stale and re-deriving the whole corpus on the first boot after
 *     upgrade, to arrive at identical rows.
 *
 * The third pins the formula itself, so the stamp cannot quietly go out of date:
 * the persisted numbers come from this module's math AND the adapter's own
 * derivations, and nothing else in the suite would notice either changing.
 *
 * Lives in its own file rather than in `activity-metrics.test.ts` because that
 * file is at 962 lines against the repo's 1,000-line ceiling — the same reason
 * `activity-metrics-unrepresentable-span.test.ts` is separate.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AutonomyBand } from "@repo/api/src/types/session-activity-metrics";
import { test } from "vitest";
import { backfillActivityMetrics } from "../src/main/database/activity-metrics.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  ATTRIBUTION_METRIC_VERSION,
  LengthBand,
} from "../src/main/telemetry/attribution-metrics.js";

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const NOW = "2026-07-01T12:00:00.000Z";
/** The classifier version held in lockstep on both sides of `sam.version < seg.version`. */
const SEGMENT_VERSION = 4;

type MetricsRow = {
  coverage: number;
  covered_spend_usd: number;
  total_spend_usd: number;
  spend_low_conf_usd: number;
  spend_medium_conf_usd: number;
  spend_high_conf_usd: number;
  segment_count: number;
  covered_segment_count: number;
  version: number;
  metric_version: number;
};

type SeedSegment = {
  phase: string;
  startMs: number;
  endMs: number;
  conf: number;
};
type SeedToken = { atMs: number; costUsd: number };

/** The default one-covered-segment shape: coverage resolves to exactly 1. */
const DEFAULT_SEGMENTS: SeedSegment[] = [
  { phase: "implement", startMs: 0, endMs: 100, conf: 0.9 },
];
const DEFAULT_TOKENS: SeedToken[] = [{ atMs: 50, costUsd: 2.0 }];

async function openTempDb(): Promise<{ db: SqliteDb; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss6759-metric-version-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => NOW,
  });
  // The boot backfill is fire-and-forget; let it settle, then clear the table so
  // each test owns exactly the rows it seeds.
  await db.whenBootMaintenanceSettled();
  await db.run("DELETE FROM session_activity_metrics");
  return { db, dir };
}

/**
 * Seed one session with the three prerequisites the backfill joins on: the
 * session row, its `session_analytics` rollup (cohorts undecidable without it),
 * and the given segments plus token events. Defaults to one confident
 * `implement` segment covering its one token event — coverage exactly 1.
 */
async function seedSession(
  db: SqliteDb,
  sessionId: string,
  segments: SeedSegment[] = DEFAULT_SEGMENTS,
  tokens: SeedToken[] = DEFAULT_TOKENS
): Promise<void> {
  await db.run(
    `INSERT INTO sessions (id, name, status, started_at, updated_at, last_activity_at, harness, user_id, organization_id)
     VALUES ($1, $1, 'completed', $2, $2, $2, 'claude_code', NULL, NULL)`,
    sessionId,
    NOW
  );
  await db.run(
    `INSERT INTO session_analytics
       (session_id, harness, human_turns, agent_turns, runtime_ms, started_day, is_human, event_count, updated_at)
     VALUES ($1, 'claude_code', 2, 2, 240000, '2026-07-01', 0, 0, $2)`,
    sessionId,
    NOW
  );
  for (const [i, seg] of segments.entries()) {
    await db.run(
      `INSERT INTO session_activity_segments
         (id, session_id, phase, start_ms, end_ms, confidence, evidence_layers, version, work_item_ref, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6, '[]', $7, NULL, $8)`,
      `${sessionId}-seg-${i}`,
      sessionId,
      seg.phase,
      seg.startMs,
      seg.endMs,
      seg.conf,
      SEGMENT_VERSION,
      NOW
    );
  }
  for (const [i, tok] of tokens.entries()) {
    await db.run(
      `INSERT INTO token_events (session_id, model, created_at, cost_usd_estimated)
       VALUES ($1, $2, $3, $4)`,
      sessionId,
      `model-${i}`,
      new Date(tok.atMs).toISOString(),
      tok.costUsd
    );
  }
}

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

test("a formula-stale row is re-derived even though its classifier version is current", async () => {
  const { db, dir } = await openTempDb();
  try {
    await seedSession(db, "s-formula");
    await backfillActivityMetrics(db.prisma, () => undefined);

    const filled = await readMetrics(db, "s-formula");
    assert.ok(filled, "the session got a metrics row");
    assert.equal(
      filled.metric_version,
      ATTRIBUTION_METRIC_VERSION,
      "the rollup stamps the metric-formula version"
    );
    assert.equal(filled.version, SEGMENT_VERSION, "classifier version stamped");

    // Simulate a row written under an OLDER formula: drop only `metric_version`
    // and poison `coverage` with a value the real math can never produce. The
    // segment version is untouched, so `sam.version < seg.version` is false on
    // both sides — exactly the state a pure formula bump leaves behind, and the
    // state the pre-ISS-6759 predicate could not see.
    await db.run(
      "UPDATE session_activity_metrics SET metric_version = $1, coverage = -1 WHERE session_id = 's-formula'",
      ATTRIBUTION_METRIC_VERSION - 1
    );

    const logs: string[] = [];
    await backfillActivityMetrics(db.prisma, (m) => logs.push(m));

    const redone = await readMetrics(db, "s-formula");
    assert.equal(
      redone?.metric_version,
      ATTRIBUTION_METRIC_VERSION,
      "the metric-version-aware backfill re-selected the formula-stale row"
    );
    assert.equal(
      redone?.coverage,
      1,
      "the row was genuinely RECOMPUTED, not just re-stamped"
    );
    assert.equal(
      redone?.version,
      SEGMENT_VERSION,
      "a formula-only re-derive leaves the classifier stamp alone"
    );
    assert.ok(
      logs.some((m) => m.includes("activity-metrics backfill complete: 1/1")),
      `expected the formula-stale row to be re-selected, got: ${logs.join(" | ")}`
    );

    // Convergent on the new axis: the refreshed row is not re-selected again.
    const logs2: string[] = [];
    await backfillActivityMetrics(db.prisma, (m) => logs2.push(m));
    assert.equal(
      logs2.length,
      0,
      `nothing stale after the formula re-derive, got: ${logs2.join(" | ")}`
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a pre-migration row adopting metric_version's DDL default is not re-selected", async () => {
  const { db, dir } = await openTempDb();
  try {
    await seedSession(db, "s-legacy");
    // A row as a build predating migration 0059 wrote it: current classifier
    // version, and `metric_version` OMITTED so the column's DDL default is what
    // the upgraded store reads back. Those rows were computed under formula
    // version 1, so they are current and must not be swept.
    await db.run(
      `INSERT INTO session_activity_metrics
         (session_id, harness, autonomy_band, closedloop_user, length_band,
          started_day, coverage, covered_spend_usd, total_spend_usd,
          spend_low_conf_usd, spend_medium_conf_usd, spend_high_conf_usd,
          segment_count, covered_segment_count, version, updated_at)
       VALUES ($1, 'claude_code', $2, 0, $3, '2026-07-01', 1, 2, 2, 0, 0, 2, 1, 1, $4, $5)`,
      "s-legacy",
      AutonomyBand.Mixed,
      LengthBand.Short,
      SEGMENT_VERSION,
      NOW
    );
    assert.equal(
      (await readMetrics(db, "s-legacy"))?.metric_version,
      ATTRIBUTION_METRIC_VERSION,
      "the DDL default equals the formula version those rows were computed under"
    );

    const logs: string[] = [];
    await backfillActivityMetrics(db.prisma, (m) => logs.push(m));
    assert.equal(
      logs.length,
      0,
      `an already-current legacy row must not be re-selected, got: ${logs.join(" | ")}`
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * The MECHANICAL tie between "the formula changed" and "bump the constant".
 *
 * The stamp is only worth what its discipline is worth, and the persisted numbers
 * are produced by TWO modules: `attribution-metrics.ts` (coverage ratio,
 * confidence bins, the covered predicate) and `activity-metrics.ts`'s own
 * derivations (gap spend, the micro-cent tier split, `coveredSegmentCount`, the
 * `created_at` filter that decides the denominator). A change to either silently
 * re-defines what a row means, and nothing else in the suite would notice.
 *
 * This pins every persisted metric field for one fixture that exercises all of
 * them at once, so ANY such change turns red here. When it does, the correct
 * response is to update these expectations AND bump ATTRIBUTION_METRIC_VERSION
 * so the rows already on disk are re-derived — updating them alone reintroduces
 * ISS-6759.
 */
test("the persisted formula is pinned; changing it must also bump ATTRIBUTION_METRIC_VERSION", async () => {
  const { db, dir } = await openTempDb();
  try {
    await seedSession(
      db,
      "s-pinned",
      [
        // Confident + coverable → the numerator, and the `high` tier.
        { phase: "implement", startMs: 0, endMs: 100, conf: 0.9 },
        // Confident but an EXCLUDED state → `medium` tier spend, never covered.
        { phase: "other", startMs: 100, endMs: 200, conf: 0.6 },
        // Coverable state but NOT confident → `low` tier spend, never covered.
        { phase: "implement", startMs: 200, endMs: 300, conf: 0.2 },
      ],
      [
        { atMs: 50, costUsd: 2.0 },
        { atMs: 150, costUsd: 3.0 },
        { atMs: 250, costUsd: 1.0 },
        // Outside every span: implicit `other`. In the denominator, in no tier.
        { atMs: 900, costUsd: 4.0 },
      ]
    );
    await backfillActivityMetrics(db.prisma, () => undefined);

    const row = await readMetrics(db, "s-pinned");
    assert.ok(row, "the fixture session got a metrics row");
    assert.deepEqual(
      {
        coverage: row.coverage,
        covered_spend_usd: row.covered_spend_usd,
        total_spend_usd: row.total_spend_usd,
        spend_low_conf_usd: row.spend_low_conf_usd,
        spend_medium_conf_usd: row.spend_medium_conf_usd,
        spend_high_conf_usd: row.spend_high_conf_usd,
        segment_count: row.segment_count,
        covered_segment_count: row.covered_segment_count,
        metric_version: row.metric_version,
      },
      {
        // 2.00 covered / 10.00 total — the 4.00 gap sits in the denominator only.
        coverage: 0.2,
        covered_spend_usd: 2,
        total_spend_usd: 10,
        // The three tiers partition the SEGMENT-ATTRIBUTED 6.00, not the total.
        spend_low_conf_usd: 1,
        spend_medium_conf_usd: 3,
        spend_high_conf_usd: 2,
        segment_count: 3,
        covered_segment_count: 1,
        metric_version: ATTRIBUTION_METRIC_VERSION,
      },
      "persisted formula drifted — update these values AND bump ATTRIBUTION_METRIC_VERSION"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
