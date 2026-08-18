import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { AuthAdapterProvider } from "../../../shared/auth/provider";
import { createStaticAuthAdapter } from "../../../shared/auth/static-auth-adapter";
import { BranchSortDir, BranchSortKey } from "../../lib/branch-sort-group";
import { useBranchViewState } from "../use-branch-view-state";

describe("useBranchViewState", () => {
  // The isViewReady case below resolves a real storage key and persists through
  // it; without this every later test in the file would restore that leftover
  // view instead of the defaults it asserts.
  afterEach(() => localStorage.clear());

  it("defaults to updated-desc, 7d window, all columns visible", () => {
    const { result } = renderHook(() => useBranchViewState());
    expect(result.current.sortKey).toBe(BranchSortKey.LastActivity);
    expect(result.current.sortDir).toBe(BranchSortDir.Desc);
    expect(result.current.dateRange).toBe("7d");
    expect(result.current.visibleColumns.has("repo")).toBe(true);
    expect(result.current.visibleColumns.has("changes")).toBe(true);
  });

  it("uses the approved 30d default and exact visibility-only schema", () => {
    const { result } = renderHook(() => useBranchViewState(undefined, true));

    expect(result.current.dateRange).toBe("30d");
    expect([...result.current.visibleColumns]).toEqual([
      "owner",
      "collaborators",
      "sessions",
      "changes",
      "status",
      "pr",
      "lastActivity",
      "repo",
      "tags",
    ]);
    expect(result.current.visibleColumns.has("checks")).toBe(false);
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

  // ISS-4655: `dateRange` feeds the branches query key, so the surface needs to
  // know when it has stopped being the default. Nothing else re-exports this,
  // and the page's `enabled` reads it — drop it from the return and the page
  // silently paginates against a window the restore is about to replace.
  it("reports whether the view has settled, gated on auth", () => {
    const hydrating = ({ children }: { children: ReactNode }) => (
      <AuthAdapterProvider
        adapter={createStaticAuthAdapter({ isLoaded: false })}
      >
        {children}
      </AuthAdapterProvider>
    );
    const { result: pending } = renderHook(
      () => useBranchViewState("branches:web", true),
      { wrapper: hydrating }
    );
    expect(pending.current.isViewReady).toBe(false);

    const loaded = ({ children }: { children: ReactNode }) => (
      <AuthAdapterProvider
        adapter={createStaticAuthAdapter({ userId: "user_alice" })}
      >
        {children}
      </AuthAdapterProvider>
    );
    const { result: ready } = renderHook(
      () => useBranchViewState("branches:web", true),
      { wrapper: loaded }
    );
    expect(ready.current.isViewReady).toBe(true);
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
