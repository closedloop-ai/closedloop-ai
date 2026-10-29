import { insightsPeriodDays } from "@closedloop-ai/loops-api/insights";
import { stableUtcListWindow } from "@closedloop-ai/loops-api/stable-utc-window";
import {
  DATE_RANGES,
  getStableUtcDateWindowForRange,
} from "@repo/app/shared/lib/format-utils";
import { describe, expect, it } from "vitest";
import {
  DASHBOARD_DATE_RANGES,
  type DashboardDateRange,
  dashboardPeriodLabel,
  GROWTH_LABEL,
  RANGE_TO_PERIOD,
  RUM_VIEW_RANGE_UNTAGGED,
  rumPeriodForRange,
} from "../dashboard-range";

// One row per selectable window; asserts the three derived values together so a
// drift in any single map surfaces here rather than in surface integration.
const cases: Array<{
  range: DashboardDateRange;
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
  it.each(cases)(
    "$range -> period $period, delta $deltaLabel, label $periodLabel",
    ({ range, period, deltaLabel, periodLabel }) => {
      expect(RANGE_TO_PERIOD[range]).toBe(period);
      expect(GROWTH_LABEL[range]).toBe(deltaLabel);
      expect(dashboardPeriodLabel(range)).toBe(periodLabel);
    }
  );
});

// ISS-12660: 60d is a Sessions/Branches range only. The insights engine has no
// 60-day period, so the dashboard set excludes it and RUM carries no range.
describe("60d range", () => {
  it("is offered to the lists but not the dashboard", () => {
    expect(DATE_RANGES).toContain("60d");
    expect(DASHBOARD_DATE_RANGES).not.toContain("60d");
  });

  it("names its comparison caption", () => {
    expect(GROWTH_LABEL["60d"]).toBe("vs prior 60d");
    expect(dashboardPeriodLabel("60d")).toBe("Last 60 days");
  });

  /**
   * tamsinb review on #8938: this returned `null`, which `useRumViewRange`
   * already spends on "window not known yet" — so a 60d pick skipped the write
   * and left the view carrying the PREVIOUS range. A marker distinct from
   * `null` is what lets the hook clear the attribute instead.
   */
  it("marks the RUM range untagged, distinctly from not-yet-known", () => {
    expect(rumPeriodForRange("60d")).toBe(RUM_VIEW_RANGE_UNTAGGED);
    expect(rumPeriodForRange("60d")).not.toBeNull();
    expect(rumPeriodForRange("30d")).toBe("30");
  });

  it("resolves to a window 30 days wider than 30d and 30 narrower than 90d", () => {
    const now = new Date("2026-10-08T13:45:12.345Z");
    const width = (range: "30d" | "60d" | "90d") => {
      const { startDate, endDate } = getStableUtcDateWindowForRange(range, now);
      return Date.parse(endDate ?? "") - Date.parse(startDate ?? "");
    };
    const day = 24 * 60 * 60 * 1000;
    expect(width("60d") - width("30d")).toBe(30 * day);
    expect(width("90d") - width("60d")).toBe(30 * day);
  });
});

// ISS-11915 (operator ruling 2026-10-08): the Dashboard's branch population
// resolves its period through `insightsPeriodDays` + `stableUtcListWindow`
// server-side, and the Branches list sends `getStableUtcDateWindowForRange`.
// One range must name one window on both, at every hour of the UTC day.
describe("Dashboard and Branches list window bounds", () => {
  const RANGES = DASHBOARD_DATE_RANGES;
  const CLOCKS = [
    new Date("2026-10-08T00:00:00.000Z"),
    new Date("2026-10-08T13:45:12.345Z"),
    new Date("2026-10-08T23:59:59.999Z"),
  ];

  for (const range of RANGES) {
    it(`resolves the ${range} range to the Branches list window`, () => {
      for (const now of CLOCKS) {
        expect(
          stableUtcListWindow(insightsPeriodDays(RANGE_TO_PERIOD[range]), now)
        ).toEqual(getStableUtcDateWindowForRange(range, now));
      }
    });
  }
});
