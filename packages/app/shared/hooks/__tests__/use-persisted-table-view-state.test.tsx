import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthAdapterProvider } from "../../auth/provider";
import { createStaticAuthAdapter } from "../../auth/static-auth-adapter";
import {
  type RestoredTableView,
  usePersistedTableViewState,
  VIEW_RESTORE_AUTH_DEADLINE_MS,
} from "../use-persisted-table-view-state";

afterEach(() => {
  localStorage.clear();
});

// A minimal concrete configuration to exercise the generic machinery in
// isolation from any feature hook.
type SortKey = "name" | "date";
type SortDir = "asc" | "desc";
type ColumnId = "a" | "b" | "c";
type Extras = { window: "7d" | "30d"; revealed: boolean };

const COLUMN_IDS: readonly ColumnId[] = ["a", "b", "c"];

function parse(
  raw: unknown
): RestoredTableView<SortKey, SortDir, Extras> | null {
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const sortKey = record.sortKey === "date" ? "date" : "name";
  const sortDir = record.sortDir === "asc" ? "asc" : "desc";
  const hiddenColumns = Array.isArray(record.hiddenColumns)
    ? record.hiddenColumns.filter((id): id is string => typeof id === "string")
    : [];
  const columnOrder = Array.isArray(record.columnOrder)
    ? record.columnOrder.filter((id): id is string => typeof id === "string")
    : [];
  const columnWidths =
    record.columnWidths !== null &&
    typeof record.columnWidths === "object" &&
    !Array.isArray(record.columnWidths)
      ? (record.columnWidths as Record<string, number>)
      : {};
  return {
    sortKey,
    sortDir,
    hiddenColumns,
    columnOrder,
    columnWidths,
    extras: {
      window: record.window === "30d" ? "30d" : "7d",
      revealed: record.revealed === true,
    },
  };
}

// The subject under test, declared once so every helper below drives the same
// configuration and none can silently diverge from the others.
function useTestView(persistKey?: string) {
  return usePersistedTableViewState<SortKey, SortDir, ColumnId, Extras>({
    persistKey,
    keyPrefix: "test:view:",
    columnIds: COLUMN_IDS,
    defaultSortKey: "name",
    defaultSortDir: "asc",
    sortDirs: ["asc", "desc"],
    defaultExtras: { window: "7d", revealed: false },
    parse,
  });
}

function render(persistKey?: string) {
  return renderHook(() => useTestView(persistKey));
}

// Mount under a static auth adapter so the hook resolves a signed-in user and
// namespaces its storage key per user (FEA-4168, wongk review). A `null` userId
// models a signed-out surface; `isLoaded: false` models auth still hydrating,
// the state a real Clerk mount passes through before it resolves.
function renderAsUser(
  userId: string | null,
  persistKey: string | undefined = "web",
  isLoaded = true
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AuthAdapterProvider
      adapter={createStaticAuthAdapter({ isLoaded, userId })}
    >
      {children}
    </AuthAdapterProvider>
  );
  return renderHook(() => useTestView(persistKey), { wrapper });
}

