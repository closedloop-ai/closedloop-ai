/**
 * Shared formatting utilities for loops UI.
 */

/**
 * Format a token count for display with abbreviated tiers (k, M, B).
 * Uses 2 decimal places for abbreviated output.
 * Tiers up at 4 whole figures (e.g., 1232M → 1.23B).
 * Tiers down when value is less than 1 of current tier (e.g., 0.5M → 500k).
 */
export function formatTokenCount(count: number): string {
  const B = 1_000_000_000;
  const M = 1_000_000;
  const K = 1000;

  if (count >= B) {
    return `${(count / B).toFixed(2)}B`;
  }
  if (count >= M) {
    const divided = count / M;
    if (divided >= 999.995) {
      return `${(count / B).toFixed(2)}B`;
    }
    return `${divided.toFixed(2)}M`;
  }
  if (count >= K) {
    const divided = count / K;
    if (divided >= 999.995) {
      return `${(count / M).toFixed(2)}M`;
    }
    return `${divided.toFixed(2)}k`;
  }
  return count.toString();
}

/**
 * Format elapsed time between two instants as "Xh Ym", "Xm Ys", or "Ys".
 * Accepts Date objects or ISO strings so both the web (Date) and desktop (ISO)
 * session tables can share one implementation.
 * If startedAt is null, returns "-".
 * If completedAt is null (e.g. a still-running session), measures against
 * Date.now() so the duration reflects live elapsed time rather than freezing.
 * Unparseable inputs return "-"; clock skew (end before start) clamps to "0s".
 */
export function formatDuration(
  startedAt: Date | string | null,
  completedAt: Date | string | null
): string {
  if (!startedAt) {
    return "-";
  }
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return "-";
  }

  const totalSeconds = Math.max(0, Math.floor((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Total elapsed time between two instants expressed as a whole-minute chart
 * scale: the duration rounded UP to the next full minute. Used as the upper
 * bound of the session timeline's time axis so the scale always covers the
 * whole session.
 *
 * Examples: 5m 5s → 6, 75m 1s → 76, an exact 5m 0s → 5 (no extra minute).
 *
 * Mirrors formatDuration's input handling: accepts Date objects or ISO
 * strings, treats a null completedAt as a still-running session measured
 * against Date.now(), and clamps clock skew (end before start) to zero.
 * Always returns at least 1 — a sub-minute or zero-length session still gets
 * a 1-minute scale. Unparseable inputs return 1.
 */
export function getDurationScaleMinutes(
  startedAt: Date | string | null,
  completedAt: Date | string | null
): number {
  if (!startedAt) {
    return 1;
  }
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return 1;
  }

  const totalSeconds = Math.max(0, Math.floor((end - start) / 1000));
  return Math.max(1, Math.ceil(totalSeconds / 60));
}

/**
 * Build URLSearchParams from a filters object, skipping null/undefined values.
 * Array values are serialized as repeated params (`?k=a&k=b`) — empty arrays are
 * skipped — so multi-select facets round-trip through the server's repeated-param
 * parsing.
 */
export function buildSearchParams(
  filters: Record<string, unknown>
): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry !== undefined && entry !== null) {
          params.append(key, String(entry));
        }
      }
      continue;
    }
    params.set(key, String(value));
  }
  return params;
}

export const DATE_RANGES = ["7d", "30d", "90d", "all"] as const;

export type DateRange = (typeof DATE_RANGES)[number];

export const DATE_RANGE_LABELS: Record<DateRange, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  all: "All time",
};

/** Compact labels for the inline time-window segmented control. */
export const DATE_RANGE_SHORT_LABELS: Record<DateRange, string> = {
  "7d": "7d",
  "30d": "30d",
  "90d": "90d",
  all: "All",
};

export function parseDateRange(value: string | null): DateRange {
  if (value === "7d" || value === "30d" || value === "90d" || value === "all") {
    return value;
  }
  return "30d";
}

export function getStartDateForRange(range: DateRange): string | undefined {
  if (range === "all") {
    return undefined;
  }
  const daysMap: Record<Exclude<DateRange, "all">, number> = {
    "7d": 7,
    "30d": 30,
    "90d": 90,
  };
  const days = daysMap[range];
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

export function formatCost(cost: number | undefined): string {
  return `$${(cost ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Format a plain numeric value with comma separators.
 *
 * When `isFractional` is true (costs, rates, and other values that can have
 * a meaningful fractional part), decimal precision rules are applied:
 *   - Values less than 10: 2 decimal places (e.g., 9.50)
 *   - Values 10 or greater: rounded to nearest whole number (e.g., 1,234)
 *
 * When `isFractional` is false (integer counts), the value is always displayed
 * as a whole number with comma separators regardless of magnitude (e.g., 13,523).
 */
export function formatNumber(value: number, isFractional = false): string {
  if (isFractional && Math.abs(value) < 10) {
    return value.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  return Math.round(value).toLocaleString("en-US");
}
