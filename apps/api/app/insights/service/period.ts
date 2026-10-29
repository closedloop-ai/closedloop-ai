import { pctDelta } from "@closedloop-ai/loops-api/insights";
import {
  stableUtcDayEnd,
  stableUtcDayStart,
  stableUtcDayWindow,
  stableUtcPriorWindow,
  stableUtcWindowElapsedEnd,
} from "@closedloop-ai/loops-api/stable-utc-window";
import {
  type InsightsPeriod,
  InsightsPeriod as InsightsPeriodValues,
} from "@repo/api/src/types/insights";
import { withDb } from "@repo/database";
import {
  artifactScope,
  type InsightsScopeContext,
  sessionScope,
} from "./scope";

const TREND_LOOKBACK_DAYS = 90;

type PeriodRange = {
  start: Date;
  end: Date;
  // The instant the window has actually reached. `end` runs ahead of the clock
  // for most of the day, and every daily-bucketed series and the prior window
  // below bound HERE instead — see `stableUtcWindowElapsedEnd` for why.
  //
  // THE TOTALS DO NOT BOUND HERE, and that split is deliberate (review,
  // 2026-09-18). Every KPI aggregate reads `start..end` — `fetchSessionRollup`
  // (through `sessionsWindow`, which is `start..end` outside "all"),
  // `countEvents`, `sumToolRuns`, `fetchTokenTotals`, and the desktop locRows
  // query — while every day axis reads `trendStart..elapsedEnd`. Before
  // ISS-10583 both were `now` and could not disagree, so this is worth stating
  // rather than leaving the next reader to find it.
  //
  // Why the totals keep the NOMINAL end: it is the bound this ticket exists to
  // align. The Sessions and Branches surfaces resolve `start..end` from
  // `getStableUtcDateWindowForRange`, and `period-sessions-window-parity`
  // asserts `range.end` IS that window's `endDate`. Clamping the totals to
  // `elapsedEnd` would make the dashboard's "Last 7 days" count a narrower span
  // than the Sessions list's "Last 7 days" — reintroducing the exact
  // two-windows-one-label defect one field over, and making the KPI drift with
  // the clock instead of holding still for the UTC day.
  //
  // What the split costs, stated so it is not discovered as a surprise: a row
  // timestamped between `now` and `end` counts in a KPI and can have no column
  // beside it in the chart. It needs the row to land in a LOCAL day past the
  // axis's last, so it is unreachable at or west of UTC and reachable east of
  // it — and on desktop before cloud, because those timestamps come off the
  // machine that recorded the transcript rather than off a server clock. The
  // axis is not a narrower window; it is the list of days that have BEGUN, and
  // drawing a column for a day that has not started is a false zero.
  elapsedEnd: Date;
  // Prior window at the same phase one period earlier, closed after the span
  // the current window has elapsed. `priorStart` is null for "all time" — the
  // "no comparison" signal every reader already branches on — so `priorEnd`
  // degrades to an empty window rather than adding a second nullable bound the
  // first would have to be kept in step with.
  priorStart: Date | null;
  priorEnd: Date;
  // Bounded window used for time-series so "all time" does not explode into
  // tens of thousands of daily buckets.
  trendStart: Date;
  // ISS-12263: the bounds the Sessions list sends for this period, read by the
  // session reads ruled to match that list (ISS-10604, ISS-10541): the Sessions
  // KPI and status donut, and the cost. For "all" the list sends no bounds
  // (`getStableUtcDateWindowForRange`), so this is empty and those reads count a
  // session last active after `end`. `start..end` still bound every other read.
  sessionsWindow: SessionsWindow;
};

/**
 * FEA-2233: earliest relevant record across the tables that feed the delta KPIs
 * (merged PRs + agent sessions), scoped to the same org/me context as the rest
 * of the computation so a personal view is not gated by org-wide history (and
 * vice versa). Powers the "full prior period" rule in {@link reportDeltaFor}.
 * Returns null when there is no history at all.
 */
export async function earliestRecord(
  ctx: InsightsScopeContext
): Promise<Date | null> {
  const [session, pr] = await Promise.all([
    withDb((db) =>
      db.sessionDetail.aggregate({
        _min: { sessionStartedAt: true },
        where: { ...sessionScope(ctx) },
      })
    ),
    withDb((db) =>
      db.pullRequestDetail.aggregate({
        _min: { mergedAt: true },
        where: { branchArtifact: artifactScope(ctx) },
      })
    ),
  ]);
  return minDate(session._min.sessionStartedAt, pr._min.mergedAt);
}

/**
 * ISS-10583: the insights window is the SAME stable UTC day window the Sessions
 * and Branches surfaces resolve (`getStableUtcDateWindowForRange`), read from
 * the one producer both call, so one "Last 7 days" cannot mean two spans.
 */
export function resolvePeriodRange(
  period: InsightsPeriod,
  now: Date
): PeriodRange {
  const end = stableUtcDayEnd(now);
  const elapsedEnd = stableUtcWindowElapsedEnd(end, now);
  if (period === InsightsPeriodValues.All) {
    return {
      start: new Date(0),
      end,
      elapsedEnd,
      priorStart: null,
      priorEnd: new Date(0),
      trendStart: stableUtcDayStart(now, -TREND_LOOKBACK_DAYS + 1),
      sessionsWindow: {},
    };
  }
  const { start } = stableUtcDayWindow(Number(period), now);
  const prior = stableUtcPriorWindow(start, end, elapsedEnd);
  return {
    start,
    end,
    elapsedEnd,
    priorStart: prior?.start ?? null,
    priorEnd: prior?.end ?? start,
    trendStart: start,
    sessionsWindow: { start, end },
  };
}

/** Smallest of the provided dates, ignoring null/undefined; null if none. */
export function minDate(...dates: (Date | null | undefined)[]): Date | null {
  let earliest: Date | null = null;
  for (const date of dates) {
    if (date && (earliest === null || date < earliest)) {
      earliest = date;
    }
  }
  return earliest;
}

/**
 * FEA-2233: uniform calendar rule. Returns a delta reporter that only surfaces a
 * period-over-period percentage when history COVERS the prior window — the
 * earliest relevant record is on or before that window's start. Since ISS-10583
 * the prior window is a period-to-date slice rather than a full-width period, so
 * the bound is the slice's own opening instant and the rule is unchanged. For the "all" period `priorStart` is null, so this is naturally false
 * (no comparison). When not comparable the delta is null, which the dashboard
 * renders as a hidden chip rather than a misleading percentage computed against a
 * partial prior window. The empty-prior case (`prior === 0`) is still handled by
 * `pctDelta`.
 */
export function reportDeltaFor(
  range: PeriodRange,
  earliest: Date | null
): (current: number, prior: number) => number | null {
  const hasFullPriorPeriod =
    range.priorStart !== null &&
    earliest !== null &&
    earliest <= range.priorStart;
  return (current, prior) =>
    hasFullPriorPeriod ? pctDelta(current, prior) : null;
}

/** A Sessions-list date window; an absent bound constrains nothing. */
export type SessionsWindow = { start?: Date; end?: Date };
