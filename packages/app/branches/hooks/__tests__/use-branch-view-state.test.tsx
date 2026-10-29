import { BranchMetricId } from "@repo/api/src/types/branch-metrics";
import { DEFAULT_TABLE_PAGE_SIZE } from "@repo/design-system/components/ui/table-page-size-select";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { AuthAdapterProvider } from "../../../shared/auth/provider";
import { createStaticAuthAdapter } from "../../../shared/auth/static-auth-adapter";
import { DEFAULT_BRANCH_ARRANGEMENT } from "../../lib/branch-saved-views";
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

  it("uses the shared 7d default and exact visibility-only schema", () => {
    const { result } = renderHook(() => useBranchViewState(undefined, true));

    expect(result.current.dateRange).toBe("7d");
    expect([...result.current.visibleColumns]).toEqual([
      "owner",
      // ISS-10332: shown by default (operator ruling 5, 2026-09-21).
      "priority",
      "collaborators",
      "sessions",
      "changes",
      "status",
      "pr",
      "lastActivity",
      "repo",
      "tags",
      "project",
    ]);
    expect(result.current.visibleColumns.has("checks")).toBe(false);
  });

  it("ISS-12664: hides a summary card across a remount; resetView brings it back but resetColumns does not", () => {
    const first = renderHook(() => useBranchViewState("cards", true));
    expect(first.result.current.hiddenSummaryCards.size).toBe(0);

    act(() => first.result.current.toggleSummaryCard(BranchMetricId.MergeRate));
    expect([...first.result.current.hiddenSummaryCards]).toEqual([
      BranchMetricId.MergeRate,
    ]);
    first.unmount();

    const second = renderHook(() => useBranchViewState("cards", true));
    expect([...second.result.current.hiddenSummaryCards]).toEqual([
      BranchMetricId.MergeRate,
    ]);

    act(() => second.result.current.resetColumns());
    expect(
      second.result.current.hiddenSummaryCards.has(BranchMetricId.MergeRate)
    ).toBe(true);

    act(() => second.result.current.resetView());
    expect(second.result.current.hiddenSummaryCards.size).toBe(0);
  });

  it("resetView also ungroups and reopens collapsed bands, leaving sort and window alone", () => {
    const { result } = renderHook(() => useBranchViewState(undefined, true));
    act(() => {
      result.current.setGrouping({
        ...EMPTY_TABLE_GROUPING,
        primary: { ...EMPTY_TABLE_GROUPING.primary, fieldId: "status" },
      });
      result.current.setCollapsedGroups({ "status|": ["open"] });
      result.current.setSort(BranchSortKey.Name);
      result.current.setDateRange("90d");
    });

    act(() => result.current.resetView());

    expect(result.current.grouping).toEqual(EMPTY_TABLE_GROUPING);
    expect(result.current.collapsedGroups).toEqual({});
    expect(result.current.sortKey).toBe(BranchSortKey.Name);
    expect(result.current.dateRange).toBe("90d");
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

  it("preserves approved column order through restore and arrangement apply", async () => {
    const userId = "user_approved_order";
    localStorage.setItem(
      `branches:saved-view:branches:web:approved:u:${userId}`,
      JSON.stringify({
        sortKey: BranchSortKey.Name,
        sortDir: BranchSortDir.Asc,
        dateRange: "30d",
        hiddenColumns: ["tags"],
        columnOrder: ["status", "owner", "unknown", "repo"],
        columnWidths: {},
      })
    );
    const loaded = ({ children }: { children: ReactNode }) => (
      <AuthAdapterProvider adapter={createStaticAuthAdapter({ userId })}>
        {children}
      </AuthAdapterProvider>
    );

    const { result } = renderHook(
      () => useBranchViewState("branches:web", true),
      { wrapper: loaded }
    );

    await waitFor(() => expect(result.current.isViewReady).toBe(true));
    expect(result.current.columnOrder).toEqual(["status", "owner", "repo"]);

    act(() =>
      result.current.applyArrangement({
        sortKey: BranchSortKey.LastActivity,
        sortDir: BranchSortDir.Desc,
        dateRange: "90d",
        hiddenColumns: ["repo"],
        columnOrder: ["sessions", "missing", "status"],
        columnWidths: {},
        grouping: EMPTY_TABLE_GROUPING,
        collapsedGroups: {},
      })
    );

    expect(result.current.columnOrder).toEqual(["sessions", "status"]);
  });
});

