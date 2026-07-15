import {
  type KpiFormat,
  KpiFormat as KpiFormatValues,
} from "@repo/api/src/types/insights";
import { formatCompact } from "@repo/app/shared/lib/format-utils";

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const THOUSAND = 1000;
const NUMBER_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
});

// Chart tiles carry a `metricKey` (see tile-catalog.ts) but their bucket/series
// values are bare numbers. Map the metric to the same display format the KPIs
// use so a chart's axis + tooltip render in the right unit (e.g. "cost" → "$",
// "tokens" → compact). Unknown metrics fall back to plain numbers.
const METRIC_KEY_FORMAT: Record<string, KpiFormat> = {
  cost: KpiFormatValues.Currency,
  tokens: KpiFormatValues.Tokens,
};

function metricFormat(metricKey: string): KpiFormat {
  return METRIC_KEY_FORMAT[metricKey] ?? KpiFormatValues.Number;
}

/** Resolve a value formatter for a tile's `metricKey` (currency, tokens, …). */
export function metricValueFormatter(
  metricKey: string
): (value: number) => string {
  return (value: number) => formatKpiValue(value, metricFormat(metricKey));
}

// Currency metrics (e.g. spend) can span sub-dollar ranges, so their chart axes
// need fractional ticks; integer-count metrics keep whole-number ticks.
export function metricAllowsFractions(metricKey: string): boolean {
  return metricFormat(metricKey) === KpiFormatValues.Currency;
}

/** Format a KPI numeric value for display according to its format hint. */
/** Rendered when a KPI has no computable value (unknown, not `0`). */
export const KPI_NO_VALUE = "—";

export function formatKpiValue(
  value: number | null | undefined,
  format: KpiFormat
): string {
  // An unavailable metric (e.g. median PR size when no PRs in the window have
  // been LOC-enriched yet) is surfaced as `—`, not a misleading `0`. Handles
  // both the in-process sentinel (NaN, preserved across Electron IPC) and the
  // over-the-wire form (NaN serializes to null in JSON on the cloud path).
  if (value == null || !Number.isFinite(value)) {
    return KPI_NO_VALUE;
  }
  switch (format) {
    case KpiFormatValues.Currency:
      return formatCurrency(value);
    case KpiFormatValues.Percent:
      return `${Math.round(value)}%`;
    case KpiFormatValues.Duration:
      return formatDuration(value);
    case KpiFormatValues.Tokens:
      return formatCompact(value);
    default:
      return formatNumber(value);
  }
}

/** Format a signed percent delta, or null when not applicable. */
export function formatDelta(deltaPct: number | null): string | null {
  if (deltaPct === null) {
    return null;
  }
  const sign = deltaPct > 0 ? "+" : "";
  return `${sign}${deltaPct}%`;
}

/** A positive delta is "good" for most metrics; callers may invert per-metric. */
export function deltaIsPositive(deltaPct: number | null): boolean {
  return (deltaPct ?? 0) >= 0;
}

export function formatNumber(value: number): string {
  return NUMBER_FORMATTER.format(value);
}

function formatCurrency(value: number): string {
  if (Math.abs(value) >= THOUSAND) {
    return `$${formatCompact(value)}`;
  }
  return `$${value.toFixed(value < 10 ? 2 : 0)}`;
}

function formatDuration(ms: number): string {
  if (ms <= 0) {
    return "—";
  }
  if (ms >= HOUR_MS) {
    const hours = Math.floor(ms / HOUR_MS);
    const minutes = Math.round((ms % HOUR_MS) / MINUTE_MS);
    return `${hours}h ${minutes}m`;
  }
  const minutes = Math.max(1, Math.round(ms / MINUTE_MS));
  return `${minutes}m`;
}
