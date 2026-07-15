import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSharedDateRange } from "../use-shared-date-range";

const SHARED_KEY = "shared:date-range:test";
const LEGACY_KEY = "insights:dashboard-range:test";

afterEach(() => {
  localStorage.clear();
});

describe("useSharedDateRange", () => {
  it("defaults to the 90d window when nothing is persisted", () => {
    const { result } = renderHook(() => useSharedDateRange("test"));
    expect(result.current.dateRange).toBe("90d");
  });

  it("persists and restores a selection", () => {
    const first = renderHook(() => useSharedDateRange("test"));
    act(() => first.result.current.setDateRange("7d"));
    expect(first.result.current.dateRange).toBe("7d");

    const second = renderHook(() => useSharedDateRange("test"));
    expect(second.result.current.dateRange).toBe("7d");
  });

  it("falls back to default for an invalid persisted value", () => {
    localStorage.setItem(SHARED_KEY, JSON.stringify("bogus"));
    const { result } = renderHook(() => useSharedDateRange("test"));
    expect(result.current.dateRange).toBe("90d");
  });

  it("migrates from the legacy dashboard key on first mount", () => {
    localStorage.setItem(LEGACY_KEY, "30d");

    const { result } = renderHook(() => useSharedDateRange("test"));
    expect(result.current.dateRange).toBe("30d");
    expect(localStorage.getItem(SHARED_KEY)).toBe(JSON.stringify("30d"));
  });

  it("does not migrate if the shared key already exists", () => {
    localStorage.setItem(SHARED_KEY, JSON.stringify("7d"));
    localStorage.setItem(LEGACY_KEY, "90d");

    const { result } = renderHook(() => useSharedDateRange("test"));
    expect(result.current.dateRange).toBe("7d");
  });

  it("ignores an invalid legacy key value during migration", () => {
    localStorage.setItem(LEGACY_KEY, "invalid-range");

    const { result } = renderHook(() => useSharedDateRange("test"));
    expect(result.current.dateRange).toBe("90d");
  });

  it("isolates surfaces by key", () => {
    const desktop = renderHook(() => useSharedDateRange("desktop"));
    const web = renderHook(() => useSharedDateRange("web"));

    act(() => desktop.result.current.setDateRange("7d"));

    expect(desktop.result.current.dateRange).toBe("7d");
    expect(web.result.current.dateRange).toBe("90d");
  });

  it("syncs across hook instances via StorageEvent", () => {
    const a = renderHook(() => useSharedDateRange("sync-test"));
    const b = renderHook(() => useSharedDateRange("sync-test"));

    act(() => a.result.current.setDateRange("30d"));

    expect(a.result.current.dateRange).toBe("30d");
    expect(b.result.current.dateRange).toBe("30d");
  });

  it("falls back to default when localStorage.getItem throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Access denied", "SecurityError");
    });

    const { result } = renderHook(() => useSharedDateRange("test"));
    expect(result.current.dateRange).toBe("90d");

    vi.restoreAllMocks();
  });

  it("does not throw when localStorage.setItem fails (private mode / quota)", () => {
    const { result } = renderHook(() => useSharedDateRange("test"));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });

    expect(() => act(() => result.current.setDateRange("7d"))).not.toThrow();

    vi.restoreAllMocks();
  });
});
