import { BranchSessionPresence } from "@repo/api/src/types/branch";
import { DEFAULT_TABLE_PAGE_SIZE } from "@repo/design-system/components/ui/table-page-size-select";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthAdapterProvider } from "../../../shared/auth/provider";
import { createStaticAuthAdapter } from "../../../shared/auth/static-auth-adapter";
import type { BranchFilters } from "../../lib/branch-row";
import { DEFAULT_BRANCH_FILTERS } from "../../lib/branch-row";
import { DEFAULT_BRANCH_ARRANGEMENT } from "../../lib/branch-saved-views";
import { BranchSortDir, BranchSortKey } from "../../lib/branch-sort-group";
import {
  type BranchViewApply,
  type BranchViewSnapshot,
  scopeSavedViewsKey,
  useBranchSavedViews,
  useBranchSavedViewsStore,
} from "../use-branch-saved-views";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

const PERSIST_KEY = "test";
// Default test identity (org_test / user_test) scopes the storage key so views
// can never bleed across accounts/orgs sharing the same browser.
const STORAGE_KEY = "branches:saved-views:org_test:user_test:test";
const APPROVED_STORAGE_KEY =
  "branches:saved-views:org_test:user_test:test:approved";

function wrapper(userId = "user_test", orgId: string | null = "org_test") {
  const adapter = createStaticAuthAdapter({ userId, orgId });
  return ({ children }: { children: ReactNode }) => (
    <AuthAdapterProvider adapter={adapter}>{children}</AuthAdapterProvider>
  );
}

const FILTERS: BranchFilters = {
  ...DEFAULT_BRANCH_FILTERS,
  statuses: ["open"],
  owners: ["alice"],
  repos: [],
  sessionPresence: [BranchSessionPresence.Has],
};

const SNAPSHOT: BranchViewSnapshot = {
  sortKey: BranchSortKey.Name,
  sortDir: BranchSortDir.Asc,
  dateRange: "30d",
  hiddenColumns: ["repo"],
  columnOrder: ["status", "owner"],
  columnWidths: { status: 180 },
  pageSize: 100,
  filters: FILTERS,
  grouping: EMPTY_TABLE_GROUPING,
  collapsedGroups: {},
};

function makeApply() {
  const applyArrangement = vi.fn<BranchViewApply["applyArrangement"]>();
  const applyFilters = vi.fn<BranchViewApply["applyFilters"]>();
  return { applyArrangement, applyFilters } satisfies BranchViewApply;
}

