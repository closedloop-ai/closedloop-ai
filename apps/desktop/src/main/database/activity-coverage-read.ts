/**
 * @file activity-coverage-read.ts
 * @description ISS-6758 (PRD-488 FR-12): the cohort READ over
 * `session_activity_metrics`.
 *
 * `activity-metrics.ts` has said since FEA-2273 that "per-cohort aggregation
 * happens at read time via a GROUP BY over the persisted rows", and migration
 * 0027 built the table (and its `harness` index) for exactly that read. Nothing
 * implemented it: every non-test reference to the table was a writer, a purge, or
 * the backfill's own staleness check, so the per-import rollup cost bought
 * nothing and FR-12 ("emit coverage and confidence metrics that can be sliced per
 * cohort ... so weak cohorts are visible") was unmet. This file is that read.
 *
 * Two things it deliberately does NOT do:
 *
 *  - It does not derive bucket keys in SQL. A `COALESCE(harness, 'unknown')` or a
 *    `CASE closedloop_user WHEN 1 THEN 'closedloop'` would be a second copy of
 *    the metric module's axis mapping, free to drift from it silently. SQL groups
 *    on the RAW cohort columns; `cohortValue` (attribution-metrics.ts) lands each
 *    group in its bucket, and `coverageCellFromMicro` applies the module's own
 *    ratio guard and `MIN_COHORT_CELL_SESSIONS` low-sample rule.
 *  - It does not group on `started_day`. That column is storage-only and NOT a
 *    cohort axis (ISS-6760): it is a stored UTC day, while every other desktop
 *    day series buckets in the user's local calendar, so grouping by it would put
 *    non-UTC users' activity on the wrong day. Its index was dropped for that
 *    reason and this read does not resurrect the axis.
 *
 *  - It does not blend formula versions. `ATTRIBUTION_METRIC_VERSION` is the
 *    Coverage FORMULA a row's numbers were produced under (ISS-6759), and the
 *    boot backfill re-derives a behind-version row — but it logs-and-skips a
 *    failed chunk, so a store can hold two formulas for a whole app run. A ratio
 *    summed across both is a number produced by neither, so off-formula rows are
 *    excluded from every cell and COUNTED, because a silently narrowed corpus is
 *    indistinguishable from a complete one.
 *
 *    The count is split by DIRECTION, because the two directions have different
 *    futures and the panel makes a promise about one of them. The backfill
 *    selects `sam.metric_version < ATTRIBUTION_METRIC_VERSION`, so a BEHIND row
 *    is re-derived on the next boot. An AHEAD row — this build running against a
 *    store a newer build wrote — is never re-selected, and its numbers came from
 *    a formula this build does not implement, so it stays excluded indefinitely.
 *    Reporting both under one "will be re-derived" count would state something
 *    that never comes true.
 *
 *    The CLASSIFIER axis (`version`) is deliberately not filtered: detecting it
 *    needs the whole-`session_activity_segments` GROUP BY the backfill already
 *    does, which is far too heavy for a panel read, and the backfill converges
 *    it on the next boot.
 *
 * Aggregation is in integer micro-cents, the same exact-aggregate convention the
 * writer and the metric module use, so folding many cohort cells onto an axis
 * cannot accumulate float error. The one place floats survive is SQLite's `SUM`
 * WITHIN a single cell — unavoidable, because the persisted columns are REAL USD
 * and exactness ended when the row was written; grouping first keeps the number
 * of such sums bounded (harness x autonomy x closedloop x length) instead of one
 * per session.
 */

import { AutonomyBand } from "@repo/api/src/types/session-activity-metrics";
import type {
  ActivityCoverageAxis,
  ActivityCoverageBucket,
  ActivityCoverageCell,
  ActivityCoverageData,
} from "../../shared/diagnostics-contract.js";
import type { Harness } from "../collectors/types.js";
import { microCentsToUsd, usdToMicroCents } from "../cost/cost-math.js";
import {
  ATTRIBUTION_METRIC_VERSION,
  COHORT_AXIS_VALUES,
  CohortAxis,
  cohortValue,
  coverageCellFromMicro,
  LengthBand,
  type SessionCohort,
} from "../telemetry/attribution-metrics.js";
import type { DesktopPrisma } from "./prisma-client.js";

/**
 * One raw read, already bound to wherever it should run. Narrowed to a function
 * rather than taking a whole client for two reasons: the degradation path below
 * can be exercised against a source that throws without standing up a store, and
 * the dispatch decision (reader pool, not the writer) stays with the binder.
 */
export type ActivityCoverageRawRead = <T>(
  sql: string,
  ...values: unknown[]
) => Promise<T>;

/**
 * Bind the cohort read to a store's READER POOL (ISS-5938).
 *
 * This is a full scan plus a temp B-tree over a per-session table and the panel
 * that shows it polls, so it must not run on the writer connection that owns
 * sync durability — on a first launch it would serialize against the import.
 * The raw-SQL-on-the-pool shape is the proven-safe one; the FEA-2211 quirk that
 * keeps TYPED aggregates on `prisma.client` does not apply here.
 */
