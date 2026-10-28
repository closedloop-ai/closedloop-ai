import { DateRange } from "@repo/app/shared/lib/format-utils";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useDashboardRange } from "../use-dashboard-range";

const SHARED_KEY = "shared:date-range:web";
const LEGACY_KEY = "insights:dashboard-range:web";
const DESKTOP_SHARED_KEY = "shared:date-range:desktop";

afterEach(() => {
  localStorage.clear();
});

describe("useDashboardRange", () => {
  it("defaults to the 7d window when nothing is persisted", () => {
    const { result } = renderHook(() => useDashboardRange("web"));

    expect(result.current.dateRange).toBe("7d");
    expect(result.current.period).toBe("7");
    expect(result.current.deltaLabel).toBe("WoW");
    expect(result.current.periodLabel).toBe("Last 7 days");
  });

  it("migrates and restores a valid legacy persisted selection", () => {
    localStorage.setItem(LEGACY_KEY, "90d");

    const { result } = renderHook(() => useDashboardRange("web"));

    expect(result.current.dateRange).toBe("90d");
    expect(result.current.period).toBe("90");
    expect(result.current.deltaLabel).toBe("QoQ");
  });

  it("falls back to the default for an unrecognized persisted value", () => {
    localStorage.setItem(SHARED_KEY, JSON.stringify("bogus"));

    const { result } = renderHook(() => useDashboardRange("web"));

    expect(result.current.dateRange).toBe("7d");
  });

  it("persists the selection on change via the shared key", () => {
    const { result } = renderHook(() => useDashboardRange("web"));

    act(() => result.current.setDateRange("30d"));

    expect(result.current.dateRange).toBe("30d");
    expect(result.current.deltaLabel).toBe("MoM");
    expect(JSON.parse(localStorage.getItem(SHARED_KEY)!)).toBe("30d");
  });

  it("isolates surfaces by key", () => {
    const { result } = renderHook(() => useDashboardRange("web"));

    act(() => result.current.setDateRange("30d"));

    expect(localStorage.getItem("shared:date-range:desktop")).toBeNull();
  });

  it("derives the correct period label for 'all'", () => {
    const { result } = renderHook(() => useDashboardRange("web"));

    act(() => result.current.setDateRange("all"));

    expect(result.current.dateRange).toBe("all");
    expect(result.current.periodLabel).toBe("Last 90 days (max)");
  });

  /**
   * SessionsView, branches-view and first-launch-dashboard all resolve
   * `shared:date-range:desktop`, so a 60d list pick is a value the dashboard
   * reads and has no `InsightsPeriod` for. One shared key with 7d as the
   * answer is the ruling (Cosimo Corrigan, 2026-10-19), not a dashboard key of
   * its own.
   */
  it("renders the 7d default for a 60d list pick it cannot answer", () => {
    localStorage.setItem(
      DESKTOP_SHARED_KEY,
      JSON.stringify(DateRange.Last60Days)
    );

    const { result } = renderHook(() => useDashboardRange("desktop"));

    expect(result.current.dateRange).toBe("7d");
    expect(result.current.period).toBe("7");
    expect(result.current.deltaLabel).toBe("WoW");
  });

  it("leaves the shared 60d value stored, so the lists keep it", () => {
    localStorage.setItem(
      DESKTOP_SHARED_KEY,
      JSON.stringify(DateRange.Last60Days)
    );

    renderHook(() => useDashboardRange("desktop"));

    expect(JSON.parse(localStorage.getItem(DESKTOP_SHARED_KEY)!)).toBe("60d");
  });

  it("moves the lists off 60d once the dashboard itself picks a range", () => {
    localStorage.setItem(
      DESKTOP_SHARED_KEY,
      JSON.stringify(DateRange.Last60Days)
    );
    const { result } = renderHook(() => useDashboardRange("desktop"));

    act(() => result.current.setDateRange("30d"));

    expect(JSON.parse(localStorage.getItem(DESKTOP_SHARED_KEY)!)).toBe("30d");
  });
});
