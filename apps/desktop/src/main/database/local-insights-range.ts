/**
 * Insights window + day-axis resolution for the desktop-local backend.
 *
 * Split out of `local-insights.ts` so that file owns the SQL/aggregation work
 * and this module owns one responsibility: turning a selected `InsightsPeriod`
 * into the four ISO boundaries every section query is scoped by, and walking the
 * LOCAL calendar-day axis those queries' buckets must line up with.
 *
 * Timezone contract (FEA-2430): timestamps are STORED as UTC ISO strings; window
 * BOUNDARIES stay rolling UTC instants, and only bucket LABELS are local. The
 * `eachDay` walk below and the `localDay()` SQL buckets in `local-insights.ts`
 * must stay in lockstep (matching keys) or charts silently drop data.
 */
import type { InsightsPeriod } from "@closedloop-ai/loops-api/insights";
import { InsightsPeriod as InsightsPeriodValues } from "@closedloop-ai/loops-api/insights";
import { formatLocalDayKey } from "./db-helpers.js";
import { TREND_LOOKBACK_DAYS } from "./insights-trend-window.js";

const MS_PER_DAY = 86_400_000;

export type Range = {
  startIso: string;
  endIso: string;
  trendStartIso: string;
  priorStartIso: string;
};

export function resolveRange(period: InsightsPeriod, now: Date): Range {
  const endIso = now.toISOString();
  // FEA-2210: the trend sparklines + activity heatmap follow the selected
  // period but are capped at TREND_LOOKBACK_DAYS (90) so long ranges — and
  // "all" — stay readable (the all-time corpus paints an unreadable ~200-column
  // heatmap). KPI totals below still use the full, uncapped selected window.
  const trendDays =
    period === InsightsPeriodValues.All
      ? TREND_LOOKBACK_DAYS
      : Math.min(Number(period), TREND_LOOKBACK_DAYS);
  const trendStartIso = new Date(
    now.getTime() - trendDays * MS_PER_DAY
  ).toISOString();
  if (period === InsightsPeriodValues.All) {
    return {
      startIso: new Date(0).toISOString(),
      endIso,
      trendStartIso,
      priorStartIso: new Date(0).toISOString(),
    };
  }
  const days = Number(period);
  const start = new Date(now.getTime() - days * MS_PER_DAY);
  return {
    startIso: start.toISOString(),
    endIso,
    trendStartIso,
    priorStartIso: new Date(start.getTime() - days * MS_PER_DAY).toISOString(),
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