export function activityCoverageRawRead(
  prisma: DesktopPrisma
): ActivityCoverageRawRead {
  return <T>(sql: string, ...values: unknown[]) =>
    prisma.read((reader) => reader.$queryRawUnsafe<T>(sql, ...values));
}

/** One GROUP BY row: a distinct cohort combination and its summed spend. */
type CohortGroupRow = {
  harness: string | null;
  autonomy_band: string;
  /** 1/0 from SQLite. Typed with `bigint` for the same reason `session_count`
   * is: the adapter's INTEGER handling is not uniform, and `0n !== 0` would
   * silently collapse this whole axis into one bucket. */
  closedloop_user: number | bigint;
  /**
   * The row's Coverage formula relative to this build's: `0` current, `-1`
   * behind (the boot backfill re-derives it), `1` ahead (it never will).
   */
  formula_offset: number | bigint;
  length_band: string;
  covered_spend_usd: number | null;
  total_spend_usd: number | null;
  spend_low_conf_usd: number | null;
  spend_medium_conf_usd: number | null;
  spend_high_conf_usd: number | null;
  session_count: number | bigint;
};

/** Running micro-cent totals for one bucket (or for the overall cell). */
type CoverageAccum = {
  coveredMicro: number;
  totalMicro: number;
  lowMicro: number;
  mediumMicro: number;
  highMicro: number;
  sessions: number;
};

function emptyAccum(): CoverageAccum {
  return {
    coveredMicro: 0,
    totalMicro: 0,
    lowMicro: 0,
    mediumMicro: 0,
    highMicro: 0,
    sessions: 0,
  };
}

function addAccum(target: CoverageAccum, source: CoverageAccum): void {
  target.coveredMicro += source.coveredMicro;
  target.totalMicro += source.totalMicro;
  target.lowMicro += source.lowMicro;
  target.mediumMicro += source.mediumMicro;
  target.highMicro += source.highMicro;
  target.sessions += source.sessions;
}

/** A `SUM(...)` over zero matching rows is SQL NULL, and an empty table's spend
 * is 0 — not "unknown" — so the null coalesces rather than propagating. */
function sumToMicro(value: number | null): number {
  return usdToMicroCents(value ?? 0);
}

function groupRowToAccum(row: CohortGroupRow): CoverageAccum {
  return {
    coveredMicro: sumToMicro(row.covered_spend_usd),
    totalMicro: sumToMicro(row.total_spend_usd),
    lowMicro: sumToMicro(row.spend_low_conf_usd),
    mediumMicro: sumToMicro(row.spend_medium_conf_usd),
    highMicro: sumToMicro(row.spend_high_conf_usd),
    sessions: Number(row.session_count),
  };
}

/**
 * The cohort tags of one GROUP BY row. The stored columns are free TEXT (the
 * taxonomy is data, not an enum constraint), so the band casts assert only what
 * the writer wrote; `cohortValue` passes every one of them through unexamined,
 * which is why an unrecognized band still gets its own honest bucket instead of
 * being folded into a neighbour.
 */
function rowCohort(row: CohortGroupRow): SessionCohort {
  return {
    harness: (row.harness as Harness | null) ?? null,
    autonomyBand: row.autonomy_band as AutonomyBand,
    closedloopUser: Number(row.closedloop_user) !== 0,
    lengthBand: row.length_band as LengthBand,
  };
}

function finalizeCell(accum: CoverageAccum): ActivityCoverageCell {
  const cell = coverageCellFromMicro(
    accum.coveredMicro,
    accum.totalMicro,
    accum.sessions
  );
  return {
    ...cell,
    spendLowConfUsd: microCentsToUsd(accum.lowMicro),
    spendMediumConfUsd: microCentsToUsd(accum.mediumMicro),
    spendHighConfUsd: microCentsToUsd(accum.highMicro),
  };
}

/**
 * The two ORDINAL axes, in the metric module's own declared band order.
 *
 * Sorting these lexicographically is not merely untidy, it inverts them:
 * `long < medium < short` renders the length axis backwards, and
 * `agentic < human_steered < mixed` puts the middle band last. This tab exists so
 * a trend across a band is readable, so it renders them in band order. Derived
 * from the const objects rather than restated — the declaration order IS the
 * ordinal order, and the cut-point docs in `attribution-metrics.ts` depend on it.
 *
 * The other two axes (harness, closedloop_user) have no ordering, so they stay
 * key-ascending, which at least makes their row order stable across reads.
 */
const ORDINAL_AXIS_BUCKETS: Partial<Record<CohortAxis, readonly string[]>> = {
  [CohortAxis.AutonomyBand]: Object.values(AutonomyBand),
  [CohortAxis.LengthBand]: Object.values(LengthBand),
};

function bucketComparator(
  axis: CohortAxis
): (a: ActivityCoverageBucket, b: ActivityCoverageBucket) => number {
  const order = ORDINAL_AXIS_BUCKETS[axis];
  return (a, b) => {
    if (order) {
      // A bucket the taxonomy no longer declares sorts after the declared ones
      // rather than silently landing among them.
      const ai = order.indexOf(a.bucket);
      const bi = order.indexOf(b.bucket);
      const rank = (ai < 0 ? order.length : ai) - (bi < 0 ? order.length : bi);
      if (rank !== 0) {
        return rank;
      }
    }
    if (a.bucket < b.bucket) {
      return -1;
    }
    if (a.bucket > b.bucket) {
      return 1;
    }
    return 0;
  };
}

