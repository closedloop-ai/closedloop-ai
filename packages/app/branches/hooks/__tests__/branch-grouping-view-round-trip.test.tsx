import {
  EMPTY_TABLE_GROUPING,
  type TableGroupingState,
  TableGroupOrder,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { AuthAdapterProvider } from "../../../shared/auth/provider";
import { createStaticAuthAdapter } from "../../../shared/auth/static-auth-adapter";
import { DEFAULT_BRANCH_FILTERS } from "../../lib/branch-row";
import {
  type BranchViewArrangement,
  branchArrangementsEqual,
  DEFAULT_BRANCH_ARRANGEMENT,
} from "../../lib/branch-saved-views";
import { BranchSortDir, BranchSortKey } from "../../lib/branch-sort-group";
import {
  useBranchSavedViews,
  useBranchSavedViewsStore,
} from "../use-branch-saved-views";
import { useBranchViewState } from "../use-branch-view-state";

/**
 * ISS-9676 (davetho review) — the grouping axis round-trips through a
 * Branches view.
 *
 * The control shipped holding its state inside the list surface, so a reader
 * could group by Author, save or re-select a view, and get the table back
 * ungrouped under a switcher naming the view they were on. These drive the two
 * stores that own an axis — the live persisted view and the named saved views —
 * and assert grouping survives each, plus the version-skew read for a view
 * written before the axis existed.
 */

const PERSIST_KEY = "grouping-round-trip";
const SAVED_VIEWS_STORAGE_KEY =
  "branches:saved-views:org_test:user_test:grouping-round-trip:approved";
const GROUPED_BY_AUTHOR: TableGroupingState = {
  primary: {
    fieldId: "owner",
    order: TableGroupOrder.Ascending,
    showEmptyGroups: false,
  },
  secondary: EMPTY_TABLE_GROUPING.secondary,
};

afterEach(() => {
  localStorage.clear();
});

function wrapper({ children }: { children: ReactNode }) {
  return (
    <AuthAdapterProvider
      adapter={createStaticAuthAdapter({
        orgId: "org_test",
        userId: "user_test",
      })}
    >
      {children}
    </AuthAdapterProvider>
  );
}

describe("the live persisted Branches view", () => {
  it("restores the grouping the reader left the list on", async () => {
    const first = renderHook(() => useBranchViewState(PERSIST_KEY, true), {
      wrapper,
    });
    await waitFor(() => expect(first.result.current.isViewReady).toBe(true));

    act(() => first.result.current.setGrouping(GROUPED_BY_AUTHOR));
    first.unmount();

    // A fresh mount against the same key — the reload, not a re-render.
    const second = renderHook(() => useBranchViewState(PERSIST_KEY, true), {
      wrapper,
    });

    await waitFor(() =>
      expect(second.result.current.grouping).toEqual(GROUPED_BY_AUTHOR)
    );
  });

  it("restores ungrouped from a view stored before the axis existed", async () => {
    localStorage.setItem(
      `branches:saved-view:${PERSIST_KEY}:approved`,
      JSON.stringify({
        columnOrder: [],
        columnWidths: {},
        dateRange: "30d",
        hiddenColumns: [],
        sortDir: BranchSortDir.Desc,
        sortKey: BranchSortKey.LastActivity,
      })
    );

    const { result } = renderHook(() => useBranchViewState(PERSIST_KEY, true), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isViewReady).toBe(true));
    // The rest of the pre-ISS-9676 view still restores: the missing axis must
    // not fail the parse and take the reader's window with it.
    expect(result.current.dateRange).toBe("30d");
    expect(result.current.grouping).toEqual(EMPTY_TABLE_GROUPING);
  });
});