describe("usePersistedTableViewState", () => {
  it("returns the configured defaults with all columns visible", () => {
    const { result } = render();
    expect(result.current.sortKey).toBe("name");
    expect(result.current.sortDir).toBe("asc");
    expect(result.current.extras).toEqual({ window: "7d", revealed: false });
    for (const id of COLUMN_IDS) {
      expect(result.current.visibleColumns.has(id)).toBe(true);
    }
  });

  it("sets the sort key (leaving direction) and sets both together", () => {
    const { result } = render();
    act(() => result.current.setSort("date"));
    expect(result.current.sortKey).toBe("date");
    expect(result.current.sortDir).toBe("asc");
    act(() => result.current.setSort("name", "desc"));
    expect(result.current.sortKey).toBe("name");
    expect(result.current.sortDir).toBe("desc");
  });

  it("toggles sort direction between asc and desc", () => {
    const { result } = render();
    act(() => result.current.toggleSortDir());
    expect(result.current.sortDir).toBe("desc");
    act(() => result.current.toggleSortDir());
    expect(result.current.sortDir).toBe("asc");
  });

  it("toggles a column's visibility and resetColumns restores all", () => {
    const { result } = render();
    act(() => result.current.toggleColumn("b"));
    expect(result.current.visibleColumns.has("b")).toBe(false);
    act(() => result.current.toggleColumn("b"));
    expect(result.current.visibleColumns.has("b")).toBe(true);

    act(() => {
      result.current.toggleColumn("a");
      result.current.toggleColumn("c");
    });
    expect(result.current.visibleColumns.has("a")).toBe(false);
    act(() => result.current.resetColumns());
    for (const id of COLUMN_IDS) {
      expect(result.current.visibleColumns.has(id)).toBe(true);
    }
  });

  it("stores a reordered column order and resetColumns clears it (FEA-4021)", () => {
    const { result } = render();
    expect(result.current.columnOrder).toEqual([]);
    act(() => result.current.setColumnOrder(["c", "a", "b"]));
    expect(result.current.columnOrder).toEqual(["c", "a", "b"]);
    act(() => result.current.resetColumns());
    expect(result.current.columnOrder).toEqual([]);
  });

  it("drops unknown ids from a set column order (FEA-4021)", () => {
    const { result } = render();
    act(() => result.current.setColumnOrder(["c", "does-not-exist", "a"]));
    expect(result.current.columnOrder).toEqual(["c", "a"]);
  });

  it("stores a column width and resetColumns clears it (FEA-4168)", () => {
    const { result } = render();
    expect(result.current.columnWidths).toEqual({});
    act(() => result.current.setColumnWidth("b", 240));
    expect(result.current.columnWidths).toEqual({ b: 240 });
    act(() => result.current.resetColumns());
    expect(result.current.columnWidths).toEqual({});
  });

  it("merges widths per column without clobbering the others (FEA-4168)", () => {
    const { result } = render();
    act(() => result.current.setColumnWidth("a", 200));
    act(() => result.current.setColumnWidth("c", 90));
    expect(result.current.columnWidths).toEqual({ a: 200, c: 90 });
  });

  it("ignores a width for an unknown column id (FEA-4168)", () => {
    const { result } = render();
    act(() => result.current.setColumnWidth("does-not-exist", 300));
    expect(result.current.columnWidths).toEqual({});
  });

  it("persists and restores column widths by surface key (FEA-4168)", () => {
    const first = render("web");
    act(() => first.result.current.setColumnWidth("b", 260));
    const stored = JSON.parse(localStorage.getItem("test:view:web") ?? "null");
    expect(stored.columnWidths).toEqual({ b: 260 });
    const second = render("web");
    expect(second.result.current.columnWidths).toEqual({ b: 260 });
  });

  it("drops an unknown/malformed width from a restored view (FEA-4168)", () => {
    localStorage.setItem(
      "test:view:web",
      JSON.stringify({
        sortKey: "name",
        sortDir: "asc",
        hiddenColumns: [],
        columnOrder: [],
        // `a` is known-good; `zzz` is a stale id; `b` is a malformed NaN width.
        columnWidths: { a: 210, zzz: 400, b: Number.NaN },
      })
    );
    const { result } = render("web");
    expect(result.current.columnWidths).toEqual({ a: 210 });
  });

  it("persists and restores the column order by surface key (FEA-4021)", () => {
    const first = render("web");
    act(() => first.result.current.setColumnOrder(["b", "c", "a"]));
    const stored = JSON.parse(localStorage.getItem("test:view:web") ?? "null");
    expect(stored.columnOrder).toEqual(["b", "c", "a"]);

    const second = render("web");
    expect(second.result.current.columnOrder).toEqual(["b", "c", "a"]);
  });

  it("does not touch localStorage without a persistKey", () => {
    const { result } = render();
    act(() => {
      result.current.setSort("date", "desc");
      result.current.setExtras((prev) => ({ ...prev, revealed: true }));
    });
    expect(localStorage.length).toBe(0);
  });

  it("persists and restores sort, columns, and extras by surface key", () => {
    const first = render("web");
    act(() => {
      first.result.current.setSort("date", "desc");
      first.result.current.toggleColumn("a");
      first.result.current.setExtras(() => ({ window: "30d", revealed: true }));
    });

    const second = render("web");
    expect(second.result.current.sortKey).toBe("date");
    expect(second.result.current.sortDir).toBe("desc");
    expect(second.result.current.visibleColumns.has("a")).toBe(false);
    expect(second.result.current.extras).toEqual({
      window: "30d",
      revealed: true,
    });
  });

  it("filters unknown column ids out of a restored view", () => {
    localStorage.setItem(
      "test:view:web",
      JSON.stringify({
        sortKey: "name",
        sortDir: "asc",
        hiddenColumns: ["b", "does-not-exist"],
      })
    );
    const { result } = render("web");
    expect(result.current.visibleColumns.has("b")).toBe(false);
    expect([...result.current.visibleColumns]).not.toContain("does-not-exist");
  });

  it("persists extras into the same single localStorage object as sort/columns", () => {
    const { result } = render("web");
    act(() => {
      result.current.setSort("date", "desc");
      result.current.toggleColumn("c");
      result.current.setExtras(() => ({ window: "30d", revealed: true }));
    });
    const stored = JSON.parse(localStorage.getItem("test:view:web") ?? "null");
    expect(stored).toMatchObject({
      sortKey: "date",
      sortDir: "desc",
      hiddenColumns: ["c"],
      window: "30d",
      revealed: true,
    });
  });

  // FEA-4125 regression: the FIRST render must equal the SSR render (defaults),
  // even when a differing view is persisted. Reading `localStorage` in a
  // `useState` initializer made the first client render diverge from the
  // server-rendered defaults, which tripped React hydration error #418 and
  // blanked the Branches screen. The saved view must only be applied after mount
  // (in an effect), so the initial render carries the defaults and the restored
  // view lands on a subsequent commit.
  it("returns the defaults on the FIRST render even when a differing view is saved (no hydration divergence)", () => {
    localStorage.setItem(
      "test:view:web",
      JSON.stringify({
        sortKey: "date",
        sortDir: "desc",
        hiddenColumns: ["a"],
        window: "30d",
        revealed: true,
      })
    );

    // Capture every committed render so the FIRST (pre-effect, SSR-matching) one
    // can be asserted independently of the post-mount restore.
    const renders: {
      sortKey: SortKey;
      sortDir: SortDir;
      window: Extras["window"];
      hiddenA: boolean;
    }[] = [];
    renderHook(() => {
      const view = usePersistedTableViewState<
        SortKey,
        SortDir,
        ColumnId,
        Extras
      >({
        persistKey: "web",
        keyPrefix: "test:view:",
        columnIds: COLUMN_IDS,
        defaultSortKey: "name",
        defaultSortDir: "asc",
        sortDirs: ["asc", "desc"],
        defaultExtras: { window: "7d", revealed: false },
        parse,
      });
      renders.push({
        sortKey: view.sortKey,
        sortDir: view.sortDir,
        window: view.extras.window,
        hiddenA: !view.visibleColumns.has("a"),
      });
      return view;
    });

    // First commit = what the server rendered: the configured defaults, all
    // columns visible. If this ever reads the saved view, the client's first
    // render diverges from SSR and React #418 fires.
    expect(renders[0]).toEqual({
      sortKey: "name",
      sortDir: "asc",
      window: "7d",
      hiddenA: false,
    });

    // A later commit applies the saved view (restore ran in a post-mount
    // effect), so persistence and the visible state still honor it.
    const settled = renders.at(-1);
    expect(settled).toEqual({
      sortKey: "date",
      sortDir: "desc",
      window: "30d",
      hiddenA: true,
    });
  });

  it("does not clobber the saved view with defaults during the mount-time restore", () => {
    localStorage.setItem(
      "test:view:web",
      JSON.stringify({
        sortKey: "date",
        sortDir: "desc",
        hiddenColumns: ["b"],
        window: "30d",
        revealed: true,
      })
    );
    // Spy on the write so the assertion is that the default payload is NEVER
    // written — not merely that the final value matches. A "write defaults, then
    // overwrite with the restored view" sequence would leave the same final
    // value but still momentarily clobber the saved view (a losing last-write in
    // a cross-tab race), so checking only the end state passes on the bug this
    // guards. Every persisted write must carry the saved view's non-default sort.
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    render("web");

    const branchWrites = setItemSpy.mock.calls.filter(
      ([key]) => key === "test:view:web"
    );
    for (const [, value] of branchWrites) {
      const written = JSON.parse(value);
      // The default sortKey is "name"; the saved view is "date". If the persist
      // effect ever ran before the restore committed, it would write "name" here.
      expect(written.sortKey).toBe("date");
    }

    // The saved view still survives untouched at the end.
    const stored = JSON.parse(localStorage.getItem("test:view:web") ?? "null");
    expect(stored).toMatchObject({
      sortKey: "date",
      sortDir: "desc",
      hiddenColumns: ["b"],
      window: "30d",
      revealed: true,
    });
    setItemSpy.mockRestore();
  });
});