describe("useBranchSavedViews", () => {
  it("create captures the current snapshot (order + visibility + sort + filters) and persists it", () => {
    const apply = makeApply();
    const { result } = renderHook(
      () =>
        useBranchSavedViews(
          useBranchSavedViewsStore(PERSIST_KEY),
          SNAPSHOT,
          apply
        ),
      { wrapper: wrapper() }
    );

    act(() => result.current.onCreateView("Mine"));

    expect(result.current.views).toHaveLength(1);
    expect(result.current.views[0].name).toBe("Mine");
    expect(result.current.activeViewId).toBe(result.current.views[0].id);

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    const arr = stored.views[0].arrangement;
    expect(arr.sortKey).toBe(BranchSortKey.Name);
    expect(arr.hiddenColumns).toEqual(["repo"]);
    expect(arr.columnOrder).toEqual(["status", "owner"]);
    expect(arr.filters.statuses).toEqual(["open"]);
    expect(arr.filters.sessionPresence).toEqual([BranchSessionPresence.Has]);
    // ISS-9447 M5: the two dimensions the single live view persisted and this
    // store silently dropped. Captured on the production path — the snapshot the
    // page hands in, through `createView`, to the bytes on disk.
    expect(arr.columnWidths).toEqual({ status: 180 });
    expect(arr.pageSize).toBe(100);
  });

  it("switching a saved view applies order + visibility + sort AND filters together", () => {
    const apply = makeApply();
    const { result } = renderHook(
      () =>
        useBranchSavedViews(
          useBranchSavedViewsStore(PERSIST_KEY),
          SNAPSHOT,
          apply
        ),
      { wrapper: wrapper() }
    );

    act(() => result.current.onCreateView("Mine"));
    const id = result.current.views[0].id;

    // Switch away to the default, then back to the saved view.
    act(() => result.current.onSelectView(null));
    apply.applyArrangement.mockClear();
    apply.applyFilters.mockClear();

    act(() => result.current.onSelectView(id));

    expect(apply.applyArrangement).toHaveBeenCalledTimes(1);
    expect(apply.applyArrangement).toHaveBeenCalledWith(
      expect.objectContaining({
        sortKey: BranchSortKey.Name,
        sortDir: BranchSortDir.Asc,
        dateRange: "30d",
        hiddenColumns: ["repo"],
        columnOrder: ["status", "owner"],
        // ISS-9447 M5: and back out again. Capturing without applying would be
        // the same loss with the data sitting on disk to prove it.
        columnWidths: { status: 180 },
        pageSize: 100,
      })
    );
    expect(apply.applyFilters).toHaveBeenCalledTimes(1);
    // ISS-9447 M5: the rows-per-page rides the FILTERS call, not a second one.
    // Both land in the surface's URL, and two writes would each start from the
    // pre-switch params — so a size sent separately would be written and then
    // overwritten, and a reload would revert the switch.
    expect(apply.applyFilters).toHaveBeenCalledWith(
      expect.objectContaining({
        statuses: ["open"],
        sessionPresence: [BranchSessionPresence.Has],
      }),
      SNAPSHOT.pageSize
    );
    expect(result.current.activeViewId).toBe(id);
  });

  it("switching to the default (null) clears the active marker AND restores the default arrangement + filters", () => {
    const apply = makeApply();
    const { result } = renderHook(
      () =>
        useBranchSavedViews(
          useBranchSavedViewsStore(PERSIST_KEY),
          SNAPSHOT,
          apply
        ),
      { wrapper: wrapper() }
    );
    act(() => result.current.onCreateView("Mine"));
    apply.applyArrangement.mockClear();
    apply.applyFilters.mockClear();

    act(() => result.current.onSelectView(null));

    expect(result.current.activeViewId).toBeNull();
    // "Default view" must actually put the table back on the defaults, not just
    // move the dot — otherwise the trigger claims "Default view" over a layout
    // that is still the saved one.
    expect(apply.applyArrangement).toHaveBeenCalledTimes(1);
    expect(apply.applyArrangement).toHaveBeenCalledWith(
      expect.objectContaining({
        sortKey: DEFAULT_BRANCH_ARRANGEMENT.sortKey,
        sortDir: DEFAULT_BRANCH_ARRANGEMENT.sortDir,
        dateRange: DEFAULT_BRANCH_ARRANGEMENT.dateRange,
        hiddenColumns: [],
        columnOrder: [],
      })
    );
    expect(apply.applyFilters).toHaveBeenCalledTimes(1);
    // "Default view" restores the shipped rows-per-page along with the rest.
    expect(apply.applyFilters).toHaveBeenCalledWith(
      expect.objectContaining({ statuses: [], owners: [], repos: [] }),
      DEFAULT_TABLE_PAGE_SIZE
    );
  });

  it("does not reapply on mount when no view is active (default arrangement)", () => {
    const seeded = {
      views: [
        {
          id: "saved-1",
          name: "Saved",
          arrangement: {
            sortKey: BranchSortKey.Name,
            sortDir: BranchSortDir.Asc,
            dateRange: "90d",
            hiddenColumns: [],
            columnOrder: [],
            filters: { ...DEFAULT_BRANCH_FILTERS },
          },
        },
      ],
      // No active view — the surface is on the default arrangement.
      activeViewId: null,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));

    const apply = makeApply();
    const { result } = renderHook(
      () =>
        useBranchSavedViews(
          useBranchSavedViewsStore(PERSIST_KEY),
          SNAPSHOT,
          apply
        ),
      { wrapper: wrapper() }
    );

    // No active view means nothing to reapply — the live table is left alone.
    expect(result.current.activeViewId).toBeNull();
    expect(apply.applyArrangement).not.toHaveBeenCalled();
    expect(apply.applyFilters).not.toHaveBeenCalled();
  });

  it("deleting the ACTIVE view falls back to the default arrangement (not stranded on the deleted layout)", () => {
    const apply = makeApply();
    const { result } = renderHook(
      () =>
        useBranchSavedViews(
          useBranchSavedViewsStore(PERSIST_KEY),
          SNAPSHOT,
          apply
        ),
      { wrapper: wrapper() }
    );
    act(() => result.current.onCreateView("Mine"));
    const id = result.current.views[0].id;
    apply.applyArrangement.mockClear();
    apply.applyFilters.mockClear();

    act(() => result.current.onDeleteView(id));

    expect(result.current.views).toHaveLength(0);
    expect(result.current.activeViewId).toBeNull();
    expect(apply.applyArrangement).toHaveBeenCalledWith(
      expect.objectContaining({ hiddenColumns: [], columnOrder: [] })
    );
    expect(apply.applyFilters).toHaveBeenCalledWith(
      expect.objectContaining({ statuses: [], owners: [] }),
      DEFAULT_TABLE_PAGE_SIZE
    );
  });

  it("deleting a NON-active view does not disturb the live arrangement", () => {
    const apply = makeApply();
    const { result } = renderHook(
      () =>
        useBranchSavedViews(
          useBranchSavedViewsStore(PERSIST_KEY),
          SNAPSHOT,
          apply
        ),
      { wrapper: wrapper() }
    );
    act(() => result.current.onCreateView("First"));
    act(() => result.current.onCreateView("Second"));
    // "Second" is active; delete the non-active "First".
    const firstId = result.current.views.find((v) => v.name === "First")?.id;
    const secondId = result.current.views.find((v) => v.name === "Second")?.id;
    apply.applyArrangement.mockClear();
    apply.applyFilters.mockClear();

    act(() => result.current.onDeleteView(firstId ?? ""));

    expect(result.current.activeViewId).toBe(secondId);
    expect(apply.applyArrangement).not.toHaveBeenCalled();
    expect(apply.applyFilters).not.toHaveBeenCalled();
  });

  it("rename persists the new name", () => {
    const apply = makeApply();
    const { result } = renderHook(
      () =>
        useBranchSavedViews(
          useBranchSavedViewsStore(PERSIST_KEY),
          SNAPSHOT,
          apply
        ),
      { wrapper: wrapper() }
    );
    act(() => result.current.onCreateView("Mine"));
    const id = result.current.views[0].id;
    act(() => result.current.onRenameView(id, "Renamed"));

    expect(result.current.views[0].name).toBe("Renamed");
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(stored.views[0].name).toBe("Renamed");
  });

  it("delete removes the view and persists the removal", () => {
    const apply = makeApply();
    const { result } = renderHook(
      () =>
        useBranchSavedViews(
          useBranchSavedViewsStore(PERSIST_KEY),
          SNAPSHOT,
          apply
        ),
      { wrapper: wrapper() }
    );
    act(() => result.current.onCreateView("Mine"));
    const id = result.current.views[0].id;
    act(() => result.current.onDeleteView(id));

    expect(result.current.views).toHaveLength(0);
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(stored.views).toHaveLength(0);
    expect(stored.activeViewId).toBeNull();
  });

  it("restores persisted views on mount (round-trip)", () => {
    // First mount: create + persist.
    const first = renderHook(
      () =>
        useBranchSavedViews(
          useBranchSavedViewsStore(PERSIST_KEY),
          SNAPSHOT,
          makeApply()
        ),
      { wrapper: wrapper() }
    );
    act(() => first.result.current.onCreateView("Mine"));
    first.unmount();

    // Second mount: the collection is restored from localStorage.
    const apply = makeApply();
    const second = renderHook(
      () =>
        useBranchSavedViews(
          useBranchSavedViewsStore(PERSIST_KEY),
          SNAPSHOT,
          apply
        ),
      { wrapper: wrapper() }
    );
    expect(second.result.current.views).toHaveLength(1);
    expect(second.result.current.views[0].name).toBe("Mine");

    // And switching the restored view still applies the full arrangement.
    const id = second.result.current.views[0].id;
    act(() => second.result.current.onSelectView(id));
    expect(apply.applyArrangement).toHaveBeenCalledWith(
      expect.objectContaining({ columnOrder: ["status", "owner"] })
    );
    expect(apply.applyFilters).toHaveBeenCalledWith(
      expect.objectContaining({ statuses: ["open"] }),
      SNAPSHOT.pageSize
    );
  });

  it("a snapshot with no facet active round-trips the default filters", () => {
    const apply = makeApply();
    const { result } = renderHook(
      () =>
        useBranchSavedViews(
          useBranchSavedViewsStore(PERSIST_KEY),
          { ...SNAPSHOT, filters: DEFAULT_BRANCH_FILTERS },
          apply
        ),
      { wrapper: wrapper() }
    );
    act(() => result.current.onCreateView("Plain"));
    const id = result.current.views[0].id;
    act(() => result.current.onSelectView(id));
    expect(apply.applyFilters).toHaveBeenLastCalledWith(
      expect.objectContaining({ statuses: [], owners: [], repos: [] }),
      SNAPSHOT.pageSize
    );
  });

  it("approved saved views preserve order while clearing Branches-specific session presence filters", () => {
    const apply = makeApply();
    const { result } = renderHook(
      () =>
        useBranchSavedViews(
          useBranchSavedViewsStore(PERSIST_KEY, true),
          SNAPSHOT,
          apply
        ),
      { wrapper: wrapper() }
    );

    act(() => result.current.onCreateView("Approved order"));

    const stored = JSON.parse(
      localStorage.getItem(APPROVED_STORAGE_KEY) ?? "{}"
    );
    const arrangement = stored.views[0].arrangement;
    expect(arrangement.columnOrder).toEqual(["status", "owner"]);
    expect(arrangement.filters.sessionPresence).toEqual([]);

    const id = result.current.views[0].id;
    act(() => result.current.onSelectView(id));
    expect(apply.applyArrangement).toHaveBeenCalledWith(
      expect.objectContaining({ columnOrder: ["status", "owner"] })
    );
    expect(apply.applyFilters).toHaveBeenCalledWith(
      expect.objectContaining({ sessionPresence: [] }),
      SNAPSHOT.pageSize
    );
  });

  it("scopes persistence by org + user so a second account cannot read the first's views", () => {
    // Account A (org_a / user_a) creates a named view.
    const a = renderHook(
      () =>
        useBranchSavedViews(
          useBranchSavedViewsStore(PERSIST_KEY),
          SNAPSHOT,
          makeApply()
        ),
      { wrapper: wrapper("user_a", "org_a") }
    );
    act(() => a.result.current.onCreateView("Alice's view"));
    a.unmount();

    // Account B (org_b / user_b) on the SAME browser sees an empty switcher —
    // localStorage was not cleared on sign-out, but the key is identity-scoped.
    const b = renderHook(
      () =>
        useBranchSavedViews(
          useBranchSavedViewsStore(PERSIST_KEY),
          SNAPSHOT,
          makeApply()
        ),
      { wrapper: wrapper("user_b", "org_b") }
    );
    expect(b.result.current.views).toHaveLength(0);

    // A's collection persists under A's scoped key, untouched by B.
    const storedA = JSON.parse(
      localStorage.getItem("branches:saved-views:org_a:user_a:test") ?? "{}"
    );
    expect(storedA.views[0].name).toBe("Alice's view");
    // Isolation the other way: A's key still holds only A's view, so B — which
    // restored empty and never mutated — cannot have leaked into or clobbered
    // A's scope. (The store no longer flushes an unchanged empty collection, so
    // B's key may legitimately stay unwritten; isolation is proven by A being
    // intact and B seeing an empty switcher above, not by an empty B write.)
    expect(storedA.views).toHaveLength(1);
  });

  it("does not re-apply the arrangement for a remote change that leaves the active arrangement unchanged (a rename), even over local unsaved edits", () => {
    const apply = makeApply();
    const { result, rerender } = renderHook(
      ({ snapshot }: { snapshot: BranchViewSnapshot }) =>
        useBranchSavedViews(
          useBranchSavedViewsStore(PERSIST_KEY),
          snapshot,
          apply
        ),
      { initialProps: { snapshot: SNAPSHOT }, wrapper: wrapper() }
    );
    act(() => result.current.onCreateView("Mine"));
    const id = result.current.views[0].id;
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    const renamed = {
      views: [{ ...stored.views[0], name: "Renamed Remotely" }],
      activeViewId: id,
    };

    // The reader has since edited the table (the live snapshot no longer
    // matches the active view). A rename elsewhere must not push the saved
    // arrangement back over those edits.
    act(() =>
      rerender({ snapshot: { ...SNAPSHOT, sortKey: BranchSortKey.Owner } })
    );
    expect(result.current.modified).toBe(true);

    apply.applyArrangement.mockClear();
    apply.applyFilters.mockClear();

    act(() => {
      globalThis.dispatchEvent(
        new StorageEvent("storage", {
          key: STORAGE_KEY,
          newValue: JSON.stringify(renamed),
        })
      );
    });

    expect(apply.applyArrangement).not.toHaveBeenCalled();
    expect(result.current.views[0].name).toBe("Renamed Remotely");
  });

  it("applies nothing on an adoption when there was no active view before or after", () => {
    const apply = makeApply();
    const { result } = renderHook(
      () =>
        useBranchSavedViews(
          useBranchSavedViewsStore(PERSIST_KEY),
          SNAPSHOT,
          apply
        ),
      { wrapper: wrapper() }
    );
    act(() => result.current.onCreateView("Mine"));
    act(() => result.current.onSelectView(null));

    apply.applyArrangement.mockClear();
    apply.applyFilters.mockClear();

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    const stillNoActive = { views: stored.views, activeViewId: null };
    act(() => {
      globalThis.dispatchEvent(
        new StorageEvent("storage", {
          key: STORAGE_KEY,
          newValue: JSON.stringify(stillNoActive),
        })
      );
    });

    expect(apply.applyArrangement).not.toHaveBeenCalled();
    expect(apply.applyFilters).not.toHaveBeenCalled();
  });

  it("folds the live arrangement into an existing view without deleting a key this build does not know", () => {
    // ISS-9447 (review). The parser is `.loose()` so a key only a NEWER build
    // names round-trips untouched — but `updateSavedView` REPLACES the
    // arrangement (its documented contract), and this caller handed it a
    // freshly-normalized snapshot built from this build's owned axes alone. The
    // preserve guarantee therefore held for read→write of the collection and
    // died on the reader's first "Update <name>".
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        activeViewId: "saved-1",
        views: [
          {
            arrangement: {
              columnOrder: [],
              columnWidths: {},
              dateRange: "30d",
              filters: { ...DEFAULT_BRANCH_FILTERS },
              futureAxis: { mode: "compact" },
              grouping: EMPTY_TABLE_GROUPING,
              hiddenColumns: [],
              sortDir: BranchSortDir.Desc,
              sortKey: BranchSortKey.LastActivity,
            },
            id: "saved-1",
            name: "Mine",
          },
        ],
      })
    );
    const apply = makeApply();
    const { result } = renderHook(
      () =>
        useBranchSavedViews(
          useBranchSavedViewsStore(PERSIST_KEY),
          SNAPSHOT,
          apply
        ),
      { wrapper: wrapper() }
    );

    act(() => result.current.onUpdateView("saved-1"));

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    const arrangement = stored.views[0].arrangement;
    expect(arrangement.futureAxis).toEqual({ mode: "compact" });
    // And the update is a real update: the owned axes are the LIVE ones, so this
    // cannot pass by having written nothing.
    expect(arrangement.sortKey).toBe(SNAPSHOT.sortKey);
    expect(arrangement.hiddenColumns).toEqual(SNAPSHOT.hiddenColumns);
    expect(arrangement.pageSize).toBe(SNAPSHOT.pageSize);
  });

  it("states no rows-per-page when the applied view captured none", () => {
    // ISS-9447 (review). A view saved before M5 says nothing about
    // rows-per-page, and the two apply paths have to agree about that: resolving
    // the absence to the surface default here overwrote whatever the reader's
    // `?pageSize=` link or footer had stated with a 25 the view never captured.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        activeViewId: null,
        views: [
          {
            arrangement: {
              columnOrder: [],
              dateRange: "30d",
              filters: { ...DEFAULT_BRANCH_FILTERS },
              hiddenColumns: [],
              sortDir: BranchSortDir.Desc,
              sortKey: BranchSortKey.LastActivity,
            },
            id: "pre-m5",
            name: "Legacy",
          },
        ],
      })
    );
    const apply = makeApply();
    const { result } = renderHook(
      () =>
        useBranchSavedViews(
          useBranchSavedViewsStore(PERSIST_KEY),
          SNAPSHOT,
          apply
        ),
      { wrapper: wrapper() }
    );

    act(() => result.current.onSelectView("pre-m5"));

    expect(
      apply.applyArrangement.mock.calls.at(-1)?.[0].pageSize
    ).toBeUndefined();
    expect(apply.applyFilters.mock.calls.at(-1)?.[1]).toBeUndefined();

    // "Default view" is the arrangement that DOES state one, so the two are
    // distinguishable through this same path.
    act(() => result.current.onSelectView(null));
    expect(apply.applyFilters.mock.calls.at(-1)?.[1]).toBe(
      DEFAULT_TABLE_PAGE_SIZE
    );
  });
});

