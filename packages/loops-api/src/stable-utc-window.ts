/**
 * The ONE definition of the stable UTC calendar-day window a named date range
 * resolves to, for every surface on both shells.
 *
 * ISS-5809 defined the shape; ISS-10583 made it the one the insights dashboard
 * resolves too. It lives in this zero-dependency contract package because that
 * is the only place all three producers — `packages/app`, `apps/api` and
 * `apps/desktop` — can read one implementation rather than three.
 *
 * Bounds are UTC DAY bounds, never local ones: the insights aggregates are
 * asserted to be byte-identical in UTC and America/Chicago
 * (`golden-corpus-insights.integration.test.ts`), and a local-day boundary here
 * would make them zone-dependent. Only bucket LABELS are local.
 */

/** UTC midnight of the day `dayOffset` days from the UTC day `now` falls on. */
export function stableUtcDayStart(now: Date, dayOffset = 0): Date {
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + dayOffset
    )
  );
}

/** The last representable instant of the UTC day `now` falls on. */
export function stableUtcDayEnd(now: Date): Date {
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      23,
      59,
      59,
      999
    )
  );
}

/**
 * The inclusive `days`-long UTC-day window ending WITH the in-progress UTC day.
 *
 * The end bound is deliberately ahead of the clock for most of the day: that is
 * what keeps the serialized bounds stable across a UTC day, so a query key does
 * not move and adjacent windows stay equal-width. A caller needing the instant
 * the window has actually reached asks {@link stableUtcWindowElapsedEnd}.
 */
export function stableUtcDayWindow(
  days: number,
  now: Date
): { start: Date; end: Date } {
  return {
    start: stableUtcDayStart(now, -days + 1),
    end: stableUtcDayEnd(now),
  };
}

/**
 * How far into `[start, end]` the clock has actually run.
 *
 * Two callers need it and neither may use `end`: a day AXIS enumerated past the
 * clock gains a trailing empty column east of UTC, and a period-over-period
 * comparison graded against a full-width prior window reports the time of day as
 * a trend (ISS-5809; `resolvePriorUsageWindow`,
 * `buildAdjacentBranchMetricWindows` hold the same rule).
 */
export function stableUtcWindowElapsedEnd(end: Date, now: Date): Date {
  // A copy, not the caller's own `now`: this instant is threaded into several
  // query builders across three modules, and none of them should be able to
  // reach back and mutate the clock the request was resolved against.
  return new Date(Math.min(now.getTime(), end.getTime()));
}

/**
 * The prior window at the SAME phase one full period earlier, closed after the
 * span the current window has elapsed. Null when nothing has elapsed yet.
 *
 * The END is what moves, not the start: sliding the start forward keeps the
 * spans equal but shifts the comparison to a different weekday and hour, so
 * ordinary diurnal shape reads as period-over-period movement.
 */
export function stableUtcPriorWindow(
  start: Date,
  end: Date,
  elapsedEnd: Date
): { start: Date; end: Date } | null {
  const elapsedMs = elapsedEnd.getTime() - start.getTime();
  if (elapsedMs <= 0) {
    return null;
  }
  const priorStartMs = start.getTime() - (end.getTime() - start.getTime() + 1);
  return {
    start: new Date(priorStartMs),
    end: new Date(priorStartMs + elapsedMs),
  };
}

/**
 * The stable UTC window for a day count, serialized as the list-query bounds
 * the Branches and Sessions lists send; `null` (all time) applies no bound.
 *
 * ISS-11915 (operator ruling 2026-10-08): the Dashboard's branch population
 * resolves its window here too, so "Last 7 days" on the Dashboard and on the
 * Branches list select the same branches.
 */
export function stableUtcListWindow(
  days: number | null,
  now: Date
): { startDate?: string; endDate?: string } {
  if (days === null) {
    return {};
  }
  const { start, end } = stableUtcDayWindow(days, now);
  return { startDate: start.toISOString(), endDate: end.toISOString() };
}