describe("usePersistedTableViewState per-user namespacing (FEA-4168)", () => {
  it("namespaces the storage key by the signed-in user id", () => {
    const { result } = renderAsUser("user_alice");
    act(() => result.current.setColumnWidth("b", 260));
    // The saved view lands under the per-user key, NOT the legacy surface key.
    expect(localStorage.getItem("test:view:web:u:user_alice")).not.toBeNull();
    expect(localStorage.getItem("test:view:web")).toBeNull();
    const stored = JSON.parse(
      localStorage.getItem("test:view:web:u:user_alice") ?? "null"
    );
    expect(stored.columnWidths).toEqual({ b: 260 });
  });

  it("keeps two users' layouts isolated under the same surface key", () => {
    const alice = renderAsUser("user_alice");
    act(() => alice.result.current.setColumnWidth("a", 200));

    // A second account on the same profile must not read Alice's width, and its
    // own change writes under a distinct key.
    const bob = renderAsUser("user_bob");
    expect(bob.result.current.columnWidths).toEqual({});
    act(() => bob.result.current.setColumnWidth("c", 90));

    expect(
      JSON.parse(localStorage.getItem("test:view:web:u:user_alice") ?? "null")
        .columnWidths
    ).toEqual({ a: 200 });
    expect(
      JSON.parse(localStorage.getItem("test:view:web:u:user_bob") ?? "null")
        .columnWidths
    ).toEqual({ c: 90 });
  });

  it("falls back to the legacy un-namespaced key when signed out", () => {
    const { result } = renderAsUser(null);
    act(() => result.current.setColumnWidth("b", 240));
    expect(localStorage.getItem("test:view:web")).not.toBeNull();
    const stored = JSON.parse(localStorage.getItem("test:view:web") ?? "null");
    expect(stored.columnWidths).toEqual({ b: 240 });
  });

  it("restores a signed-in user's pre-namespacing view from the legacy key (FEA-4168 migration)", () => {
    // A view saved before per-user namespacing shipped lives under the legacy
    // un-namespaced key. A now-signed-in user whose per-user key is still empty
    // must still restore it, then re-persist it under the per-user key.
    localStorage.setItem(
      "test:view:web",
      JSON.stringify({
        sortKey: "date",
        sortDir: "desc",
        hiddenColumns: ["a"],
        window: "30d",
        revealed: true,
      })
    );

    const { result } = renderAsUser("user_carol");
    expect(result.current.sortKey).toBe("date");
    expect(result.current.sortDir).toBe("desc");
    expect(result.current.visibleColumns.has("a")).toBe(false);
    expect(result.current.extras).toEqual({ window: "30d", revealed: true });

    // The restored view is re-persisted under the per-user key so the legacy
    // read is a one-time migration, not a permanent dependency.
    const migrated = JSON.parse(
      localStorage.getItem("test:view:web:u:user_carol") ?? "null"
    );
    expect(migrated).toMatchObject({ sortKey: "date", sortDir: "desc" });
  });

  it("prefers the per-user view over the legacy key when both exist (FEA-4168)", () => {
    // The per-user key must win: a stale legacy view can never shadow the
    // account's own saved layout.
    localStorage.setItem(
      "test:view:web",
      JSON.stringify({
        sortKey: "date",
        sortDir: "desc",
        hiddenColumns: ["a"],
        window: "30d",
        revealed: true,
      })
    );
    localStorage.setItem(
      "test:view:web:u:user_dave",
      JSON.stringify({
        sortKey: "name",
        sortDir: "asc",
        hiddenColumns: ["c"],
        window: "7d",
        revealed: false,
      })
    );

    const { result } = renderAsUser("user_dave");
    expect(result.current.sortKey).toBe("name");
    expect(result.current.sortDir).toBe("asc");
    expect(result.current.visibleColumns.has("a")).toBe(true);
    expect(result.current.visibleColumns.has("c")).toBe(false);
  });

  it("re-restores the new user's view on an in-place account switch", () => {
    // Seed distinct saved views for two accounts.
    localStorage.setItem(
      "test:view:web:u:user_alice",
      JSON.stringify({
        sortKey: "date",
        sortDir: "desc",
        hiddenColumns: ["a"],
        window: "30d",
        revealed: true,
      })
    );
    localStorage.setItem(
      "test:view:web:u:user_bob",
      JSON.stringify({
        sortKey: "name",
        sortDir: "asc",
        hiddenColumns: ["c"],
        window: "7d",
        revealed: false,
      })
    );

    // Swap the auth adapter's user while the hook stays mounted — the resolved
    // storage key changes, so the restore must re-run for the new account rather
    // than stranding Alice's view.
    let currentUser = "user_alice";
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AuthAdapterProvider
        adapter={createStaticAuthAdapter({ userId: currentUser })}
      >
        {children}
      </AuthAdapterProvider>
    );
    const { result, rerender } = renderHook(
      () =>
        usePersistedTableViewState<SortKey, SortDir, ColumnId, Extras>({
          persistKey: "web",
          keyPrefix: "test:view:",
          columnIds: COLUMN_IDS,
          defaultSortKey: "name",
          defaultSortDir: "asc",
          sortDirs: ["asc", "desc"],
          defaultExtras: { window: "7d", revealed: false },
          parse,
        }),
      { wrapper }
    );

    expect(result.current.sortKey).toBe("date");
    expect(result.current.visibleColumns.has("a")).toBe(false);

    currentUser = "user_bob";
    act(() => rerender());

    expect(result.current.sortKey).toBe("name");
    expect(result.current.visibleColumns.has("a")).toBe(true);
    expect(result.current.visibleColumns.has("c")).toBe(false);
  });
});

