import {
  BranchMetricAvailability,
  type BranchMetricComparison,
  BranchMetricComparisonLabel,
  BranchMetricPeriod,
  type BranchMetricResult,
  type BranchMetricWindow,
} from "@repo/api/src/types/branch-metrics";

const DAY_MS = 24 * 60 * 60 * 1000;

export type AdjacentBranchMetricWindows = {
  period: BranchMetricPeriod;
  label: BranchMetricComparisonLabel;
  current: BranchMetricWindow;
  prior: BranchMetricWindow | null;
};

/**
 * Build adjacent half-open UTC periods ending at the supplied pinned instant.
 *
 * `now` is the real current instant, and is what keeps the two periods
 * comparable when `end` is in the FUTURE. Since ISS-5809 the request boundary
 * ends with the in-progress UTC day, so the current window's population runs only
 * as far as `now` while a full-width prior window is complete — which reports the
 * time of day as a WoW/MoM/QoQ trend (a steady org reads ≈ -14% on a 7d period
 * just after UTC midnight, recovering by the next one). The prior window is
 * therefore truncated to the span the current one has actually ELAPSED, so the
 * two cover equal elapsed time rather than merely equal nominal width.
 *
 * Omit `now`, or pass one at/after `end`, and the prior window keeps its full
 * width — a period already fully in the past is unaffected. A period that has not
 * opened yet has no elapsed span and so gets no prior window at all, which
 * `buildBranchMetricComparison` renders as "no comparison" rather than a
 * clock-driven percentage.
 */
export function buildAdjacentBranchMetricWindows(
  period: BranchMetricPeriod,
  end: Date,
  now?: Date
): AdjacentBranchMetricWindows {
  const endMs = validEpoch(end);
  if (period === BranchMetricPeriod.All) {
    return {
      period,
      label: BranchMetricComparisonLabel.AllTime,
      current: { startAt: null, endAt: new Date(endMs).toISOString() },
      prior: null,
    };
  }
  const durationMs = periodDays(period) * DAY_MS;
  const currentStartMs = endMs - durationMs;
  return {
    period,
    label: comparisonLabel(period),
    current: {
      startAt: new Date(currentStartMs).toISOString(),
      endAt: new Date(endMs).toISOString(),
    },
    prior: buildElapsedMatchedPriorWindow(currentStartMs, endMs, now),
  };
}

/** Half-open membership: lower bound inclusive, upper bound exclusive. */
export function isTimestampInBranchMetricWindow(
  timestamp: string | Date | null | undefined,
  window: BranchMetricWindow
): boolean {
  if (timestamp == null) {
    return false;
  }
  const valueMs = Date.parse(
    timestamp instanceof Date ? timestamp.toISOString() : timestamp
  );
  const endMs = Date.parse(window.endAt);
  const startMs = window.startAt === null ? null : Date.parse(window.startAt);
  if (
    Number.isNaN(valueMs) ||
    Number.isNaN(endMs) ||
    (startMs !== null && Number.isNaN(startMs))
  ) {
    return false;
  }
  return valueMs < endMs && (startMs === null || valueMs >= startMs);
}

/** Compare only complete values over a nonzero complete prior. */
export function buildBranchMetricComparison(
  label: BranchMetricComparison["label"],
  priorWindow: BranchMetricWindow,
  current: BranchMetricResult<number>,
  prior: BranchMetricResult<number>
): BranchMetricComparison {
  if (
    current.state === BranchMetricAvailability.Partial ||
    prior.state === BranchMetricAvailability.Partial ||
    current.state === BranchMetricAvailability.Unavailable ||
    prior.state === BranchMetricAvailability.Unavailable
  ) {
    return {
      label,
      priorWindow,
      deltaPct: { state: BranchMetricAvailability.Unavailable, value: null },
    };
  }
  if (
    current.state !== BranchMetricAvailability.Complete ||
    prior.state !== BranchMetricAvailability.Complete ||
    prior.value === 0
  ) {
    return {
      label,
      priorWindow,
      deltaPct: { state: BranchMetricAvailability.NotApplicable, value: null },
    };
  }
  return {
    label,
    priorWindow,
    deltaPct: {
      state: BranchMetricAvailability.Complete,
      value: ((current.value - prior.value) / prior.value) * 100,
    },
  };
}

function validEpoch(end: Date): number {
  const epoch = end.getTime();
  if (!Number.isFinite(epoch)) {
    throw new TypeError("Branch metric window requires a valid end instant");
  }
  return epoch;
}

/**
 * The same slice of the period one duration earlier: it OPENS a full period
 * before the current window does — same weekday, same hour — and closes after the
 * span the current window has ELAPSED. Null when none of it has elapsed.
 *
 * Truncating the END rather than sliding the START is the point. Both keep the
 * spans equal, but only this one keeps them at the same PHASE of the period; the
 * other lets ordinary diurnal and weekday shape read as WoW/MoM/QoQ movement.
 * The two windows are therefore not adjacent while the current period is still
 * running, which is what "period-to-date vs. same period-to-date" means.
 */
function buildElapsedMatchedPriorWindow(
  currentStartMs: number,
  currentEndMs: number,
  now: Date | undefined
): BranchMetricWindow | null {
  const nowMs = now === undefined ? currentEndMs : now.getTime();
  const elapsedEndMs = Number.isFinite(nowMs)
    ? Math.min(currentEndMs, nowMs)
    : currentEndMs;
  const elapsedMs = elapsedEndMs - currentStartMs;
  if (elapsedMs <= 0) {
    return null;
  }
  const priorStartMs = currentStartMs - (currentEndMs - currentStartMs);
  return {
    startAt: new Date(priorStartMs).toISOString(),
    endAt: new Date(priorStartMs + elapsedMs).toISOString(),
  };
}

function periodDays(
  period: Exclude<BranchMetricPeriod, typeof BranchMetricPeriod.All>
): number {
  switch (period) {
    case BranchMetricPeriod.SevenDays:
      return 7;
    case BranchMetricPeriod.ThirtyDays:
      return 30;
    case BranchMetricPeriod.NinetyDays:
      return 90;
    default:
      return assertNever(period);
  }
}

function comparisonLabel(
  period: Exclude<BranchMetricPeriod, typeof BranchMetricPeriod.All>
): Exclude<
  BranchMetricComparisonLabel,
  typeof BranchMetricComparisonLabel.AllTime
> {
  switch (period) {
    case BranchMetricPeriod.SevenDays:
      return BranchMetricComparisonLabel.WeekOverWeek;
    case BranchMetricPeriod.ThirtyDays:
      return BranchMetricComparisonLabel.MonthOverMonth;
    case BranchMetricPeriod.NinetyDays:
      return BranchMetricComparisonLabel.QuarterOverQuarter;
    default:
      return assertNever(period);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported Branch metric period: ${String(value)}`);
}
