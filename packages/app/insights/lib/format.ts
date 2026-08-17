import {
  type KpiFormat,
  KpiFormat as KpiFormatValues,
} from "@repo/api/src/types/insights";
import {
  formatCompact,
  formatCurrencyTileValue,
  KPI_NO_VALUE as SHARED_KPI_NO_VALUE,
} from "@repo/app/shared/lib/format-utils";
import { formatDeltaPct } from "@closedloop-ai/loops-api/insights";

/**
 * Re-exported from the shared SSOT (`shared/lib/format-utils`) so existing
 * insights callers keep importing `KPI_NO_VALUE` from here unchanged while the
 * canonical definition lives slice-agnostically in `shared/` — a slice-agnostic
 * component (the shared CostMetricCard) can then import the sentinel without an
 * agents → insights dependency.
 */
export const KPI_NO_VALUE = SHARED_KPI_NO_VALUE;

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

/**
 * Format a KPI value for an AGGREGATE spend/cost tile (FEA-3431).
 *
 * Identical to {@link formatKpiValue} for every format EXCEPT `Currency`, where
 * it renders whole dollars (`$9,061`) via the shared {@link formatCurrencyWhole}
 * — matching the Branches/Sessions "AI spend" summary cards — instead of the
 * compact, precision-cliffed `$9.1k` that `formatKpiValue` produces. Use this
 * for the overview headline spend/cost KPIs (AI spend, estimated cost,
 * cost-per-merged-PR) so the same magnitude reads the same on web and desktop.
 *
 * Non-currency formats are delegated unchanged so a mixed tile grid (percent,
 * duration, tokens, …) still formats each metric correctly. The honest-empty
 * `—` sentinel for null / non-finite values is preserved (never `$0`).
 */
export function formatKpiTileValue(
  value: number | null | undefined,
  format: KpiFormat
): string {
  if (format !== KpiFormatValues.Currency) {
    return formatKpiValue(value, format);
  }
  // Whole-dollar currency-tile formatting (with the honest-empty `—` sentinel
  // for null/non-finite) is the shared SSOT guard, so the same cost value reads
  // identically on the KPI tiles and the shared CostMetricCard.
  return formatCurrencyTileValue(value);
}

/**
 * Format a signed percent delta, or null when not applicable. Delegates to the
 * shared `formatDeltaPct` SSOT (`@closedloop-ai/loops-api/insights`) so the Insights
 * `TrendBadge` and the design-system `MetricCard` chip render the identical cap
 * treatment ("<-999%" / ">999%") and can't drift (FEA-3959/3960).
 */
export function formatDelta(deltaPct: number | null): string | null {
  return formatDeltaPct(deltaPct);
}

// ISS-4633 removed `deltaIsPositive` from this module. It answered "did the
// number go up?" while every caller used it to answer "is this good?", which
// coloured a rising spend green. Sentiment now comes from `deltaSentiment` in
// `@repo/design-system/components/ui/primitives/metric-polarity`, which takes
// the metric's declared polarity; the KPI catalog owns that declaration.

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
  // Round to whole minutes *first*, then split into h/m. Rounding the minute
  // remainder independently of the hours lets a 59.5m remainder round up to
  // 60 and render a malformed "1h 60m" (or "60m" below the hour); carrying
  // from the total minutes avoids that.
  const totalMinutes = Math.max(1, Math.round(ms / MINUTE_MS));
  if (totalMinutes >= 60) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}h ${minutes}m`;
  }
  return `${totalMinutes}m`;
}
