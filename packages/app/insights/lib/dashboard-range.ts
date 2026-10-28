import type { InsightsPeriod } from "@repo/api/src/types/insights";
import { TimezoneMode } from "../../shared/lib/date-window-timezone-mode";
import {
  DATE_RANGE_LABELS,
  DATE_RANGES,
  DateRange,
} from "../../shared/lib/format-utils";

/**
 * FEA-2232: single source of truth for the dashboard's `DateRange`-derived
 * values, shared by the web overview dashboard and the desktop first-launch
 * dashboard (originally inlined in the desktop component for FEA-2210). Keeping
 * these maps in one place stops the WoW/MoM/QoQ labels and the
 * `DateRange -> InsightsPeriod` mapping from drifting between surfaces.
 */

/**
 * The ranges the insights engine can answer. The shared `DateRange` also carries
 * `60d` (ISS-12660, Sessions and Branches only); `InsightsPeriod` has no 60-day
 * period, so the dashboard picker offers this narrower set.
 */
export type DashboardDateRange = Exclude<
  DateRange,
  typeof DateRange.Last60Days
>;

export const DASHBOARD_DATE_RANGES: readonly DashboardDateRange[] =
  DATE_RANGES.filter(
    (range): range is DashboardDateRange => range !== DateRange.Last60Days
  );

/** Maps the renderer-only `DateRange` token to the `InsightsPeriod` the engine speaks. */
export const RANGE_TO_PERIOD: Record<DashboardDateRange, InsightsPeriod> = {
  "7d": "7",
  "30d": "30",
  "90d": "90",
  all: "all",
};

/**
 * A range the RUM `range_days` attribute cannot name. `InsightsPeriod` is the
 * closed set that attribute may carry and has no 60-day member, so the view
 * must carry NO range rather than a stale or widened one.
 *
 * It is a distinct value from the `null` every caller already passes while a
 * persisted view restores: that one leaves whatever the view carries alone,
 * this one has to CLEAR it. Collapsing the two is what left a reader who
 * switched 7d -> 60d tagged `7` for the rest of the view.
 */
export const RUM_VIEW_RANGE_UNTAGGED = "untagged";

export type RumViewRange = InsightsPeriod | typeof RUM_VIEW_RANGE_UNTAGGED;

/** The RUM `range_days` bucket for a list range, or the untagged marker. */
export function rumPeriodForRange(range: DateRange): RumViewRange {
  return range === DateRange.Last60Days
    ? RUM_VIEW_RANGE_UNTAGGED
    : RANGE_TO_PERIOD[range];
}

/**
 * Names the period-over-period comparison shown beside each KPI delta. The
 * window length sets the cadence (week/month/quarter, or "vs prior 60d" for
 * the lists-only 60d range); "all" has no fixed prior
 * period, so it falls back to the neutral "all time" caption.
 */
export const GROWTH_LABEL: Record<DateRange, string> = {
  "7d": "WoW",
  "30d": "MoM",
  "60d": "vs prior 60d",
  "90d": "QoQ",
  all: "all time",
};

/**
 * Caption for the trend/heatmap window. Trend sparklines (and the desktop
 * activity heatmap) are capped at 90 days by the insights engine, so the "all"
 * selection reflects that visual cap rather than claiming an unbounded window;
 * KPI totals still cover the full selected range.
 */
export function dashboardPeriodLabel(range: DateRange): string {
  return range === "all" ? "Last 90 days (max)" : DATE_RANGE_LABELS[range];
}

/**
 * Persistence surface key for the WEB overview dashboard's range picker (the
 * desktop first-launch dashboard keeps its own, so the two windows stay
 * independent). Independent of each other, not of their shell: the desktop one
 * is `shared:date-range:desktop`, which Sessions and Branches write too, so a
 * 60d list pick lands on a dashboard that has no period for it and resolves to
 * the default. It lives here rather than in the component because the
 * `apps/app` route also reads this selection to tag its RUM view (ISS-7250),
 * and a route should not have to import from a component module to do it.
 */
export const WEB_DASHBOARD_RANGE_SURFACE = "web";

/**
 * The day boundary the insights dashboard's window is quantized to, on both
 * shells. ISS-10583 put the dashboard on the same stable UTC day window the
 * Sessions surfaces resolve, so one "Last 7 days" is one window; this is the
 * declaration of the one case where it still is not.
 *
 * A reader who turns the closed-by-default Local day-boundary control on
 * (ISS-9619) moves the Sessions and Branches windows to their OWN midnight. The
 * dashboard stays on UTC and does not follow, for two reasons. Its aggregates
 * are asserted byte-identical in UTC and America/Chicago
 * (`golden-corpus-insights.integration.test.ts`) precisely so a window boundary
 * cannot quietly become local-day dependent. And the window is resolved
 * server-side from an `InsightsPeriod` alone — a period-over-period comparison
 * and a trend axis describing an org are one answer for that org, not one per
 * reader's device.
 *
 * It is a DECLARATION, not a switch. Nothing in production reads it, because
 * there is nothing to read it with: the dashboard sends a period and never a
 * window, so there is no seam where a mode could be honoured or ignored. It
 * records which day boundary the server-side answer is quantized to, the way
 * `SESSIONS_SURFACE_DATE_WINDOW_FIELD` records which timestamp its cohort is
 * windowed on, and the cross-surface parity suites compare the Sessions helper
 * under it so the two statements are read together.
 */
export const INSIGHTS_DASHBOARD_TIMEZONE_MODE: TimezoneMode = TimezoneMode.Utc;
