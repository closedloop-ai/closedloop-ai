import type { DateRange } from "@repo/app/shared/lib/format-utils";
import { describe, expect, it } from "vitest";
import {
  dashboardPeriodLabel,
  GROWTH_LABEL,
  RANGE_TO_PERIOD,
} from "../dashboard-range";

// One row per selectable window; asserts the three derived values together so a
// drift in any single map surfaces here rather than in surface integration.
const cases: Array<{
  range: DateRange;
  period: string;
  deltaLabel: string;
  periodLabel: string;
}> = [
  { range: "7d", period: "7", deltaLabel: "WoW", periodLabel: "Last 7 days" },
  {
    range: "30d",
    period: "30",
    deltaLabel: "MoM",
    periodLabel: "Last 30 days",
  },
  {
    range: "90d",
    period: "90",
    deltaLabel: "QoQ",
    periodLabel: "Last 90 days",
  },
  {
    range: "all",
    period: "all",
    deltaLabel: "all time",
    // "all" reflects the 90-day trend/heatmap cap, not an unbounded window.
    periodLabel: "Last 90 days (max)",
  },
];

describe("dashboard-range maps", () => {
  it.each(
    cases
  )("$range -> period $period, delta $deltaLabel, label $periodLabel", ({
    range,
    period,
    deltaLabel,
    periodLabel,
  }) => {
    expect(RANGE_TO_PERIOD[range]).toBe(period);
    expect(GROWTH_LABEL[range]).toBe(deltaLabel);
    expect(dashboardPeriodLabel(range)).toBe(periodLabel);
  });
});
