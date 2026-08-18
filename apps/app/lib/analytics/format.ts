import {
  formatCompact as formatCompactValue,
  formatCost,
  formatCurrencyWhole,
  formatNumber,
  KPI_NO_VALUE,
} from "@repo/app/shared/lib/format-utils";

/**
 * Shared formatting for the two session-analytics screens (ISS-4987 lost work,
 * ISS-4988 TokenOps waste).
 *
 * Three states are never conflated:
 *   loading              -> a skeleton that reserves the real geometry
 *   settled-unavailable  -> a quiet neutral em-dash (the value SETTLED without one)
 *   a value              -> including a real 0
 *
 * On surfaces whose whole subject is failure, a fabricated `0` reads as "no
 * problem here", so an unavailable number renders as `NO_VALUE` and never as
 * zero. Every formatter below takes `number | null` for exactly that reason:
 * `null` is the settled-unavailable case, `0` is a measurement.
 *
 * The MONEY, COUNT and COMPACT formatters delegate to the canonical
 * `@repo/app/shared/lib/format-utils` helpers rather than re-deriving them, so
 * these screens cannot drift from the KPI tiles one click away. This module is
 * the `number | null` adapter over those helpers plus the hour/percent/session
 * shapes only these two screens need — not a second formatting vocabulary.
 */

/**
 * The settled-unavailable glyph. Aliases the canonical `KPI_NO_VALUE` so the
 * dash on these screens is the same character every other honest-empty metric
 * in the app renders.
 */
export const NO_VALUE = KPI_NO_VALUE;

const MINUTES_PER_HOUR = 60;

const HOURS_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});
const PERCENT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

export function minutesToHours(minutes: number): number {
  return minutes / MINUTES_PER_HOUR;
}

export function toPercent(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

export function formatHours(hours: number | null): string {
  return hours === null ? NO_VALUE : `${HOURS_FORMATTER.format(hours)} h`;
}

export function formatCount(value: number | null): string {
  return value === null ? NO_VALUE : formatNumber(value);
}

export function formatPercent(value: number | null): string {
  return value === null ? NO_VALUE : `${PERCENT_FORMATTER.format(value)}%`;
}

/**
 * Whole-dollar spend.
 *
 * Delegates to `formatCurrencyWhole`, which falls back to sub-cent precision
 * when a NONZERO amount would round away to `$0`. A fixed zero-fraction format
 * would print "$0" for any failed spend under half a dollar — a completely
 * normal amount on a Me-scoped 7-day window — and a waste screen reading "$0"
 * says "nothing was wasted here", which is the exact lie these screens exist to
 * prevent. An exact `0` still renders `$0`, because that one is true.
 */
export function formatUsd(value: number | null): string {
  return value === null ? NO_VALUE : formatCurrencyWhole(value);
}

export function formatUsdExact(value: number | null): string {
  return value === null ? NO_VALUE : formatCost(value);
}

export function formatCompact(value: number | null): string {
  return value === null ? NO_VALUE : formatCompactValue(value);
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
  return `${formatCurrencyWhole(low)} to ${formatCurrencyWhole(high)}`;
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
  return `${formatNumber(count)} ${count === 1 ? "session" : "sessions"}`;
}
