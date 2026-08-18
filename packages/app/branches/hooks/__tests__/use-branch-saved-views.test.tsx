import { BranchSessionPresence } from "@repo/api/src/types/branch";
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
} from "../use-branch-saved-views";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

const PERSIST_KEY = "test";
// Default test identity (org_test / user_test) scopes the storage key so views
// can never bleed across accounts/orgs sharing the same browser.
const STORAGE_KEY = "branches:saved-views:org_test:user_test:test";

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
  filters: FILTERS,
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
      () => useBranchSavedViews(PERSIST_KEY, SNAPSHOT, apply),
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
  });

  it("switching a saved view applies order + visibility + sort AND filters together", () => {
    const apply = makeApply();
    const { result } = renderHook(
      () => useBranchSavedViews(PERSIST_KEY, SNAPSHOT, apply),
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
      })
    );
    expect(apply.applyFilters).toHaveBeenCalledTimes(1);
    expect(apply.applyFilters).toHaveBeenCalledWith(
      expect.objectContaining({
        statuses: ["open"],
        sessionPresence: [BranchSessionPresence.Has],
      })
    );
    expect(result.current.activeViewId).toBe(id);
  });

  it("switching to the default (null) clears the active marker AND restores the default arrangement + filters", () => {
    const apply = makeApply();
    const { result } = renderHook(
      () => useBranchSavedViews(PERSIST_KEY, SNAPSHOT, apply),
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
    expect(apply.applyFilters).toHaveBeenCalledWith(
      expect.objectContaining({ statuses: [], owners: [], repos: [] })
    );
  });

  it("reapplies the restored active view's arrangement once on mount (trigger must not lie)", () => {
    // Seed a persisted collection whose active view is "Saved" — as if the user
    // saved it, then reloaded / returned through the plain Branches route.
    const seeded = {
      views: [
        {
          id: "saved-1",
          name: "Saved",
          arrangement: {
            sortKey: BranchSortKey.Name,
            sortDir: BranchSortDir.Asc,
            dateRange: "90d",
            hiddenColumns: ["repo"],
            columnOrder: ["status", "owner"],
            filters: { ...FILTERS },
          },
        },
      ],
      activeViewId: "saved-1",
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));

    const apply = makeApply();
    const { result } = renderHook(
      () =>
        useBranchSavedViews(
          PERSIST_KEY,
          // The live snapshot on mount is the DEFAULT — the table has not been
          // put on the saved view yet, which is exactly the lie we're fixing.
          { ...SNAPSHOT, dateRange: "7d", hiddenColumns: [], columnOrder: [] },
          apply
        ),
      { wrapper: wrapper() }
    );

    // The trigger shows the saved view AND the table was actually moved onto it.
    expect(result.current.activeViewId).toBe("saved-1");
    expect(apply.applyArrangement).toHaveBeenCalledTimes(1);
    expect(apply.applyArrangement).toHaveBeenCalledWith(
      expect.objectContaining({
        sortKey: BranchSortKey.Name,
        dateRange: "90d",
        hiddenColumns: ["repo"],
        columnOrder: ["status", "owner"],
      })
    );
    expect(apply.applyFilters).toHaveBeenCalledTimes(1);
    expect(apply.applyFilters).toHaveBeenCalledWith(
      expect.objectContaining({ statuses: ["open"] })
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
      () => useBranchSavedViews(PERSIST_KEY, SNAPSHOT, apply),
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
      () => useBranchSavedViews(PERSIST_KEY, SNAPSHOT, apply),
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
      expect.objectContaining({ statuses: [], owners: [] })
    );
  });

  it("deleting a NON-active view does not disturb the live arrangement", () => {
    const apply = makeApply();
    const { result } = renderHook(
      () => useBranchSavedViews(PERSIST_KEY, SNAPSHOT, apply),
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
      () => useBranchSavedViews(PERSIST_KEY, SNAPSHOT, apply),
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
      () => useBranchSavedViews(PERSIST_KEY, SNAPSHOT, apply),
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
      () => useBranchSavedViews(PERSIST_KEY, SNAPSHOT, makeApply()),
      { wrapper: wrapper() }
    );
    act(() => first.result.current.onCreateView("Mine"));
    first.unmount();

    // Second mount: the collection is restored from localStorage.
    const apply = makeApply();
    const second = renderHook(
      () => useBranchSavedViews(PERSIST_KEY, SNAPSHOT, apply),
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
      expect.objectContaining({ statuses: ["open"] })
    );
  });

  it("a snapshot with no facet active round-trips the default filters", () => {
    const apply = makeApply();
    const { result } = renderHook(
      () =>
        useBranchSavedViews(
          PERSIST_KEY,
          { ...SNAPSHOT, filters: DEFAULT_BRANCH_FILTERS },
          apply
        ),
      { wrapper: wrapper() }
    );
    act(() => result.current.onCreateView("Plain"));
    const id = result.current.views[0].id;
    act(() => result.current.onSelectView(id));
    expect(apply.applyFilters).toHaveBeenLastCalledWith(
      expect.objectContaining({ statuses: [], owners: [], repos: [] })
    );
  });

  it("scopes persistence by org + user so a second account cannot read the first's views", () => {
    // Account A (org_a / user_a) creates a named view.
    const a = renderHook(
      () => useBranchSavedViews(PERSIST_KEY, SNAPSHOT, makeApply()),
      { wrapper: wrapper("user_a", "org_a") }
    );
    act(() => a.result.current.onCreateView("Alice's view"));
    a.unmount();

    // Account B (org_b / user_b) on the SAME browser sees an empty switcher —
    // localStorage was not cleared on sign-out, but the key is identity-scoped.
    const b = renderHook(
      () => useBranchSavedViews(PERSIST_KEY, SNAPSHOT, makeApply()),
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
