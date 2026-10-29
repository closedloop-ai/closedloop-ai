/**
 * @file activity-coverage-read.test.ts
 * @description ISS-6758 (PRD-488 FR-12) tests for the cohort READ over
 * `session_activity_metrics` — the GROUP BY `activity-metrics.ts` has named
 * since FEA-2273 and that nothing implemented, leaving every persisted row
 * write-only.
 *
 * Two layers, deliberately. The pure fold (`foldCohortGroups`) is where the FR-12
 * semantics live — which bucket a row lands in, how cells combine, when a cell is
 * low-sample — so it is table-tested directly without a store. The DB-backed test
 * then pins the one thing the fold cannot: that the SQL selects the columns the
 * fold reads, from real rows the writer produced.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AutonomyBand } from "@repo/api/src/types/session-activity-metrics";
import { test } from "vitest";
import {
  type ActivityCoverageRawRead,
  activityCoverageRawRead,
  foldCohortGroups,
  getActivityCoverage,
  readActivityCoverageOrUnknown,
} from "../src/main/database/activity-coverage-read.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  ATTRIBUTION_METRIC_VERSION,
  CohortAxis,
  LengthBand,
  MIN_COHORT_CELL_SESSIONS,
  UNKNOWN_HARNESS_KEY,
} from "../src/main/telemetry/attribution-metrics.js";

const NOW = "2026-07-01T12:00:00.000Z";

const MISSING_TABLE_RE = /no such table: session_activity_metrics/;

const close = 1e-9;
function approx(a: number, b: number): boolean {
  return Math.abs(a - b) <= close;
}

type GroupRow = Parameters<typeof foldCohortGroups>[0][number];

function group(overrides: Partial<GroupRow>): GroupRow {
  return {
    harness: "claude_code",
    autonomy_band: AutonomyBand.HumanSteered,
    closedloop_user: 1,
    length_band: LengthBand.Short,
    formula_offset: 0,
    covered_spend_usd: 0,
    total_spend_usd: 0,
    spend_low_conf_usd: 0,
    spend_medium_conf_usd: 0,
    spend_high_conf_usd: 0,
    session_count: 1,
    ...overrides,
  };
}

// These throw rather than assert: biome's `noMisplacedAssertion` reserves
// assertions for the test body, and a missing axis/bucket is a lookup failure in
// the fixture, not the claim under test.
function axis(
  result: ReturnType<typeof foldCohortGroups>,
  wanted: string
): ReturnType<typeof foldCohortGroups>["axes"][number] {
  const found = result.axes.find((a) => a.axis === wanted);
  if (!found) {
    throw new Error(`axis ${wanted} must be present`);
  }
  return found;
}

function bucket(
  result: ReturnType<typeof foldCohortGroups>,
  wantedAxis: string,
  wantedBucket: string
) {
  const found = axis(result, wantedAxis).buckets.find(
    (b) => b.bucket === wantedBucket
  );
  if (!found) {
    throw new Error(`bucket ${wantedAxis}/${wantedBucket} must be present`);
  }
  return found.cell;
}

// ── The fold: FR-12 slicing semantics ────────────────────────────────────────

test("ISS-6758: coverage is re-aggregated per axis as SUM(covered)/SUM(total)", () => {
  const result = foldCohortGroups([
    group({
      harness: "claude_code",
      autonomy_band: AutonomyBand.HumanSteered,
      covered_spend_usd: 3,
      total_spend_usd: 4,
      session_count: 1,
    }),
    group({
      harness: "claude_code",
      autonomy_band: AutonomyBand.Mixed,
      covered_spend_usd: 2,
      total_spend_usd: 2,
      session_count: 1,
    }),
    group({
      harness: "codex",
      autonomy_band: AutonomyBand.Agentic,
      closedloop_user: 0,
      length_band: LengthBand.Long,
      covered_spend_usd: 0,
      total_spend_usd: 5,
      session_count: 1,
    }),
  ]);

  // The whole point of the table: coverage that DIFFERS across a cohort axis.
  const cc = bucket(result, CohortAxis.Harness, "claude_code");
  const cx = bucket(result, CohortAxis.Harness, "codex");
  assert.ok(approx(cc.coverage, 5 / 6));
  assert.ok(approx(cx.coverage, 0));
  assert.equal(cc.sessionCount, 2);
  assert.equal(cx.sessionCount, 1);

  // Every axis re-partitions the SAME corpus, so each one's cells must still sum
  // back to `overall` — a fold that dropped or double-counted a group would show
  // up here and nowhere in a single-axis assertion.
  assert.ok(approx(result.overall.coverage, 5 / 11));
  assert.equal(result.overall.sessionCount, 3);
  for (const oneAxis of result.axes) {
    const sessions = oneAxis.buckets.reduce(
      (sum, b) => sum + b.cell.sessionCount,
      0
    );
    const total = oneAxis.buckets.reduce(
      (sum, b) => sum + b.cell.totalSpendUsd,
      0
    );
    assert.equal(sessions, result.overall.sessionCount, oneAxis.axis);
    assert.ok(approx(total, result.overall.totalSpendUsd), oneAxis.axis);
  }
});

test("ISS-6758: bucket keys come from the metric module, not from SQL", () => {
  const result = foldCohortGroups([
    group({ harness: null, closedloop_user: 0 }),
    group({ harness: "codex", closedloop_user: 1 }),
  ]);

  // A null harness is the module's `unknown` bucket, and the boolean axis uses
  // its closedloop/external names — neither is spelled in the SQL.
  assert.ok(
    axis(result, CohortAxis.Harness).buckets.some(
      (b) => b.bucket === UNKNOWN_HARNESS_KEY
    )
  );
  assert.deepEqual(
    axis(result, CohortAxis.ClosedloopUser).buckets.map((b) => b.bucket),
    ["closedloop", "external"]
  );
  // Buckets are key-ascending so the panel's row order is stable across reads.
  assert.deepEqual(
    axis(result, CohortAxis.Harness).buckets.map((b) => b.bucket),
    ["codex", UNKNOWN_HARNESS_KEY]
  );
});

test("ISS-6758: the ordinal axes render in band order, not alphabetically", () => {
  const result = foldCohortGroups([
    group({
      autonomy_band: AutonomyBand.Agentic,
      length_band: LengthBand.Long,
    }),
    group({
      autonomy_band: AutonomyBand.Mixed,
      length_band: LengthBand.Medium,
    }),
    group({
      autonomy_band: AutonomyBand.HumanSteered,
      length_band: LengthBand.Short,
    }),
  ]);

  // Alphabetically these are agentic/human_steered/mixed and long/medium/short —
  // the middle band last, and the length axis exactly reversed. A reader
  // scanning for the trend this tab exists to expose would read it backwards.
  assert.deepEqual(
    axis(result, CohortAxis.AutonomyBand).buckets.map((b) => b.bucket),
    [AutonomyBand.HumanSteered, AutonomyBand.Mixed, AutonomyBand.Agentic]
  );
  assert.deepEqual(
    axis(result, CohortAxis.LengthBand).buckets.map((b) => b.bucket),
    [LengthBand.Short, LengthBand.Medium, LengthBand.Long]
  );
});

test("ISS-6758: a band the taxonomy no longer declares sorts after the declared ones", () => {
  const result = foldCohortGroups([
    group({ autonomy_band: AutonomyBand.Agentic }),
    group({ autonomy_band: "retired_band" }),
    group({ autonomy_band: AutonomyBand.HumanSteered }),
  ]);
  assert.deepEqual(
    axis(result, CohortAxis.AutonomyBand).buckets.map((b) => b.bucket),
    [AutonomyBand.HumanSteered, AutonomyBand.Agentic, "retired_band"]
  );
});

test("ISS-6758: a thin cell is flagged low-sample, not hidden or zeroed", () => {
  const thin = MIN_COHORT_CELL_SESSIONS - 1;
  const result = foldCohortGroups([
    group({
      harness: "cursor",
      covered_spend_usd: 1,
      total_spend_usd: 2,
      session_count: thin,
    }),
    group({
      harness: "claude_code",
      covered_spend_usd: 1,
      total_spend_usd: 2,
      session_count: MIN_COHORT_CELL_SESSIONS,
    }),
  ]);

  const cursor = bucket(result, CohortAxis.Harness, "cursor");
  assert.equal(cursor.lowSample, true);
  // Low sample is a caveat on a REAL value: the numbers must still be there, or
  // the panel could only render it as missing data.
  assert.ok(approx(cursor.coverage, 0.5));
  assert.ok(approx(cursor.totalSpendUsd, 2));
  assert.equal(
    bucket(result, CohortAxis.Harness, "claude_code").lowSample,
    false
  );
});

test("ISS-6758: an empty table yields a defined zero, and every axis is present", () => {
  const result = foldCohortGroups([]);
  assert.equal(result.overall.sessionCount, 0);
  assert.equal(result.overall.coverage, 0);
  assert.equal(result.overall.totalSpendUsd, 0);
  assert.ok(Number.isFinite(result.overall.coverage));
  // The axes exist with no buckets — "no session rolled up yet", which is a
  // different claim from the payload being absent entirely.
  assert.deepEqual(
    result.axes.map((a) => a.axis),
    [
      CohortAxis.Harness,
      CohortAxis.AutonomyBand,
      CohortAxis.ClosedloopUser,
      CohortAxis.LengthBand,
    ]
  );
  for (const oneAxis of result.axes) {
    assert.deepEqual(oneAxis.buckets, []);
  }
});

test("ISS-6758: a zero-spend cohort reports 0 coverage rather than NaN", () => {
  const result = foldCohortGroups([
    group({ harness: "opencode", covered_spend_usd: 0, total_spend_usd: 0 }),
  ]);
  const cell = bucket(result, CohortAxis.Harness, "opencode");
  assert.equal(cell.coverage, 0);
  assert.equal(Number.isNaN(cell.coverage), false);
});

test("ISS-6758: SQL NULL sums (no matching rows) coalesce to zero spend", () => {
  const result = foldCohortGroups([
    group({
      covered_spend_usd: null,
      total_spend_usd: null,
      spend_low_conf_usd: null,
      spend_medium_conf_usd: null,
      spend_high_conf_usd: null,
      session_count: 1,
    }),
  ]);
  assert.equal(result.overall.totalSpendUsd, 0);
  assert.equal(result.overall.spendHighConfUsd, 0);
  assert.equal(result.overall.sessionCount, 1);
});

test("ISS-6758: the confidence distribution is summed per cohort too", () => {
  const result = foldCohortGroups([
    group({
      harness: "claude_code",
      total_spend_usd: 10,
      covered_spend_usd: 6,
      spend_low_conf_usd: 1,
      spend_medium_conf_usd: 2,
      spend_high_conf_usd: 4,
    }),
    group({
      harness: "claude_code",
      autonomy_band: AutonomyBand.Agentic,
      total_spend_usd: 10,
      covered_spend_usd: 4,
      spend_low_conf_usd: 3,
      spend_medium_conf_usd: 0,
      spend_high_conf_usd: 5,
    }),
  ]);
  const cc = bucket(result, CohortAxis.Harness, "claude_code");
  assert.ok(approx(cc.spendLowConfUsd, 4));
  assert.ok(approx(cc.spendMediumConfUsd, 2));
  assert.ok(approx(cc.spendHighConfUsd, 9));
  // The three tiers bin only SEGMENT-ATTRIBUTED spend, so they fall short of the
  // total whenever a session had spend in no segment. Pinned so a future change
  // cannot start presenting them as a partition of the total.
  assert.ok(
    cc.spendLowConfUsd + cc.spendMediumConfUsd + cc.spendHighConfUsd <
      cc.totalSpendUsd
  );
});

// ── The statement: it reads real persisted rows ──────────────────────────────

test("ISS-6758: getActivityCoverage reads the rows the writer persisted", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "activity-coverage-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => NOW,
  });
  try {
    await db.whenBootMaintenanceSettled();
    await db.run("DELETE FROM session_activity_metrics");

    // An empty store must read as "nothing rolled up", not as a failure.
    const empty = await getActivityCoverage(activityCoverageRawRead(db.prisma));
    assert.equal(empty.overall.sessionCount, 0);

    for (const [id, harness, covered, total] of [
      ["m-1", "claude_code", 3, 4],
      ["m-2", "claude_code", 2, 2],
      ["m-3", "codex", 0, 5],
    ] as const) {
      await db.run(
        `INSERT INTO session_activity_metrics
           (session_id, harness, autonomy_band, closedloop_user, length_band,
            started_day, coverage, covered_spend_usd, total_spend_usd,
            spend_low_conf_usd, spend_medium_conf_usd, spend_high_conf_usd,
            segment_count, covered_segment_count, version, metric_version, updated_at)
         VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, 0, 0, $7, 1, 1, 4, 1, $9)`,
        id,
        harness,
        harness === "codex" ? AutonomyBand.Agentic : AutonomyBand.HumanSteered,
        harness === "codex" ? 0 : 1,
        harness === "codex" ? LengthBand.Long : LengthBand.Short,
        covered / total,
        covered,
        total,
        NOW
      );
    }

    const result = await getActivityCoverage(
      activityCoverageRawRead(db.prisma)
    );
    assert.equal(result.overall.sessionCount, 3);
    assert.ok(approx(result.overall.coverage, 5 / 11));
    const byHarness = axis(result, CohortAxis.Harness);
    assert.deepEqual(
      byHarness.buckets.map((b) => b.bucket),
      ["claude_code", "codex"]
    );
    assert.ok(
      approx(bucket(result, CohortAxis.Harness, "claude_code").coverage, 5 / 6)
    );
    assert.ok(approx(bucket(result, CohortAxis.Harness, "codex").coverage, 0));
    // The non-harness axes come from the same read, so a column the SQL forgot
    // to select would collapse them rather than fail loudly.
    assert.deepEqual(
      axis(result, CohortAxis.ClosedloopUser).buckets.map((b) => b.bucket),
      ["closedloop", "external"]
    );
    assert.deepEqual(
      axis(result, CohortAxis.LengthBand).buckets.map((b) => b.bucket),
      // Band order, not alphabetical — see the ordinal-axis test above.
      [LengthBand.Short, LengthBand.Long]
    );
    assert.equal(result.staleSessionCount, 0);

    // One row on an older formula: the statement must classify it, so the SQL
    // CASE and the fold agree about which rows are countable.
    await db.run(
      `INSERT INTO session_activity_metrics
         (session_id, harness, autonomy_band, closedloop_user, length_band,
          started_day, coverage, covered_spend_usd, total_spend_usd,
          spend_low_conf_usd, spend_medium_conf_usd, spend_high_conf_usd,
          segment_count, covered_segment_count, version, metric_version, updated_at)
       VALUES ('m-old', 'claude_code', $1, 1, $2, NULL, 0, 0, 100, 0, 0, 0, 1, 0, 4, $3, $4)`,
      AutonomyBand.HumanSteered,
      LengthBand.Short,
      ATTRIBUTION_METRIC_VERSION - 1,
      NOW
    );
    const withStale = await getActivityCoverage(
      activityCoverageRawRead(db.prisma)
    );
    assert.equal(withStale.staleSessionCount, 1);
    // The $100 off-formula row would have swamped the ratio had it been summed.
    assert.equal(withStale.overall.sessionCount, 3);
    assert.ok(approx(withStale.overall.coverage, 5 / 11));
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Formula-version isolation (ISS-6759 hazard) ──────────────────────────────

test("ISS-6758: an off-formula row is excluded from every cell and counted", () => {
  const result = foldCohortGroups([
    group({
      harness: "claude_code",
      covered_spend_usd: 8,
      total_spend_usd: 8,
      session_count: 4,
    }),
    // Same cohort, computed under an older Coverage formula. Summed in, it would
    // drag the reported claude_code coverage to 8/16 = 50% — a number NEITHER
    // formula produced.
    group({
      harness: "claude_code",
      formula_offset: -1,
      covered_spend_usd: 0,
      total_spend_usd: 8,
      session_count: 2,
    }),
  ]);

  assert.ok(
    approx(bucket(result, CohortAxis.Harness, "claude_code").coverage, 1)
  );
  assert.equal(result.overall.sessionCount, 4);
  assert.ok(approx(result.overall.coverage, 1));
  // Excluded, but SAID — a silently narrowed corpus reads as a complete one.
  assert.equal(result.staleSessionCount, 2);
  assert.equal(result.unrecognizedFormulaSessionCount, 0);
});

test("ISS-6758: a row AHEAD of this build's formula is counted apart from a stale one", () => {
  const result = foldCohortGroups([
    group({ session_count: 3, covered_spend_usd: 1, total_spend_usd: 1 }),
    group({ formula_offset: -1, session_count: 2 }),
    // Written by a NEWER build. The backfill only re-selects rows that are
    // BEHIND, so this one never converges — telling the user it will be
    // re-derived on the next start would be a promise that never comes true.
    group({ formula_offset: 1, session_count: 5 }),
  ]);
  assert.equal(result.overall.sessionCount, 3);
  assert.equal(result.staleSessionCount, 2);
  assert.equal(result.unrecognizedFormulaSessionCount, 5);
});

test("ISS-6758: a corpus entirely on the current formula reports no stale sessions", () => {
  const result = foldCohortGroups([group({ session_count: 3 })]);
  assert.equal(result.staleSessionCount, 0);
  assert.equal(result.unrecognizedFormulaSessionCount, 0);
});

test("ISS-6758: a bigint 0/1 from the driver does not collapse the boolean axis", () => {
  // The adapter's INTEGER handling is not uniform, and `0n !== 0` is true — a
  // strict compare here would put every session in the `closedloop` bucket.
  const result = foldCohortGroups([
    group({ closedloop_user: 0n, formula_offset: 0n }),
    group({ closedloop_user: 1n, formula_offset: 0n, harness: "codex" }),
  ]);
  assert.deepEqual(
    axis(result, CohortAxis.ClosedloopUser).buckets.map((b) => b.bucket),
    ["closedloop", "external"]
  );
  assert.equal(result.staleSessionCount, 0);
});

// ── Degradation: UNKNOWN, never a zeroed payload ─────────────────────────────

test("ISS-6758: a failing read degrades to undefined, not to a measured zero", async () => {
  const logged: string[] = [];
  const failing: ActivityCoverageRawRead = () =>
    Promise.reject(new Error("no such table: session_activity_metrics"));
  assert.equal(
    await readActivityCoverageOrUnknown(failing, logged.push.bind(logged)),
    undefined
  );
  // The panel can only say "unavailable"; the reason has to reach the log or an
  // operator cannot tell a missing table from an out-of-range aggregate.
  assert.equal(logged.length, 1);
  assert.match(logged[0], MISSING_TABLE_RE);
});

test("ISS-6758: a succeeding read is returned unchanged by the degrading wrapper", async () => {
  const rows = [group({ covered_spend_usd: 1, total_spend_usd: 2 })];
  const source: ActivityCoverageRawRead = <T>(
    _sql: string,
    ...values: unknown[]
  ) => {
    // The formula version is bound as a parameter, not inlined, so a bump
    // cannot leave the CASE comparing against a stale literal.
    assert.deepEqual(values, [ATTRIBUTION_METRIC_VERSION]);
    return Promise.resolve(rows as T);
  };
  const result = await readActivityCoverageOrUnknown(source, () => undefined);
  assert.ok(result);
  assert.ok(approx(result.overall.coverage, 0.5));
});
