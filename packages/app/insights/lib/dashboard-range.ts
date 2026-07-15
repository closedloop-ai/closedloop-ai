import type { InsightsPeriod } from "@repo/api/src/types/insights";
import {
  DATE_RANGE_LABELS,
  type DateRange,
} from "../../shared/lib/format-utils";

/**
 * FEA-2232: single source of truth for the dashboard's `DateRange`-derived
 * values, shared by the web overview dashboard and the desktop first-launch
 * dashboard (originally inlined in the desktop component for FEA-2210). Keeping
 * these maps in one place stops the WoW/MoM/QoQ labels and the
 * `DateRange -> InsightsPeriod` mapping from drifting between surfaces.
 */

/** Maps the renderer-only `DateRange` token to the `InsightsPeriod` the engine speaks. */
export const RANGE_TO_PERIOD: Record<DateRange, InsightsPeriod> = {
  "7d": "7",
  "30d": "30",
  "90d": "90",
  all: "all",
};

/**
 * Names the period-over-period comparison shown beside each KPI delta. The
 * window length sets the cadence (week/month/quarter); "all" has no fixed prior
 * period, so it falls back to the neutral "all time" caption.
 */
export const GROWTH_LABEL: Record<DateRange, string> = {
  "7d": "WoW",
  "30d": "MoM",
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
