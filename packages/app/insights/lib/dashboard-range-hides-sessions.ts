import type { UtilizationInsightsResponse } from "@repo/api/src/types/insights";
import { DateRange } from "../../shared/lib/format-utils";
import type { DashboardDateRange } from "./dashboard-range";
import { InsightsKpiKey } from "./kpi-polarity";

/**
 * ISS-11927: the Dashboard emptied by its OWN date range, decided once for both
 * shells.
 *
 * The Dashboard opens on the default 7d range. A reader whose sessions are all
 * older than that window used to get a page that said nothing true about it:
 * Desktop drew "Ready" with every tile zeroed, and web replaced the body with
 * the never-synced "No agent sessions yet" (onboarding test, 2026-10-01). The
 * Sessions list fixed the same finding in ISS-11913 by naming the window and
 * offering "Show all time"; this is the Dashboard's half, with the same
 * behavior on web and Desktop.
 *
 * Three facts, all required:
 * - the selected range is BOUNDED — "all" cannot hide anything, and offering
 *   "Show all time" on it would be a control that does nothing;
 * - the window's own sessions KPI is a SETTLED zero for the selected range —
 *   not a payload carried over from the previous range by `keepPreviousData`,
 *   and not an absent KPI, which proves nothing either way;
 * - the reader has sessions OUTSIDE it — established by each shell's all-time
 *   read, never inferred from the window.
 */
export function dashboardRangeHidesSessions({
  dateRange,
  windowSessionCount,
  hasSessionsOutsideWindow,
}: {
  dateRange: DashboardDateRange;
  /** {@link utilizationWindowSessionCount} for the selected range. */
  windowSessionCount: number | null;
  /** An all-time read has established at least one session. */
  hasSessionsOutsideWindow: boolean;
}): boolean {
  return (
    dateRange !== DateRange.AllTime &&
    windowSessionCount === 0 &&
    hasSessionsOutsideWindow
  );
}

/**
 * The selected range's sessions KPI, or `null` when the payload cannot answer
 * for THIS range: unread, carried over from the previous selection
 * (`isPlaceholderData`), or missing the KPI.
 */
export function utilizationWindowSessionCount(
  utilization: UtilizationInsightsResponse | undefined,
  isPlaceholderData: boolean
): number | null {
  if (!utilization || isPlaceholderData) {
    return null;
  }
  // Optional-chained on purpose: this runs on every Dashboard render, so a
  // payload without `kpis` (an older peer, a partial fixture) must read as "no
  // answer", never take the page down.
  const sessionsKpi = utilization.kpis?.find(
    (kpi) => kpi.key === InsightsKpiKey.Sessions
  );
  return sessionsKpi?.value ?? null;
}
