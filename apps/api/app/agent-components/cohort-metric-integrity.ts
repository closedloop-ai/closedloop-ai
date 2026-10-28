// Corrupt persisted values reaching the Agents cohort/baseline LOC/$ read.
//
// `SessionDetail.estimated_cost`, `lines_added` and `lines_removed` are plain
// nullable numeric columns with no CHECK behind them, so a negative is reachable
// from a corrupt write even though no ingest path produces one. The LOC/$ owner
// already refuses to divide with such a row (`locPerDollarDenominatorCost`), and
// that is the right answer for the READER — but on its own it makes the bad row
// vanish: the card renders its unavailable state and nobody ever learns the row
// exists. AGENTS.md's bad-data contract is explicit that a value that cannot be
// right is never silently coerced away, and that server code routes it to a
// monitored structured-log event.
//
// This module is that monitored half, and the shared definition of what "corrupt"
// means for these columns. The metric still degrades to `null`; this is only how
// anyone finds out.

import { log } from "@repo/observability/log";

/** Which of the two LOC/$ populations the corrupt row was read for. */
export const CohortMetricScope = {
  Cohort: "cohort",
  Baseline: "baseline",
} as const;
export type CohortMetricScope =
  (typeof CohortMetricScope)[keyof typeof CohortMetricScope];

/**
 * The monitored event for a corrupt persisted metric value observed by a cohort
 * or baseline read. One constant, raised from both reads, so the alert key names
 * one condition instead of drifting into two half-watched spellings — the same
 * shape as `agent_components_page_data_partial_population`.
 */
export const CORRUPT_COHORT_METRIC_EVENT =
  "agent_components_cohort_corrupt_metric_value";

/**
 * What one read observed. The two reads can supply different halves, so a field
 * a read cannot answer is `null` ("not read here") rather than `0` ("read, and
 * clean") — the baseline reads a rowless aggregate and can DETECT a negative
 * cost via `_min` without being able to count the rows carrying one.
 */
export type CorruptCohortMetricCounts = {
  /** Rows whose persisted cost is negative, or `null` when only detected. */
  negativeCostRows: number | null;
  /** The most negative persisted cost observed, or `null` when none was. */
  minimumCostUsd: number | null;
  /** Rows whose persisted line counts are negative, or `null` when not read. */
  negativeLocRows: number | null;
  /** Rows the verdict was taken over. */
  rowCount: number;
};

/**
 * Raise the monitored event when a read observed a corrupt value. A clean read
 * emits nothing, so callers raise it unconditionally after the read rather than
 * duplicating the "is anything wrong" test at each site.
 */
export function reportCorruptCohortMetric(
  organizationId: string,
  scope: CohortMetricScope,
  counts: CorruptCohortMetricCounts
): void {
  if (!hasCorruptCohortMetric(counts)) {
    return;
  }
  log.error(CORRUPT_COHORT_METRIC_EVENT, {
    organizationId,
    scope,
    ...counts,
  });
}

/**
 * A NEGATIVE line count is corrupt, not merely unmeasured. `isLocEnriched` only
 * rules out nulls, and `sumSessionLocDedupedByBranch` clamps a negative entry to
 * zero, so without this predicate a corrupt row's clamped `0` is byte-identical
 * to a verified zero and the coverage verdict certifies it — rendering a
 * fabricated `-100%`.
 */
export function hasNegativeLoc(row: {
  linesAdded: number | null;
  linesRemoved: number | null;
}): boolean {
  return (row.linesAdded ?? 0) < 0 || (row.linesRemoved ?? 0) < 0;
}

function hasCorruptCohortMetric(counts: CorruptCohortMetricCounts): boolean {
  return (
    (counts.negativeCostRows ?? 0) > 0 ||
    (counts.negativeLocRows ?? 0) > 0 ||
    (counts.minimumCostUsd !== null && counts.minimumCostUsd < 0)
  );
}

/**
 * ISS-9853: the monitored event for a cohort whose whole-cohort baseline
 * exclusion cannot be built — the `notIn` would put the statement past the
 * driver's bind-parameter ceiling, so every delta is published `null` rather
 * than against a leaky baseline. Error level, like
 * {@link CORRUPT_COHORT_METRIC_EVENT}, so it reaches the alerting path: this is
 * the one residual where a large cohort loses a capability, and an SRE should
 * see it before a customer asks why the chip went blank.
 */
export const COHORT_BASELINE_OVER_BIND_CEILING_EVENT =
  "agent_components_cohort_baseline_over_bind_ceiling";

export function reportBaselineOverBindCeiling(
  organizationId: string,
  counts: { cohortSize: number; bindParameters: number; ceiling: number }
): void {
  log.error(COHORT_BASELINE_OVER_BIND_CEILING_EVENT, {
    organizationId,
    ...counts,
  });
}
