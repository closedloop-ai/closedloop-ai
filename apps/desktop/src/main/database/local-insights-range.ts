/**
 * Insights window + day-axis resolution for the desktop-local backend.
 *
 * Split out of `local-insights.ts` so that file owns the SQL/aggregation work
 * and this module owns one responsibility: turning a selected `InsightsPeriod`
 * into the ISO boundaries every section query is scoped by, and walking the
 * LOCAL calendar-day axis those queries' buckets must line up with.
 *
 * Timezone contract (FEA-2430, ISS-10583): timestamps are STORED as UTC ISO
 * strings; window BOUNDARIES are UTC instants — stable UTC day bounds since
 * ISS-10583, rolling before it — and only bucket LABELS are local. The
 * `eachDay` walk below and the `localDay()` SQL buckets in `local-insights.ts`
 * must stay in lockstep (matching keys) or charts silently drop data.
 */
import type { InsightsPeriod } from "@closedloop-ai/loops-api/insights";
import { InsightsPeriod as InsightsPeriodValues } from "@closedloop-ai/loops-api/insights";
import {
  stableUtcDayEnd,
  stableUtcDayStart,
  stableUtcDayWindow,
  stableUtcPriorWindow,
  stableUtcWindowElapsedEnd,
} from "@closedloop-ai/loops-api/stable-utc-window";
import { SESSIONS_SURFACE_DATE_WINDOW_FIELD } from "../../shared/session-date-window-contract.js";
import { formatLocalDayKey } from "./db-helpers.js";
import { TREND_LOOKBACK_DAYS } from "./insights-trend-window.js";

const EPOCH_ISO = new Date(0).toISOString();

export type Range = {
  startIso: string;
  endIso: string;
  /**
   * The instant the window has actually reached. `endIso` runs ahead of the
   * clock, so the day-axis walk and the prior window bound HERE — see
   * `stableUtcWindowElapsedEnd`.
   */
  elapsedEndIso: string;
  trendStartIso: string;
  priorStartIso: string;
  priorEndIso: string;
  /**
   * ISS-10604: WHICH session timestamp these boundaries are compared against.
   *
   * It rides on the range rather than on each `compute*` signature because a
   * window IS a pair of instants plus the column they are measured against —
   * splitting the two let the Sessions KPI and the Sessions-by-day series under
   * it bound on different columns for one selected period, which is the defect.
   *
   * ISS-10541 left it with ONE reachable value, and it is TYPED as that value
   * rather than as the union. It stays a named field because the property that
   * matters is that every read in one section shares the column, and eight call
   * sites deriving their predicate from one member is what makes that checkable
   * — six SQL strings each spelling the column out is the shape the defect had.
   * But the union type would have let a second basis back into the insights
   * range with nothing to object, which is the same shape as the defect
   * ISS-10604 closed, so the literal is what holds the retirement shut.
   */
  dateWindowField: typeof SESSIONS_SURFACE_DATE_WINDOW_FIELD;
  /**
   * ISS-12263: the bounds the Sessions list sends for this period
   * (`getStableDateWindowForRange`, UTC mode), read by the session reads ruled
   * to match that list (ISS-10604, ISS-10541): the Sessions KPI, its status
   * donut, and the cost. For "all" the list sends none, so this is empty and
   * those reads count a session last active after `endIso`. Every other read
   * keeps `startIso..endIso`.
   */
  sessionsWindow: SessionsWindow;
};

/**
 * ISS-10583: the SAME stable UTC day window the Sessions surfaces resolve
 * (`getStableUtcDateWindowForRange`) and the cloud `resolvePeriodRange` does,
 * read from the one producer all three call.
 */
export function resolveRange(period: InsightsPeriod, now: Date): Range {
  // ISS-10541: not a parameter any more. The caller cannot choose a basis, so a
  // version-skewed renderer and a current one resolve the same window and the
  // two rendered "Sessions" counts cannot disagree about which column bounds
  // them.
  const dateWindowField = SESSIONS_SURFACE_DATE_WINDOW_FIELD;
  const end = stableUtcDayEnd(now);
  const endIso = end.toISOString();
  const elapsedEndIso = stableUtcWindowElapsedEnd(end, now).toISOString();
  // FEA-2210: the trend sparklines + activity heatmap follow the selected
  // period but are capped at TREND_LOOKBACK_DAYS (90) so long ranges — and
  // "all" — stay readable (the all-time corpus paints an unreadable ~200-column
  // heatmap). KPI totals below still use the full, uncapped selected window.
  const trendDays =
    period === InsightsPeriodValues.All
      ? TREND_LOOKBACK_DAYS
      : Math.min(Number(period), TREND_LOOKBACK_DAYS);
  const trendStartIso = stableUtcDayStart(now, -trendDays + 1).toISOString();
  if (period === InsightsPeriodValues.All) {
    return {
      startIso: EPOCH_ISO,
      endIso,
      elapsedEndIso,
      trendStartIso,
      priorStartIso: EPOCH_ISO,
      priorEndIso: EPOCH_ISO,
      dateWindowField,
      sessionsWindow: {},
    };
  }
  const { start } = stableUtcDayWindow(Number(period), now);
  const prior = stableUtcPriorWindow(start, end, new Date(elapsedEndIso));
  return {
    startIso: start.toISOString(),
    endIso,
    elapsedEndIso,
    trendStartIso,
    // Nothing elapsed means no comparison, and the epoch is how that is said
    // here — the same sentinel the "all" period above uses, which the
    // comparability gate in `local-insights-delivery` already refuses. Falling
    // back to `start` instead would leave that gate passing over an EMPTY prior
    // window and grade every delta against a fabricated zero. Unreachable while
    // the shortest period is 7 days; the next shorter one is what arms it.
    priorStartIso: (prior?.start ?? new Date(0)).toISOString(),
    priorEndIso: (prior?.end ?? new Date(0)).toISOString(),
    dateWindowField,
    sessionsWindow: { startDate: start.toISOString(), endDate: endIso },
  };
}

// Exported for the Layer 3 golden derivation (FEA-2649): the day-axis walk is
// lockstep-critical with the localDay() SQL buckets (see the timezone contract
// above), so tests share THIS implementation instead of growing a third copy.
export function eachDay(startIso: string, endIso: string): string[] {
  const keys: string[] = [];
  // FEA-2430: local calendar days (was UTC). Floor both ends to LOCAL midnight
  // and advance with local setDate so DST-transition days (23h/25h) still
  // yield exactly one label each.
  const cursor = new Date(startIso);
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(endIso);
  end.setHours(0, 0, 0, 0);
  while (cursor.getTime() <= end.getTime()) {
    // FEA-2430: LOCAL yyyy-MM-dd key matching the localDay() SQL buckets — the
    // two must stay in lockstep (see timezone contract above).
    keys.push(formatLocalDayKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
}

/** A Sessions-list date window, as ISO instants; an absent bound constrains nothing. */
export type SessionsWindow = { startDate?: string; endDate?: string };