describe("useBranchSavedViewsStore", () => {
  it("reports the arrangement settled while the identity is still unresolved", () => {
    // ISS-9447 (review): this flag is now a READ gate
    // (`useUrlSyncedBranchServerState.isReadReady`), so it has to be incapable
    // of holding the table on a skeleton forever. An unresolved identity yields
    // no scoped storage key, a keyless collection is memory-only, and such a
    // collection is restored on its first commit — so a stalled auth hydration
    // degrades to the pre-gate double read, never to a permanent skeleton. The
    // closed half of the same flag is pinned by the ISS-9568 adoption case above.
    const unresolved = ({ children }: { children: ReactNode }) => (
      <AuthAdapterProvider
        adapter={createStaticAuthAdapter({ isLoaded: false })}
      >
        {children}
      </AuthAdapterProvider>
    );
    const { result } = renderHook(() => useBranchSavedViewsStore(PERSIST_KEY), {
      wrapper: unresolved,
    });

    expect(result.current.isArrangementSettled).toBe(true);
  });
});

describe("scopeSavedViewsKey", () => {
  it("folds org + user into the key when a base key and identity are present", () => {
    expect(scopeSavedViewsKey("branches:web", true, "u1", "o1")).toBe(
      "o1:u1:branches:web"
    );
  });

  it("falls back to stable segments for a signed-out (loaded, null identity) session", () => {
    expect(scopeSavedViewsKey("branches:web", true, null, null)).toBe(
      "no-org:anon:branches:web"
    );
  });

  it("returns undefined until auth has hydrated so the empty default is never persisted under a wrong key", () => {
    expect(
      scopeSavedViewsKey("branches:web", false, null, null)
    ).toBeUndefined();
  });

  it("returns undefined for a memory-only surface (no base key)", () => {
    expect(scopeSavedViewsKey(undefined, true, "u1", "o1")).toBeUndefined();
  });
});
