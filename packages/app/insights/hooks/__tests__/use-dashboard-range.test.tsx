import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useDashboardRange } from "../use-dashboard-range";

const SHARED_KEY = "shared:date-range:web";
const LEGACY_KEY = "insights:dashboard-range:web";

afterEach(() => {
  localStorage.clear();
});

describe("useDashboardRange", () => {
  it("defaults to the 90d window when nothing is persisted", () => {
    const { result } = renderHook(() => useDashboardRange("web"));

    expect(result.current.dateRange).toBe("90d");
    expect(result.current.period).toBe("90");
    expect(result.current.deltaLabel).toBe("QoQ");
    expect(result.current.periodLabel).toBe("Last 90 days");
  });

  it("migrates and restores a valid legacy persisted selection", () => {
    localStorage.setItem(LEGACY_KEY, "7d");

    const { result } = renderHook(() => useDashboardRange("web"));

    expect(result.current.dateRange).toBe("7d");
    expect(result.current.period).toBe("7");
    expect(result.current.deltaLabel).toBe("WoW");
  });

  it("falls back to the default for an unrecognized persisted value", () => {
    localStorage.setItem(SHARED_KEY, JSON.stringify("bogus"));

    const { result } = renderHook(() => useDashboardRange("web"));

    expect(result.current.dateRange).toBe("90d");
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
});