// Mount with a mutable auth snapshot so a test can hold `isLoaded` false — the
// state a real Clerk mount passes through before it hydrates — and then resolve
// it, rather than starting from the already-loaded static default.
function renderWithAuth(auth: { isLoaded: boolean }, persistKey?: string) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AuthAdapterProvider
      adapter={createStaticAuthAdapter({
        isLoaded: auth.isLoaded,
        userId: "user_alice",
      })}
    >
      {children}
    </AuthAdapterProvider>
  );
  return renderHook(() => useTestView(persistKey), { wrapper });
}

/**
 * ISS-4655. `isViewReady` is what a surface gates its data request on, so these
 * assert the gate's two failure directions, not just its happy path: it must not
 * open early (the double-fetch this exists to prevent) and it must not stay shut
 * (a table that never loads).
 */
describe("usePersistedTableViewState / isViewReady", () => {
  it("stays shut while auth hydrates, then opens WITH the restored view applied", () => {
    localStorage.setItem(
      "test:view:web:u:user_alice",
      JSON.stringify({
        sortKey: "date",
        sortDir: "desc",
        hiddenColumns: [],
        window: "30d",
        revealed: true,
      })
    );

    const auth = { isLoaded: false };
    const { result, rerender } = renderWithAuth(auth, "web");

    // Auth unresolved ⇒ no per-user storage key yet ⇒ the in-memory view is
    // still the DEFAULT. A consumer must not fetch against this window. The
    // pre-ISS-4655 boolean `restored` flipped true right here, which is exactly
    // how the default window reached the wire.
    expect(result.current.isViewReady).toBe(false);
    expect(result.current.extras.window).toBe("7d");

    auth.isLoaded = true;
    act(() => rerender());

    // Opens only once the saved view is actually in force — never in the gap
    // between the key resolving and the restore committing.
    expect(result.current.isViewReady).toBe(true);
    expect(result.current.extras.window).toBe("30d");
    expect(result.current.sortKey).toBe("date");
  });

  it("is ready immediately on a surface that does not persist", () => {
    // Memory-only (Storybook, prototypes): there is no stored view to wait for,
    // so an unresolved auth must not gate anything. Without this carve-out the
    // gate would hold such a surface shut until the deadline below.
    const { result } = renderWithAuth({ isLoaded: false });

    expect(result.current.isViewReady).toBe(true);
  });

  it("opens on the default view when auth never resolves", () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem(
        "test:view:web:u:user_alice",
        JSON.stringify({
          sortKey: "date",
          sortDir: "desc",
          hiddenColumns: [],
          window: "30d",
          revealed: true,
        })
      );

      const { result } = renderWithAuth({ isLoaded: false }, "web");
      expect(result.current.isViewReady).toBe(false);

      act(() => vi.advanceTimersByTime(VIEW_RESTORE_AUTH_DEADLINE_MS));

      // Degrades to the pre-gate behavior — one read on the default window —
      // rather than to a permanently pending query behind a skeleton. The saved
      // view is still unreachable because the key needs a user id.
      expect(result.current.isViewReady).toBe(true);
      expect(result.current.extras.window).toBe("7d");
    } finally {
      vi.useRealTimers();
    }
  });
});
