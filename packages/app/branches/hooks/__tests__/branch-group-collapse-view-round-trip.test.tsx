import {
  EMPTY_TABLE_COLLAPSED_GROUPS,
  type TableCollapsedGroups,
} from "@repo/app/shared/lib/table-collapsed-groups";
import { TableGroupOrder } from "@repo/design-system/components/ui/table-toolbar-model";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { AuthAdapterProvider } from "../../../shared/auth/provider";
import { createStaticAuthAdapter } from "../../../shared/auth/static-auth-adapter";
import {
  branchGrouping,
  GROUPED_BY_OWNER,
  requiredAxisKey,
} from "../../lib/__tests__/support/branch-grouping-fixtures";
import { DEFAULT_BRANCH_FILTERS } from "../../lib/branch-row";
import type { BranchViewArrangement } from "../../lib/branch-saved-views";
import { BranchSortDir, BranchSortKey } from "../../lib/branch-sort-group";
import {
  type BranchViewSnapshot,
  useBranchSavedViews,
  useBranchSavedViewsStore,
} from "../use-branch-saved-views";
import { useBranchViewState } from "../use-branch-view-state";

/**
 * ISS-9582 — which grouping bands a reader collapsed round-trips through a
 * Branches view, beside the grouping axis it belongs to (ISS-9676).
 *
 * Drives the two stores that own a view — the live persisted view and the named
 * saved views — and asserts the collapse record survives each, including the
 * version-skew reads: a view written before the field existed, a view carrying
 * a key only a newer build names, and a corrupt record.
 */

const PERSIST_KEY = "group-collapse-round-trip";
const TEST_USER_ID = "user_test";
const LIVE_VIEW_STORAGE_KEY = `branches:saved-view:${PERSIST_KEY}:approved:u:${TEST_USER_ID}`;
const SAVED_VIEWS_STORAGE_KEY = `branches:saved-views:org_test:${TEST_USER_ID}:${PERSIST_KEY}:approved`;

const GROUPED_BY_REPO = branchGrouping("repo", TableGroupOrder.Descending);
const OWNER_AXIS = requiredAxisKey(GROUPED_BY_OWNER);
const REPO_AXIS = requiredAxisKey(GROUPED_BY_REPO);
const COLLAPSED: TableCollapsedGroups = {
  [OWNER_AXIS]: ["Alex", "Sam"],
  [REPO_AXIS]: ["acme/web"],
};

afterEach(() => {
  localStorage.clear();
});

function wrapper({ children }: { children: ReactNode }) {
  return (
    <AuthAdapterProvider
      adapter={createStaticAuthAdapter({
        orgId: "org_test",
        userId: TEST_USER_ID,
      })}
    >
      {children}
    </AuthAdapterProvider>
  );
}

