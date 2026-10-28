import { SessionsEmptyState } from "@repo/app/agents/components/sessions/sessions-empty-state";
import type { ReactNode } from "react";

/**
 * ISS-11927: the Dashboard body when the selected date range hides sessions
 * the reader has (`dashboardRangeHidesSessions`). One body for web and Desktop.
 *
 * Not a new empty state: it IS the Sessions list's date-range empty
 * (ISS-11913), which is Branches' "No matching … / Show all time" with
 * "sessions" for "branches" (Kaito, ISS-11913, 2026-10-02). The Dashboard
 * counts sessions too, so it reuses that approved state verbatim, in the same
 * card frame the never-synced body draws in, rather than inventing a third
 * wording for the same situation.
 */
export function DashboardRangeEmptyBody({
  onShowAllTime,
}: Readonly<{ onShowAllTime: () => void }>): ReactNode {
  return (
    <div
      className="flex min-h-[360px] flex-1 flex-col justify-center rounded-xl border border-border/70 bg-card"
      data-testid="dashboard-range-empty"
    >
      <SessionsEmptyState
        onShowAllTime={onShowAllTime}
        signals={{ isUnavailable: false, hasActiveFilters: true }}
      />
    </div>
  );
}
