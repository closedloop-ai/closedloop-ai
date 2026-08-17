import { type DateRange, DateRange as DateRangeValue } from "../mock";
import {
  ComparisonLabel,
  MetricAvailability,
  type MetricDisclosure,
  type MetricResult,
  type MetricValue,
  type MetricWindow,
} from "./branch-list-metric-types";

const DAY_MS = 24 * 60 * 60 * 1000;

export type Reconciled<Value> = {
  values: Value[];
  conflicted: boolean;
};

export function buildMetricWindows(
  dateRange: DateRange,
  now: Date
): {
  label: ComparisonLabel;
  current: MetricWindow;
  prior: MetricWindow | null;
} {
  const endAt = now.getTime();
  if (dateRange === DateRangeValue.All) {
    return {
      label: ComparisonLabel.AllTime,
      current: { startAt: null, endAt },
      prior: null,
    };
  }
  let days = 90;
  let label: ComparisonLabel = ComparisonLabel.QuarterOverQuarter;
  if (dateRange === DateRangeValue.SevenDays) {
    days = 7;
    label = ComparisonLabel.WeekOverWeek;
  } else if (dateRange === DateRangeValue.ThirtyDays) {
    days = 30;
    label = ComparisonLabel.MonthOverMonth;
  }
  const duration = days * DAY_MS;
  const startAt = endAt - duration;
  return {
    label,
    current: { startAt, endAt },
    prior: { startAt: startAt - duration, endAt: startAt },
  };
}

export function metricValue(
  current: MetricResult,
  prior: MetricResult | undefined,
  label: ComparisonLabel
): MetricValue {
  if (prior === undefined || label === ComparisonLabel.AllTime) {
    return { current };
  }
  return {
    current,
    comparison: { label, deltaPct: compareMetricResults(current, prior) },
  };
}

/** Canonical comparison table from the production Branch metric oracle. */
export function compareMetricResults(
  current: MetricResult,
  prior: MetricResult
): MetricResult {
  if (
    current.state === MetricAvailability.Partial ||
    prior.state === MetricAvailability.Partial ||
    current.state === MetricAvailability.Unavailable ||
    prior.state === MetricAvailability.Unavailable
  ) {
    return unavailableMetric();
  }
  if (
    current.state !== MetricAvailability.Complete ||
    prior.state !== MetricAvailability.Complete ||
    prior.value === 0
  ) {
    return notApplicableMetric();
  }
  return completeMetric(((current.value - prior.value) / prior.value) * 100);
}

export function reconcileByIdentity<Value>(
  values: readonly Value[],
  keyFor: (value: Value) => string
): Reconciled<Value> {
  const deduped = new Map<string, Value>();
  const conflicts = new Set<string>();
  let conflicted = false;
  for (const value of values) {
    const key = keyFor(value);
    if (!key) {
      conflicted = true;
      continue;
    }
    const existing = deduped.get(key);
    if (existing === undefined) {
      deduped.set(key, value);
    } else if (stableValue(existing) !== stableValue(value)) {
      conflicted = true;
      conflicts.add(key);
      deduped.delete(key);
    }
  }
  return {
    values: [...deduped.entries()]
      .filter(([key]) => !conflicts.has(key))
      .map(([, value]) => value),
    conflicted,
  };
}

/** Status and coverage records require exactly one row per cohort identity. */
export function exactUniqueIndex<Value>(
  values: readonly Value[],
  keyFor: (value: Value) => string,
  expectedIds: readonly string[]
): Map<string, Value> | null {
  const expected = new Set(expectedIds);
  if (expected.size !== expectedIds.length) {
    return null;
  }
  const indexed = new Map<string, Value>();
  for (const value of values) {
    const key = keyFor(value);
    if (!(key && expected.has(key)) || indexed.has(key)) {
      return null;
    }
    indexed.set(key, value);
  }
  return indexed.size === expected.size ? indexed : null;
}

export function hasExactUniqueCoverage(
  expectedIds: readonly string[],
  coveredIds: readonly string[]
): boolean {
  const expected = new Set(expectedIds);
  const covered = new Set(coveredIds);
  return (
    expected.size === expectedIds.length &&
    covered.size === coveredIds.length &&
    expected.size === covered.size &&
    [...expected].every((id) => covered.has(id))
  );
}

export function isTimestampInWindow(
  value: string | null,
  window: MetricWindow
): boolean {
  if (value === null) {
    return false;
  }
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) &&
    timestamp < window.endAt &&
    (window.startAt === null || timestamp >= window.startAt)
  );
}

export function isTrustworthyTimestamp(
  value: string | null,
  evidenceHorizon: number
): boolean {
  if (value === null) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp < evidenceHorizon;
}

export function isValidNonnegative(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

export function isValidDivisor(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value > 0;
}

export function completeMetric(value: number): MetricResult {
  return { state: MetricAvailability.Complete, value };
}

export function partialMetric(
  value: number,
  disclosure: MetricDisclosure
): MetricResult {
  return { state: MetricAvailability.Partial, value, disclosure };
}

export function unavailableMetric(): MetricResult {
  return { state: MetricAvailability.Unavailable, value: null };
}

export function notApplicableMetric(): MetricResult {
  return { state: MetricAvailability.NotApplicable, value: null };
}

export function noDataMetric(): MetricResult {
  return { state: MetricAvailability.NoData, value: null };
}

function stableValue(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as object).sort());
}