describe("the live persisted Branches view", () => {
  it("restores the collapsed bands the reader left the list on", async () => {
    const first = renderHook(() => useBranchViewState(PERSIST_KEY, true), {
      wrapper,
    });
    await waitFor(() => expect(first.result.current.isViewReady).toBe(true));

    act(() => first.result.current.setGrouping(GROUPED_BY_OWNER));
    act(() => first.result.current.setCollapsedGroups(COLLAPSED));
    first.unmount();

    // A fresh mount against the same key — the reload, not a re-render.
    const second = renderHook(() => useBranchViewState(PERSIST_KEY, true), {
      wrapper,
    });

    await waitFor(() =>
      expect(second.result.current.collapsedGroups).toEqual(COLLAPSED)
    );
    expect(second.result.current.grouping).toEqual(GROUPED_BY_OWNER);
  });

  it("restores every band open from a view stored before the field existed", async () => {
    localStorage.setItem(
      LIVE_VIEW_STORAGE_KEY,
      JSON.stringify({
        columnOrder: [],
        columnWidths: {},
        dateRange: "30d",
        grouping: GROUPED_BY_OWNER,
        hiddenColumns: [],
        sortDir: BranchSortDir.Asc,
        sortKey: BranchSortKey.Name,
      })
    );

    const { result } = renderHook(() => useBranchViewState(PERSIST_KEY, true), {
      wrapper,
    });

    // The other axes restoring is what proves the stored view was READ; a
    // collapse record of `{}` alone would also be the untouched default.
    await waitFor(() =>
      expect(result.current.grouping).toEqual(GROUPED_BY_OWNER)
    );
    expect(result.current.dateRange).toBe("30d");
    expect(result.current.sortKey).toBe(BranchSortKey.Name);
    expect(result.current.collapsedGroups).toEqual(
      EMPTY_TABLE_COLLAPSED_GROUPS
    );
  });

  it("keeps a key only a newer build wrote when the reader collapses a band", async () => {
    localStorage.setItem(
      LIVE_VIEW_STORAGE_KEY,
      JSON.stringify({
        bandDensity: { mode: "compact" },
        collapsedGroups: { [OWNER_AXIS]: ["Alex"] },
        columnOrder: [],
        columnWidths: {},
        dateRange: "30d",
        grouping: GROUPED_BY_OWNER,
        hiddenColumns: [],
        sortDir: BranchSortDir.Asc,
        sortKey: BranchSortKey.Name,
      })
    );
    const { result } = renderHook(() => useBranchViewState(PERSIST_KEY, true), {
      wrapper,
    });
    await waitFor(() =>
      expect(result.current.collapsedGroups).toEqual({
        [OWNER_AXIS]: ["Alex"],
      })
    );

    act(() => result.current.setCollapsedGroups(COLLAPSED));

    // The bytes on disk after this build's own write, not what the parse
    // returned: a key dropped from `extras` is deleted on exactly this flush.
    await waitFor(() => {
      const persisted = JSON.parse(
        localStorage.getItem(LIVE_VIEW_STORAGE_KEY) ?? "{}"
      );
      expect(persisted.collapsedGroups).toEqual(COLLAPSED);
      expect(persisted.bandDensity).toEqual({ mode: "compact" });
      expect(persisted.grouping).toEqual(GROUPED_BY_OWNER);
    });
  });

  it.each([
    ["a string", "Alex"],
    ["an array", ["Alex"]],
    [
      "axes with no usable keys",
      { [OWNER_AXIS]: [1, null], noSeparator: ["Alex"] },
    ],
  ])(
    "degrades %s of collapsed groups to nothing collapsed, keeping the grouping",
    async (_case, storedCollapsedGroups) => {
      localStorage.setItem(
        LIVE_VIEW_STORAGE_KEY,
        JSON.stringify({
          collapsedGroups: storedCollapsedGroups,
          columnOrder: [],
          columnWidths: {},
          dateRange: "30d",
          grouping: GROUPED_BY_OWNER,
          hiddenColumns: [],
          sortDir: BranchSortDir.Asc,
          sortKey: BranchSortKey.Name,
        })
      );

      const { result } = renderHook(
        () => useBranchViewState(PERSIST_KEY, true),
        {
          wrapper,
        }
      );

      await waitFor(() =>
        expect(result.current.grouping).toEqual(GROUPED_BY_OWNER)
      );
      expect(result.current.dateRange).toBe("30d");
      expect(result.current.collapsedGroups).toEqual(
        EMPTY_TABLE_COLLAPSED_GROUPS
      );
    }
  );
});

describe("a named Branches saved view", () => {
  const snapshot: BranchViewSnapshot = {
    collapsedGroups: COLLAPSED,
    columnOrder: [],
    columnWidths: {},
    dateRange: "30d",
    filters: { ...DEFAULT_BRANCH_FILTERS },
    grouping: GROUPED_BY_OWNER,
    hiddenColumns: [],
    pageSize: 25,
    sortDir: BranchSortDir.Desc,
    sortKey: BranchSortKey.LastActivity,
  };

  it("captures the collapsed bands and applies them back on re-selection", () => {
    const applied: BranchViewArrangement[] = [];
    const { result } = renderHook(
      () =>
        useBranchSavedViews(
          useBranchSavedViewsStore(PERSIST_KEY, true),
          snapshot,
          {
            applyArrangement: (arrangement) =>
              applied.push({
                ...arrangement,
                filters: { ...DEFAULT_BRANCH_FILTERS },
              }),
            applyFilters: () => undefined,
          }
        ),
      { wrapper }
    );

    act(() => result.current.onCreateView("Collapsed"));
    const id = result.current.views[0].id;
    act(() => result.current.onSelectView(null));
    act(() => result.current.onSelectView(id));

    const stored = JSON.parse(
      localStorage.getItem(SAVED_VIEWS_STORAGE_KEY) ?? "{}"
    );
    expect(stored.views[0].arrangement.collapsedGroups).toEqual(COLLAPSED);
    expect(applied.at(-1)?.collapsedGroups).toEqual(COLLAPSED);
    // "Default view" opens every band, so the middle application proves the two
    // states are distinguishable through this path.
    expect(applied.at(-2)?.collapsedGroups).toEqual(
      EMPTY_TABLE_COLLAPSED_GROUPS
    );
  });

  it("marks the active view modified when only a band's collapse changes", () => {
    const { result, rerender } = renderHook(
      ({ live }: { live: BranchViewSnapshot }) =>
        useBranchSavedViews(useBranchSavedViewsStore(PERSIST_KEY, true), live, {
          applyArrangement: () => undefined,
          applyFilters: () => undefined,
        }),
      { initialProps: { live: snapshot }, wrapper }
    );

    act(() => result.current.onCreateView("Collapsed"));
    expect(result.current.activeViewId).toBe(result.current.views[0].id);
    expect(result.current.modified).toBe(false);

    rerender({
      live: {
        ...snapshot,
        collapsedGroups: { ...COLLAPSED, [OWNER_AXIS]: ["Alex"] },
      },
    });

    expect(result.current.modified).toBe(true);
  });
});