/**
 * Fold the grouped rows onto every cohort axis. Exported (and pure) so the axis
 * mapping is unit-testable without a store — the SQL above is a plain GROUP BY
 * and it is this fold that carries the FR-12 semantics.
 */
export function foldCohortGroups(
  rows: readonly CohortGroupRow[]
): ActivityCoverageData {
  const overall = emptyAccum();
  let staleSessionCount = 0;
  let unrecognizedFormulaSessionCount = 0;
  const byAxis = new Map<CohortAxis, Map<string, CoverageAccum>>();
  for (const axis of COHORT_AXIS_VALUES) {
    byAxis.set(axis, new Map<string, CoverageAccum>());
  }

  for (const row of rows) {
    const accum = groupRowToAccum(row);
    // An off-formula row is counted and dropped, never summed into a cell — see
    // the file doc. Counting it is what keeps the exclusion from reading as a
    // smaller-but-complete corpus, and splitting the two directions is what
    // keeps the panel from promising a re-derivation that will never happen.
    const formulaOffset = Number(row.formula_offset);
    if (formulaOffset < 0) {
      staleSessionCount += accum.sessions;
      continue;
    }
    if (formulaOffset > 0) {
      unrecognizedFormulaSessionCount += accum.sessions;
      continue;
    }
    addAccum(overall, accum);
    const cohort = rowCohort(row);
    for (const axis of COHORT_AXIS_VALUES) {
      const buckets = byAxis.get(axis);
      if (!buckets) {
        continue;
      }
      const key = cohortValue(axis, cohort);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = emptyAccum();
        buckets.set(key, bucket);
      }
      addAccum(bucket, accum);
    }
  }

  const axes: ActivityCoverageAxis[] = COHORT_AXIS_VALUES.map((axis) => ({
    axis,
    buckets: [...(byAxis.get(axis)?.entries() ?? [])]
      .map(([bucket, accum]) => ({ bucket, cell: finalizeCell(accum) }))
      .sort(bucketComparator(axis)),
  }));

  return {
    overall: finalizeCell(overall),
    axes,
    staleSessionCount,
    unrecognizedFormulaSessionCount,
  };
}

/**
 * FR-12: Coverage + the reported-confidence distribution, overall and per cohort.
 *
 * One statement, one pass. The GROUP BY is over the four cohort columns jointly
 * rather than four separate per-axis queries: the combination cardinality is
 * bounded by the taxonomy (harness x 3 autonomy bands x 2 x 3 length bands), so
 * one narrow read serves every axis and the axes cannot disagree with each other
 * or with `overall` the way four independently-timed reads could.
 */
export async function getActivityCoverage(
  queryRaw: ActivityCoverageRawRead
): Promise<ActivityCoverageData> {
  const rows = await queryRaw<CohortGroupRow[]>(
    `SELECT harness,
            autonomy_band,
            closedloop_user,
            length_band,
            CASE
              WHEN metric_version < $1 THEN -1
              WHEN metric_version > $1 THEN 1
              ELSE 0
            END                        AS formula_offset,
            SUM(covered_spend_usd)     AS covered_spend_usd,
            SUM(total_spend_usd)       AS total_spend_usd,
            SUM(spend_low_conf_usd)    AS spend_low_conf_usd,
            SUM(spend_medium_conf_usd) AS spend_medium_conf_usd,
            SUM(spend_high_conf_usd)   AS spend_high_conf_usd,
            COUNT(*)                   AS session_count
     FROM session_activity_metrics
     GROUP BY harness, autonomy_band, closedloop_user, length_band, formula_offset`,
    ATTRIBUTION_METRIC_VERSION
  );
  return foldCohortGroups(rows);
}

/**
 * {@link getActivityCoverage}, degraded to UNKNOWN rather than to a zeroed
 * payload when it cannot run.
 *
 * The rest of the diagnostics payload is independent of this read, so one
 * failure must not take the whole panel down — but a caught failure must not be
 * laundered into `overall.sessionCount: 0` either, which reads as the measured
 * answer "nothing has been rolled up". Two real triggers: an untracked/partial
 * store where `session_activity_metrics` has not been created yet, and a corpus
 * whose summed spend leaves the JS-safe micro-cent range (cost-math throws
 * rather than return a lossy total). Both mean UNKNOWN, and `undefined` is how
 * the diagnostics contract spells it.
 */
export async function readActivityCoverageOrUnknown(
  queryRaw: ActivityCoverageRawRead,
  log: (message: string) => void
): Promise<ActivityCoverageData | undefined> {
  try {
    return await getActivityCoverage(queryRaw);
  } catch (error) {
    // The panel can only say "unavailable"; the two triggers are very different
    // problems and are indistinguishable from the screen, so the reason goes to
    // the log the rest of the store's boot work already writes to.
    log(
      `activity-coverage read failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }
}
