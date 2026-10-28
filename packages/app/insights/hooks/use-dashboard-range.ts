"use client";

import type { InsightsPeriod } from "@repo/api/src/types/insights";
import { useSharedDateRange } from "../../shared/hooks/use-shared-date-range";
import {
  DASHBOARD_DATE_RANGES,
  type DashboardDateRange,
  dashboardPeriodLabel,
  GROWTH_LABEL,
  RANGE_TO_PERIOD,
} from "../lib/dashboard-range";

export type DashboardRangeState = {
  dateRange: DashboardDateRange;
  setDateRange: (range: DashboardDateRange) => void;
  period: InsightsPeriod;
  periodLabel: string;
  deltaLabel: string;
};

export function useDashboardRange(surface: string): DashboardRangeState {
  const { dateRange, setDateRange } = useSharedDateRange(
    surface,
    undefined,
    DASHBOARD_DATE_RANGES
  );
  return {
    dateRange,
    setDateRange,
    period: RANGE_TO_PERIOD[dateRange],
    periodLabel: dashboardPeriodLabel(dateRange),
    deltaLabel: GROWTH_LABEL[dateRange],
  };
}
