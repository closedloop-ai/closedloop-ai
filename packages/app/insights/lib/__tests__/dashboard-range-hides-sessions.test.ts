import type { UtilizationInsightsResponse } from "@repo/api/src/types/insights";
import { describe, expect, it } from "vitest";
import {
  dashboardRangeHidesSessions,
  utilizationWindowSessionCount,
} from "../dashboard-range-hides-sessions";

/** ISS-11927: the one rule both Dashboard shells draw the date-range empty on. */
describe("dashboardRangeHidesSessions", () => {
  it("holds for a bounded range whose settled count is zero over sessions that exist", () => {
    for (const dateRange of ["7d", "30d", "90d"] as const) {
      expect(
        dashboardRangeHidesSessions({
          dateRange,
          windowSessionCount: 0,
          hasSessionsOutsideWindow: true,
        })
      ).toBe(true);
    }
  });

  it("never holds on All time, where Show all time would do nothing", () => {
    expect(
      dashboardRangeHidesSessions({
        dateRange: "all",
        windowSessionCount: 0,
        hasSessionsOutsideWindow: true,
      })
    ).toBe(false);
  });

  it("needs sessions outside the window, a zero count, and an answer", () => {
    expect(
      dashboardRangeHidesSessions({
        dateRange: "7d",
        windowSessionCount: 0,
        hasSessionsOutsideWindow: false,
      })
    ).toBe(false);
    expect(
      dashboardRangeHidesSessions({
        dateRange: "7d",
        windowSessionCount: 2,
        hasSessionsOutsideWindow: true,
      })
    ).toBe(false);
    expect(
      dashboardRangeHidesSessions({
        dateRange: "7d",
        windowSessionCount: null,
        hasSessionsOutsideWindow: true,
      })
    ).toBe(false);
  });
});

describe("utilizationWindowSessionCount", () => {
  const payload = (kpis: { key: string; value: number }[]) =>
    ({ charts: {}, kpis }) as unknown as UtilizationInsightsResponse;

  it("reads the sessions KPI of the payload answering for this range", () => {
    expect(
      utilizationWindowSessionCount(
        payload([{ key: "sessions", value: 0 }]),
        false
      )
    ).toBe(0);
  });

  it("answers null for a carried-over, absent, or KPI-less payload", () => {
    expect(
      utilizationWindowSessionCount(
        payload([{ key: "sessions", value: 0 }]),
        true
      )
    ).toBeNull();
    expect(utilizationWindowSessionCount(undefined, false)).toBeNull();
    expect(
      utilizationWindowSessionCount(
        {} as unknown as UtilizationInsightsResponse,
        false
      )
    ).toBeNull();
    expect(
      utilizationWindowSessionCount(
        payload([{ key: "events", value: 0 }]),
        false
      )
    ).toBeNull();
  });
});