describe("a named Branches saved view", () => {
  const snapshot = {
    collapsedGroups: {},
    columnOrder: [],
    columnWidths: {},
    pageSize: 25,
    dateRange: "30d" as const,
    filters: { ...DEFAULT_BRANCH_FILTERS },
    grouping: GROUPED_BY_AUTHOR,
    hiddenColumns: [],
    sortDir: BranchSortDir.Desc,
    sortKey: BranchSortKey.LastActivity,
  };

  it("captures the grouping and applies it back on re-selection", () => {
    const applied: BranchViewArrangement[] = [];
    const { result } = renderHook(
      () =>
        useBranchSavedViews(
          useBranchSavedViewsStore(PERSIST_KEY, true),
          snapshot,
          {
            applyArrangement: (arrangement) =>
              applied.push(arrangement as BranchViewArrangement),
            applyFilters: () => undefined,
          }
        ),
      { wrapper }
    );

    act(() => result.current.onCreateView("Grouped"));
    const id = result.current.views[0].id;
    // Away to the default and back, which is the path that used to drop it.
    act(() => result.current.onSelectView(null));
    act(() => result.current.onSelectView(id));

    const stored = JSON.parse(
      localStorage.getItem(SAVED_VIEWS_STORAGE_KEY) ?? "{}"
    );
    expect(stored.views[0].arrangement.grouping).toEqual(GROUPED_BY_AUTHOR);
    expect(applied.at(-1)?.grouping).toEqual(GROUPED_BY_AUTHOR);
    // "Default view" is ungrouped, so the middle application proves the two
    // states are actually distinguishable through this path.
    expect(applied.at(-2)?.grouping).toEqual(EMPTY_TABLE_GROUPING);
  });

  // The collection schema is `.loose()`, so a KNOWN grouping key round-trips
  // through the passthrough whether or not the schema names it. What the named
  // entry buys is the two shapes the passthrough cannot answer: a view stored
  // before the axis existed, whose `grouping` is absent, and one whose stored
  // level is malformed. Both would otherwise reach `tableGroupingsEqual` and the
  // grid as `undefined`/garbage and throw on the reader's next render.
  it.each([
    ["a view stored before the axis existed", {}],
    ["a malformed stored grouping", { grouping: { primary: "author" } }],
  ])("applies an empty grouping for %s", (_case, storedGrouping) => {
    localStorage.setItem(
      SAVED_VIEWS_STORAGE_KEY,
      JSON.stringify({
        activeViewId: "v1",
        views: [
          {
            arrangement: {
              columnOrder: [],
              dateRange: "30d",
              filters: { ...DEFAULT_BRANCH_FILTERS },
              hiddenColumns: [],
              sortDir: BranchSortDir.Desc,
              sortKey: BranchSortKey.LastActivity,
              ...storedGrouping,
            },
            id: "v1",
            name: "Legacy",
          },
        ],
      })
    );
    const applied: BranchViewArrangement[] = [];
    const { result } = renderHook(
      () =>
        useBranchSavedViews(
          useBranchSavedViewsStore(PERSIST_KEY, true),
          snapshot,
          {
            applyArrangement: (arrangement) =>
              applied.push(arrangement as BranchViewArrangement),
            applyFilters: () => undefined,
          }
        ),
      { wrapper }
    );

    // ISS-10209 removed the Views control, so a restored active view is no
    // longer reapplied on mount. An explicit re-selection is the remaining path
    // that applies an arrangement, and it runs the same normalization this case
    // exists to pin.
    expect(result.current.views).toHaveLength(1);
    act(() => result.current.onSelectView(null));
    act(() => result.current.onSelectView("v1"));
    expect(applied.at(-1)?.grouping).toEqual(EMPTY_TABLE_GROUPING);
    // And the divergence check runs over it without throwing, which is what a
    // passed-through `undefined` would do on the reader's next render.
    expect(result.current.modified).toBe(true);
  });

  it("marks the view modified once the live grouping diverges from it", () => {
    const saved: BranchViewArrangement = {
      ...DEFAULT_BRANCH_ARRANGEMENT,
      grouping: GROUPED_BY_AUTHOR,
    };

    expect(branchArrangementsEqual(saved, { ...saved })).toBe(true);
    expect(
      branchArrangementsEqual(saved, {
        ...saved,
        grouping: EMPTY_TABLE_GROUPING,
      })
    ).toBe(false);
  });
});
