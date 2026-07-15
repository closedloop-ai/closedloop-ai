"use client";

import type { InsightsPeriod } from "@repo/api/src/types/insights";
import { useSharedDateRange } from "../../shared/hooks/use-shared-date-range";
import type { DateRange } from "../../shared/lib/format-utils";
import {
  dashboardPeriodLabel,
  GROWTH_LABEL,
  RANGE_TO_PERIOD,
} from "../lib/dashboard-range";

export type DashboardRangeState = {
  dateRange: DateRange;
  setDateRange: (range: DateRange) => void;
  period: InsightsPeriod;
  periodLabel: string;
  deltaLabel: string;
};

export function useDashboardRange(surface: string): DashboardRangeState {
  const { dateRange, setDateRange } = useSharedDateRange(surface);
  return {
    dateRange,
    setDateRange,
    period: RANGE_TO_PERIOD[dateRange],
    periodLabel: dashboardPeriodLabel(dateRange),
    deltaLabel: GROWTH_LABEL[dateRange],
  };
}
