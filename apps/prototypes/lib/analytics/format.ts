/**
 * Shared formatting + the three-way data state both analytics prototypes hold.
 *
 * The three states are never conflated:
 *   Loading  -> a skeleton that reserves the real geometry
 *   Missing  -> a quiet neutral em-dash glyph (the value SETTLED as unavailable)
 *   a value  -> including a real 0
 *
 * On a surface whose whole subject is failure, a fabricated `0` reads as "no
 * problem here", so an unavailable number renders as `NO_VALUE`, never as zero.
 */

export const DataState = {
  Loading: "loading",
  Ready: "ready",
  /** Some widgets settled without a value, e.g. a rollup read that failed. */
  Degraded: "degraded",
} as const;
export type DataState = (typeof DataState)[keyof typeof DataState];

export const DATA_STATE_LABELS: Record<DataState, string> = {
  [DataState.Loading]: "Loading",
  [DataState.Ready]: "Loaded",
  [DataState.Degraded]: "Partly unavailable",
};

export const DATA_STATE_ORDER: readonly DataState[] = [
  DataState.Ready,
  DataState.Loading,
  DataState.Degraded,
];

/** The settled-unavailable glyph. One constant so no surface re-picks a dash. */
export const NO_VALUE = "—";

const HOURS_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});
const WHOLE_FORMATTER = new Intl.NumberFormat("en-US");
const PERCENT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});
const USD_FORMATTER = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 0,
  style: "currency",
});
const USD_CENTS_FORMATTER = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  style: "currency",
});
const COMPACT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  notation: "compact",
});

/**
 * Formats a value that may be genuinely absent. A `null` is the settled-
 * unavailable case and renders the dash; a real `0` formats as "0.0 h".
 */
export function formatHours(hours: number | null): string {
  return hours === null ? NO_VALUE : `${HOURS_FORMATTER.format(hours)} h`;
}

export function formatCount(value: number | null): string {
  return value === null ? NO_VALUE : WHOLE_FORMATTER.format(value);
}

export function formatPercent(value: number | null): string {
  return value === null ? NO_VALUE : `${PERCENT_FORMATTER.format(value)}%`;
}

export function formatUsd(value: number | null): string {
  return value === null ? NO_VALUE : USD_FORMATTER.format(value);
}

export function formatUsdExact(value: number | null): string {
  return value === null ? NO_VALUE : USD_CENTS_FORMATTER.format(value);
}

export function formatCompact(value: number | null): string {
  return value === null ? NO_VALUE : COMPACT_FORMATTER.format(value);
}

/**
 * A range, rendered as a range. An estimate never collapses to a point value,
 * because a single number reads as a measurement.
 */
export function formatUsdRange(
  low: number | null,
  high: number | null
): string {
  if (low === null || high === null) {
    return NO_VALUE;
  }
  return `${USD_FORMATTER.format(low)} to ${USD_FORMATTER.format(high)}`;
}

/** Short month/day for a YYYY-MM-DD bucket. */
export function formatBucketDate(date: string): string {
  const parts = date.split("-");
  return parts.length === DATE_PART_COUNT ? `${parts[1]}/${parts[2]}` : date;
}

const DATE_PART_COUNT = 3;

/**
 * "1 session", not "1 sessions". A count that reads as broken copy makes the
 * number beside it look careless too.
 */
export function formatSessions(count: number | null): string {
  if (count === null) {
    return `${NO_VALUE} sessions`;
  }
  return `${WHOLE_FORMATTER.format(count)} ${count === 1 ? "session" : "sessions"}`;
}
