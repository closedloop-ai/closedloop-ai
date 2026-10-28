import type { InsightsScope } from "@closedloop-ai/loops-api/insights";
import { DashboardRefreshingIndicator } from "@repo/app/insights/components/overview/dashboard-refreshing";
import { DashboardScopeControl } from "@repo/app/insights/components/overview/dashboard-scope-control";
import {
  DASHBOARD_DATE_RANGES,
  type DashboardDateRange,
} from "@repo/app/insights/lib/dashboard-range";
import { DateRangeFilter } from "@repo/app/shared/components/date-range-filter";

/**
 * The dashboard's page title row — refresh state, the range picker, and the
 * Me / Organization scope toggle.
 *
 * ISS-10929 retired the read-source pill and the Tour control from this row, and
 * ISS-10942 moved the guest account offer into the sidebar's Getting started
 * module. The scope toggle went out with them and is restored here by operator
 * instruction (2026-09-30), which ruled that removal a regression.
 *
 * Extracted from `FirstLaunchDashboard`, which sits on the cognitive-complexity
 * ceiling: this row is pure presentation over props its owner already holds.
 */
export function DashboardHeaderActions({
  dateRange,
  onDateRangeChange,
  onScopeChange,
  refreshing,
  scope,
  scopeAvailable,
}: {
  dateRange: DashboardDateRange;
  onDateRangeChange: (value: DashboardDateRange) => void;
  onScopeChange: (value: string) => void;
  refreshing: boolean;
  scope: InsightsScope;
  scopeAvailable: boolean;
}) {
  return (
    <>
      {/* FEA-4020: the single dashboard-wide "Refreshing" indicator — one
          range/scope change refetches every widget, so it reads as one header
          indicator rather than a spinner on every row. */}
      <DashboardRefreshingIndicator refreshing={refreshing} />
      <DateRangeFilter
        onChange={onDateRangeChange}
        ranges={DASHBOARD_DATE_RANGES}
        value={dateRange}
      />
      <DashboardScopeControl
        available={scopeAvailable}
        onValueChange={onScopeChange}
        scope={scope}
      />
    </>
  );
}