/**
 * ISS-9447 M4. Branches had NO write-back coverage of any kind: the suite above
 * pins what the hook returns, and stops there. The lossy round trip that forced
 * the Sessions clamp (ISS-6065) is the same machinery under this surface, so
 * the same loss was reachable here and nothing was pinning it.
 *
 * Added by M0 asserting the ERASURE, and flipped here: unknown persisted column
 * ids are now preserved rather than erased (ISS-9447 D1); the previous
 * expectation encoded a data-loss path.
 */
describe("useBranchViewState - the persisted round trip (ISS-9447 M4)", () => {
  afterEach(() => localStorage.clear());

  it("keeps unrecognized ids IN STORAGE across a mount", async () => {
    const userId = "user_writeback";
    const storageKey = `branches:saved-view:branches:web:approved:u:${userId}`;
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        columnOrder: ["status", "future-column", "owner"],
        columnWidths: { "future-column": 240, status: 120 },
        dateRange: "30d",
        hiddenColumns: ["tags", "future-column"],
        sortDir: BranchSortDir.Asc,
        sortKey: BranchSortKey.Name,
      })
    );
    const loaded = ({ children }: { children: ReactNode }) => (
      <AuthAdapterProvider adapter={createStaticAuthAdapter({ userId })}>
        {children}
      </AuthAdapterProvider>
    );

    const { result } = renderHook(
      () => useBranchViewState("branches:web", true),
      { wrapper: loaded }
    );
    await waitFor(() => expect(result.current.isViewReady).toBe(true));

    const persisted = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    // All three axes carry the id this build cannot draw, so the arrangement
    // the reader made on another build survives opening the page here. Order is
    // appended (no slot can be held for an undrawn column); the other two are
    // keyed, so position does not arise.
    expect(persisted.columnOrder).toEqual(["status", "owner", "future-column"]);
    expect(persisted.hiddenColumns).toEqual(["tags", "future-column"]);
    expect(persisted.columnWidths).toEqual({
      "future-column": 240,
      status: 120,
    });
    // Carried is not applied: `columnOrder` renders this build's ids only. The
    // hidden axis takes no equivalent pin — `visibleColumns` and the hook's
    // `hiddenColumns` are both derived by filtering the DECLARED column list, so
    // a carried id cannot reach either however the merge behaves. The `tags`
    // assertion pins that the recognized hidden id is still applied; it says
    // nothing about `future-column`.
    expect(result.current.columnOrder).toEqual(["status", "owner"]);
    expect(result.current.visibleColumns.has("tags")).toBe(false);
  });

  /**
   * ISS-9447 M5. The id-shaped half above is not the whole loss: a whole KEY a
   * newer build persisted was deleted too, because the schema stripped it on
   * read and the fixed reserved set never re-emitted it. Both halves have to be
   * fixed or the fix is a no-op — preserving on parse without carrying into
   * `extras` still writes the key away on the next flush — so this asserts the
   * BYTES on disk after a round trip, not what the parse returned.
   */
  it("keeps an unrecognized KEY, and the version envelope, in storage", async () => {
    const userId = "user_carried_keys";
    const storageKey = `branches:saved-view:branches:web:approved:u:${userId}`;
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        columnOrder: ["status"],
        dateRange: "30d",
        futureDimension: { mode: "compact" },
        hiddenColumns: ["tags"],
        sortDir: BranchSortDir.Asc,
        sortKey: BranchSortKey.Name,
        viewStateVersions: { columnOrder: 3 },
      })
    );
    const loaded = ({ children }: { children: ReactNode }) => (
      <AuthAdapterProvider adapter={createStaticAuthAdapter({ userId })}>
        {children}
      </AuthAdapterProvider>
    );

    const { result } = renderHook(
      () => useBranchViewState("branches:web", true),
      { wrapper: loaded }
    );
    await waitFor(() => expect(result.current.isViewReady).toBe(true));
    // Force a flush that is unambiguously this build's own write.
    act(() => result.current.toggleColumn("repo"));

    await waitFor(() => {
      const persisted = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
      expect(persisted.hiddenColumns).toContain("repo");
      // The key this build has no name for survived being read and rewritten.
      expect(persisted.futureDimension).toEqual({ mode: "compact" });
      // So did the per-axis stamp. Branches stamps nothing itself, so a stamp on
      // disk can only have come from a newer build, and re-running that build's
      // one-time repair is exactly the harm ISS-6065 filed.
      expect(persisted.viewStateVersions).toEqual({ columnOrder: 3 });
      // And the reader's own dimensions are not collateral.
      expect(persisted.dateRange).toBe("30d");
      expect(persisted.sortKey).toBe(BranchSortKey.Name);
    });
  });

  it("applies a named view's widths and rows-per-page, carrying the rest", async () => {
    const userId = "user_apply_widths";
    const storageKey = `branches:saved-view:branches:web:approved:u:${userId}`;
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        columnWidths: { owner: 111 },
        futureDimension: { mode: "compact" },
        hiddenColumns: [],
        sortDir: BranchSortDir.Asc,
        sortKey: BranchSortKey.Name,
        viewStateVersions: { sort: 2 },
      })
    );
    const loaded = ({ children }: { children: ReactNode }) => (
      <AuthAdapterProvider adapter={createStaticAuthAdapter({ userId })}>
        {children}
      </AuthAdapterProvider>
    );

    const { result } = renderHook(
      () => useBranchViewState("branches:web", true),
      { wrapper: loaded }
    );
    await waitFor(() => expect(result.current.isViewReady).toBe(true));
    expect(result.current.columnWidths).toEqual({ owner: 111 });

    act(() =>
      result.current.applyArrangement({
        columnOrder: ["status"],
        columnWidths: { status: 240, "not-a-column": 300 },
        dateRange: "90d",
        grouping: EMPTY_TABLE_GROUPING,
        collapsedGroups: {},
        hiddenColumns: [],
        pageSize: 100,
        sortDir: BranchSortDir.Desc,
        sortKey: BranchSortKey.LastActivity,
      })
    );

    // The two dimensions a named Branches view could not carry before M5. The
    // width for a column this build does not draw is filtered exactly as a
    // restore filters it.
    expect(result.current.columnWidths).toEqual({ status: 240 });
    expect(result.current.pageSize).toBe(100);
    // And the apply is not an erasure: the envelope and the carried key are
    // restore-path bookkeeping, and a named arrangement says nothing about
    // either, so switching views must not delete them.
    await waitFor(() => {
      const persisted = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
      expect(persisted.columnWidths).toEqual({ status: 240 });
      expect(persisted.futureDimension).toEqual({ mode: "compact" });
      expect(persisted.viewStateVersions).toEqual({ sort: 2 });
      // ISS-9692's durability gate is CLOSED here (no feature-flag adapter), so
      // the size on disk stays the one this view was restored with while the
      // screen shows the applied 100. Deliberate, and the reason the apply takes
      // the same setter a reader's own choice takes: a gated-off reader cannot
      // materialize a durable rows-per-page through a view switch either.
      expect(persisted.pageSize).toBe(DEFAULT_TABLE_PAGE_SIZE);
    });
  });

  it("leaves rows-per-page alone for a view that captured none, and restores it for the default arrangement", () => {
    // ISS-9447 (review). A view saved before M5 states nothing about
    // rows-per-page, and the shared apply already guards on
    // `view.pageSize !== undefined` for exactly that — but this caller resolved
    // the absence to the surface default before `applyView` could see it, so the
    // guard was unreachable and opening an old view silently reset the reader to
    // 25. The DEFAULT arrangement is the one that genuinely has an opinion.
    const { result } = renderHook(() => useBranchViewState());
    act(() => result.current.setPageSize(100));
    expect(result.current.pageSize).toBe(100);

    act(() =>
      result.current.applyArrangement({
        columnOrder: [],
        columnWidths: {},
        dateRange: "90d",
        grouping: EMPTY_TABLE_GROUPING,
        collapsedGroups: {},
        hiddenColumns: [],
        sortDir: BranchSortDir.Asc,
        sortKey: BranchSortKey.Name,
      })
    );

    // The rest of the old view DID apply, so this is not a no-op that passes for
    // the wrong reason.
    expect(result.current.sortKey).toBe(BranchSortKey.Name);
    expect(result.current.pageSize).toBe(100);

    act(() => result.current.applyArrangement(DEFAULT_BRANCH_ARRANGEMENT));
    expect(result.current.pageSize).toBe(DEFAULT_TABLE_PAGE_SIZE);
  });
});
