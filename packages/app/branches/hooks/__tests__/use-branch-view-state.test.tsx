import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BranchSortDir, BranchSortKey } from "../../lib/branch-sort-group";
import { useBranchViewState } from "../use-branch-view-state";

describe("useBranchViewState", () => {
  it("defaults to updated-desc, 7d window, all columns visible", () => {
    const { result } = renderHook(() => useBranchViewState());
    expect(result.current.sortKey).toBe(BranchSortKey.LastActivity);
    expect(result.current.sortDir).toBe(BranchSortDir.Desc);
    expect(result.current.dateRange).toBe("7d");
    expect(result.current.visibleColumns.has("repo")).toBe(true);
    expect(result.current.visibleColumns.has("changes")).toBe(true);
  });

  it("sets the time window", () => {
    const { result } = renderHook(() => useBranchViewState());
    act(() => result.current.setDateRange("90d"));
    expect(result.current.dateRange).toBe("90d");
  });

  it("sets the sort key and toggles direction", () => {
    const { result } = renderHook(() => useBranchViewState());
    act(() => result.current.setSort(BranchSortKey.Name));
    expect(result.current.sortKey).toBe(BranchSortKey.Name);
    act(() => result.current.toggleSortDir());
    expect(result.current.sortDir).toBe(BranchSortDir.Asc);
  });

  it("toggles a column's visibility", () => {
    const { result } = renderHook(() => useBranchViewState());
    expect(result.current.visibleColumns.has("changes")).toBe(true);
    act(() => result.current.toggleColumn("changes"));
    expect(result.current.visibleColumns.has("changes")).toBe(false);
    act(() => result.current.toggleColumn("changes"));
    expect(result.current.visibleColumns.has("changes")).toBe(true);
  });
});
