import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SessionSortDir, SessionSortKey } from "../../lib/session-sort-group";
import { useSessionsViewState } from "../use-sessions-view-state";

afterEach(() => {
  localStorage.clear();
});

describe("useSessionsViewState", () => {
  it("defaults to last-activity (desc), 7d window, all columns visible", () => {
    const { result } = renderHook(() => useSessionsViewState());
    expect(result.current.sortKey).toBe(SessionSortKey.LastActivity);
    expect(result.current.sortDir).toBe(SessionSortDir.Desc);
    expect(result.current.dateRange).toBe("7d");
    expect(result.current.visibleColumns.has("repo")).toBe(true);
    expect(result.current.visibleColumns.has("branch")).toBe(true);
    expect(result.current.visibleColumns.has("pr")).toBe(true);
    expect(result.current.visibleColumns.has("merge")).toBe(true);
    expect(result.current.visibleColumns.has("cost")).toBe(true);
  });

  it("sets and persists the time window", () => {
    const first = renderHook(() => useSessionsViewState("sessions:test"));
    act(() => first.result.current.setDateRange("30d"));
    expect(first.result.current.dateRange).toBe("30d");

    const second = renderHook(() => useSessionsViewState("sessions:test"));
    expect(second.result.current.dateRange).toBe("30d");
  });

  it("sets the sort key (from unsorted) and toggles direction", () => {
    const { result } = renderHook(() => useSessionsViewState());
    act(() => result.current.setSort(SessionSortKey.Cost, SessionSortDir.Desc));
    expect(result.current.sortKey).toBe(SessionSortKey.Cost);
    act(() => result.current.toggleSortDir());
    expect(result.current.sortDir).toBe(SessionSortDir.Asc);
  });

  it("toggles a column's visibility", () => {
    const { result } = renderHook(() => useSessionsViewState());
    act(() => result.current.toggleColumn("branch"));
    expect(result.current.visibleColumns.has("branch")).toBe(false);
    act(() => result.current.toggleColumn("branch"));
    expect(result.current.visibleColumns.has("branch")).toBe(true);
  });

  it("persists and restores view state by surface key", () => {
    const first = renderHook(() => useSessionsViewState("sessions:test"));
    act(() => {
      first.result.current.setSort(SessionSortKey.User, SessionSortDir.Asc);
      first.result.current.toggleColumn("model");
    });

    const second = renderHook(() => useSessionsViewState("sessions:test"));
    expect(second.result.current.sortKey).toBe(SessionSortKey.User);
    expect(second.result.current.sortDir).toBe(SessionSortDir.Asc);
    expect(second.result.current.visibleColumns.has("model")).toBe(false);
  });

  it("restores persisted hidden Branch state and filters unknown columns", () => {
    localStorage.setItem(
      "sessions:saved-view:sessions:test",
      JSON.stringify({
        sortKey: null,
        sortDir: SessionSortDir.Desc,
        hiddenColumns: ["branch", "future-column"],
      })
    );

    const { result } = renderHook(() => useSessionsViewState("sessions:test"));
    expect(result.current.visibleColumns.has("branch")).toBe(false);
    expect(result.current.visibleColumns.has("repo")).toBe(true);
    expect(result.current.visibleColumns.has("pr")).toBe(true);
    expect(result.current.visibleColumns.has("merge")).toBe(true);
    expect([...result.current.visibleColumns]).not.toContain("future-column");
  });

  it("can explicitly hide restored PR and Merge columns", () => {
    localStorage.setItem(
      "sessions:saved-view:sessions:test",
      JSON.stringify({
        sortKey: null,
        sortDir: SessionSortDir.Desc,
        hiddenColumns: ["pr", "merge"],
      })
    );

    const { result } = renderHook(() => useSessionsViewState("sessions:test"));
    expect(result.current.visibleColumns.has("pr")).toBe(false);
    expect(result.current.visibleColumns.has("merge")).toBe(false);
    expect(result.current.visibleColumns.has("branch")).toBe(true);
  });
});
