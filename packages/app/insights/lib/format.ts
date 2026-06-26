import {
  type KpiFormat,
  KpiFormat as KpiFormatValues,
} from "@repo/api/src/types/insights";

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const THOUSAND = 1000;
const MILLION = 1_000_000;
const BILLION = 1_000_000_000;
const TRAILING_ZERO_DECIMAL = /\.0$/;
const NUMBER_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
});

/** Format a KPI numeric value for display according to its format hint. */
export function formatKpiValue(value: number, format: KpiFormat): string {
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

function formatCompact(value: number): string {
  if (Math.abs(value) >= BILLION) {
    return `${trim(value / BILLION)}B`;
  }
  if (Math.abs(value) >= MILLION) {
    return `${trim(value / MILLION)}M`;
  }
  if (Math.abs(value) >= THOUSAND) {
    return `${trim(value / THOUSAND)}k`;
  }
  return `${Math.round(value)}`;
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

function trim(value: number): string {
  return value.toFixed(1).replace(TRAILING_ZERO_DECIMAL, "");
}
