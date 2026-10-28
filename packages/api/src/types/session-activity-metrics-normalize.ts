/**
 * ISS-10721 — the validity boundary for a session activity-metrics rollup.
 *
 * Split from the constants module so a `"use client"` surface that renders a
 * band label does not pull the normalizer, and so the ingest writer and the read
 * projection share ONE notion of which values are impossible. Both sides run
 * this: a rollup is stored valid-or-absent, and a row that predates a tightened
 * predicate is still re-checked on the way out.
 *
 * WHAT COUNTS AS IMPOSSIBLE. Negative and non-finite are the two everyone
 * remembers; what actually reaches a column is the rest. A count arriving
 * fractional (`1.5` segments), a magnitude past the safe-integer range, a
 * coverage ratio above 1, a covered count larger than the population it is drawn
 * from, and a blank string that `Number("")` turns into a confident measured `0`
 * — each renders as a real measurement, which is worse than a refusal. Strings
 * are rejected by TYPE here rather than coerced, which closes the blank-string
 * case by construction.
 *
 * THE SPEND SPLIT IS ALL-OR-NOTHING. The three tiers partition the attributed
 * spend, so dropping one invalid tier and publishing the other two would not
 * narrow the sample, it would bias it: the surviving tiers would be read as the
 * whole attributed spend and every share computed from them would be inflated.
 * That is the one shape the partial-results rule excludes, so an invalid tier
 * withholds the split and nothing else — the band and the counts still publish.
 */

import {
  asAutonomyBand,
  type SessionActivityMetricsRead,
  UNKNOWN_SESSION_ACTIVITY_METRICS,
} from "./session-activity-metrics";

/**
 * The inclusive range a coverage ratio may take. Exported for the same reason
 * as {@link MAX_TIER_SPEND_USD}: the ingest schema bounds the same field, and
 * two hand-typed copies of a bound diverge silently the first time one is
 * widened.
 */
export const COVERAGE_RATIO_RANGE = { min: 0, max: 1 } as const;

/** The shape a stored row or a wire payload arrives in, before validation. */
export type RawSessionActivityMetrics = {
  autonomyBand?: unknown;
  coverage?: unknown;
  spendLowConfUsd?: unknown;
  spendMediumConfUsd?: unknown;
  spendHighConfUsd?: unknown;
  segmentCount?: unknown;
  coveredSegmentCount?: unknown;
  classifierVersion?: unknown;
  metricVersion?: unknown;
};

/** A finite `number` (not a numeric string), else null. */
function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A non-negative finite amount. Clamped at BOTH ends by the caller's bound. */
function nonNegativeAmount(
  value: unknown,
  maxInclusive: number
): number | null {
  const amount = finiteNumber(value);
  if (amount === null || amount < 0 || amount > maxInclusive) {
    return null;
  }
  return amount;
}

/**
 * The largest count any of these columns may carry.
 *
 * Every count and version here lands in a Postgres `INTEGER`, so a value the
 * safe-integer range accepts is still a `22003` at the write — which rolls the
 * session's whole transaction back and is re-attempted with the same poison
 * value on every retry. Exported because the ingest schema bounds the same
 * fields and the desktop projection drops them before the wire: three hand-typed
 * copies of one bound diverge the first time one is widened.
 */
export const MAX_ROLLUP_COUNT = 2_147_483_647;

/** A whole, non-negative count inside {@link MAX_ROLLUP_COUNT}. */
function wholeCount(value: unknown): number | null {
  const count = finiteNumber(value);
  if (count === null || !Number.isInteger(count)) {
    return null;
  }
  if (count < 0 || count > MAX_ROLLUP_COUNT) {
    return null;
  }
  return count;
}

/**
 * The largest spend, in USD, any single confidence tier may carry.
 *
 * A bound is needed at the top as well as the bottom: `Decimal(14, 6)` refuses
 * anything at or above 1e8 at the column, and an unbounded value would be
 * accepted here only to fail the write. Rejecting it at the boundary keeps the
 * row valid-or-absent instead of valid-or-exception.
 */
export const MAX_TIER_SPEND_USD = 99_999_999;

/**
 * Validate a raw rollup into the read contract.
 *
 * Field-independent by design except for the two stated couplings: the spend
 * tiers stand or fall together (see the module note), and `coveredSegmentCount`
 * is withheld when it exceeds `segmentCount`, because a subset larger than its
 * population is not a partial measurement of anything.
 */
export function normalizeSessionActivityMetrics(
  raw: RawSessionActivityMetrics | null | undefined
): SessionActivityMetricsRead {
  if (!raw) {
    return UNKNOWN_SESSION_ACTIVITY_METRICS;
  }
  const coverageRaw = finiteNumber(raw.coverage);
  const coverage =
    coverageRaw !== null &&
    coverageRaw >= COVERAGE_RATIO_RANGE.min &&
    coverageRaw <= COVERAGE_RATIO_RANGE.max
      ? coverageRaw
      : null;

  const low = nonNegativeAmount(raw.spendLowConfUsd, MAX_TIER_SPEND_USD);
  const medium = nonNegativeAmount(raw.spendMediumConfUsd, MAX_TIER_SPEND_USD);
  const high = nonNegativeAmount(raw.spendHighConfUsd, MAX_TIER_SPEND_USD);
  const splitIsWhole = low !== null && medium !== null && high !== null;

  const segmentCount = wholeCount(raw.segmentCount);
  const coveredRaw = wholeCount(raw.coveredSegmentCount);
  const coveredSegmentCount =
    coveredRaw !== null && segmentCount !== null && coveredRaw > segmentCount
      ? null
      : coveredRaw;

  return {
    autonomyBand: asAutonomyBand(
      typeof raw.autonomyBand === "string" ? raw.autonomyBand : null
    ),
    coverage,
    spendLowConfUsd: splitIsWhole ? low : null,
    spendMediumConfUsd: splitIsWhole ? medium : null,
    spendHighConfUsd: splitIsWhole ? high : null,
    segmentCount,
    coveredSegmentCount,
    classifierVersion: wholeCount(raw.classifierVersion),
    metricVersion: wholeCount(raw.metricVersion),
  };
}

/**
 * True when nothing in the rollup was measured — the caller should omit the
 * field entirely rather than serialize an all-`null` object, per the
 * cross-repo rule that an absent optional is omitted, not nulled.
 */
export function isSessionActivityMetricsUnknown(
  metrics: SessionActivityMetricsRead
): boolean {
  return Object.values(metrics).every((value) => value === null);
}
