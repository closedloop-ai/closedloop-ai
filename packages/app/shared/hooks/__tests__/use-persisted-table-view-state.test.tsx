import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthAdapterProvider } from "../../auth/provider";
import { createStaticAuthAdapter } from "../../auth/static-auth-adapter";
import { usePersistedTableViewState } from "../use-persisted-table-view-state";
import { VIEW_RESTORE_AUTH_DEADLINE_MS } from "../use-table-view-storage-key";
import {
  COLUMN_IDS,
  type ColumnId,
  type Extras,
  parse,
  render,
  renderAsUser,
  type SortDir,
  type SortKey,
  useTestView,
} from "./persisted-table-view-state.test-support";

afterEach(() => {
  localStorage.clear();
});

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

// As `renderWithAuth`, but records the gate and the sort key on EVERY render
// into `seen`. The pairing of the two is the contract ISS-8262 is about, and it
// is only observable per-render: a settled-state assertion cannot tell an
// always-correct gate from one that opened on the defaults first.
function renderTracedWithAuth(
  auth: { isLoaded: boolean },
  seen: { ready: boolean; sortKey: SortKey }[]
) {
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
  return renderHook(
    () => {
      const view = useTestView("web");
      seen.push({ ready: view.isViewReady, sortKey: view.sortKey });
      return view;
    },
    { wrapper }
  );
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
      // rather than to a permanently pending query behind a skeleton. A view
      // saved under a PER-USER key stays unreachable past the deadline: reaching
      // it needs an id auth never delivered. ISS-8262 recovers the LEGACY key
      // instead (below), which is the one an unidentified surface can name.
      expect(result.current.isViewReady).toBe(true);
      expect(result.current.extras.window).toBe("7d");
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * ISS-8262. The deadline above is a real safety net, but it used to pay for
   * itself with the user's saved view: past it `storageKey` was still null, so
   * the restore read NOTHING, committed the DEFAULTS, and `isViewReady` opened
   * on them. The single read a stalled surface issues then paginated under the
   * default sort while the saved view sat intact on disk, never overwritten
   * (the persist effect is gated separately) and never applied.
   *
   * This is the desktop Sessions list's real failure: every desktop profile is
   * signed out, so its saved view lives under exactly this legacy key.
   */
  it("restores the LEGACY saved view when auth never resolves (ISS-8262)", () => {
    vi.useFakeTimers();
    try {
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

      const { result } = renderWithAuth({ isLoaded: false }, "web");
      // Before the deadline the gate is shut and the view is still the default:
      // auth may yet hydrate and name a per-user key, so committing now would
      // be committing to the wrong one.
      expect(result.current.isViewReady).toBe(false);
      expect(result.current.sortKey).toBe("name");

      act(() => vi.advanceTimersByTime(VIEW_RESTORE_AUTH_DEADLINE_MS));

      expect(result.current.isViewReady).toBe(true);
      expect(result.current.sortKey).toBe("date");
      expect(result.current.sortDir).toBe("desc");
      expect(result.current.extras.window).toBe("30d");
      expect(result.current.visibleColumns.has("b")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never opens the gate on the defaults while a legacy view is restorable (ISS-8262)", () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem(
        "test:view:web",
        JSON.stringify({
          sortKey: "date",
          sortDir: "desc",
          hiddenColumns: [],
          window: "30d",
          revealed: true,
        })
      );

      // Every render the hook produces, not just the settled one. A consumer
      // reads `isViewReady` on each of them, so a SINGLE render pairing an open
      // gate with the default sort is the wasted first pagination — the bug —
      // even when the view is correct by the time the test settles.
      const seen: { ready: boolean; sortKey: SortKey }[] = [];
      renderTracedWithAuth({ isLoaded: false }, seen);

      act(() => vi.advanceTimersByTime(VIEW_RESTORE_AUTH_DEADLINE_MS));

      const opened = seen.filter((frame) => frame.ready);
      expect(opened.length).toBeGreaterThan(0);
      for (const frame of opened) {
        expect(frame.sortKey).toBe("date");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not PERSIST under the legacy key when auth never resolves (ISS-8262)", () => {
    vi.useFakeTimers();
    try {
      const stored = JSON.stringify({
        sortKey: "date",
        sortDir: "desc",
        hiddenColumns: [],
        window: "30d",
        revealed: true,
      });
      localStorage.setItem("test:view:web", stored);

      const { result } = renderWithAuth({ isLoaded: false }, "web");
      act(() => vi.advanceTimersByTime(VIEW_RESTORE_AUTH_DEADLINE_MS));
      act(() => result.current.setSort("name", "asc"));

      // FEA-4168's shadowing guard is about the WRITE, and the deadline read
      // must not weaken it: a viewer auth never identified may read the
      // un-namespaced view but may never overwrite it, because a signed-in user
      // whose per-user key is empty migrates from this exact key.
      expect(localStorage.getItem("test:view:web")).toBe(stored);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * ISS-8262 (codex review, PR #6123): the deadline read is a STAND-IN for an
   * identity that has not arrived, never a latch. A stalled auth that later
   * hydrates must supersede the un-namespaced view with the viewer's own — a
   * legacy blob left on a shared profile by an earlier occupant may be on
   * screen while nobody is identified, but it must not survive the moment
   * somebody is.
   *
   * The three states are distinguishable on purpose: the DEFAULT hides nothing,
   * the LEGACY view sorts by `date` and hides `a`, and Alice's own view sorts by
   * `name` and hides `c`. So this cannot pass by landing on the defaults, and it
   * cannot pass by the restore simply never re-running.
   */
  it("supersedes the deadline restore with the viewer's own view when auth resolves late (ISS-8262)", () => {
    vi.useFakeTimers();
    try {
      const legacy = JSON.stringify({
        sortKey: "date",
        sortDir: "desc",
        hiddenColumns: ["a"],
        window: "30d",
        revealed: true,
      });
      localStorage.setItem("test:view:web", legacy);
      localStorage.setItem(
        "test:view:web:u:user_alice",
        JSON.stringify({
          sortKey: "name",
          sortDir: "asc",
          hiddenColumns: ["c"],
          window: "7d",
          revealed: false,
        })
      );

      let authLoaded = false;
      const wrapper = ({ children }: { children: ReactNode }) => (
        <AuthAdapterProvider
          adapter={createStaticAuthAdapter({
            isLoaded: authLoaded,
            userId: authLoaded ? "user_alice" : null,
          })}
        >
          {children}
        </AuthAdapterProvider>
      );
      const { result, rerender } = renderHook(() => useTestView("web"), {
        wrapper,
      });

      act(() => vi.advanceTimersByTime(VIEW_RESTORE_AUTH_DEADLINE_MS));
      // The unidentified window: the legacy view is what an anonymous surface
      // can name, so it is what the surface shows.
      expect(result.current.sortKey).toBe("date");
      expect(result.current.visibleColumns.has("a")).toBe(false);

      authLoaded = true;
      act(() => rerender());

      // Identity arrives: `storageKey` resolves, `restoreStorageKey` follows it,
      // and the restore re-runs against Alice's own key.
      expect(result.current.sortKey).toBe("name");
      expect(result.current.visibleColumns.has("a")).toBe(true);
      expect(result.current.visibleColumns.has("c")).toBe(false);
      expect(result.current.extras.window).toBe("7d");
      // And the read stayed one-way throughout: nothing the unidentified viewer
      // saw was written back over the legacy blob.
      expect(localStorage.getItem("test:view:web")).toBe(legacy);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * ISS-5528. A feature may SELECT its `defaultHiddenColumns` from a feature flag,
 * and on web PostHog resolves that flag AFTER the component has mounted. The
 * restore effect is the only thing that applies the set, and its re-entry guard
 * compared just the storage key and the parser — so the pre-flag set was the
 * only one that ever landed and the column stayed visible for every real
 * viewer, while a test that resolved the flag before mount passed happily.
 *
 * This is the same defect ISS-4890 fixed for a flag-selected `parse`, one field
 * over.
 */
describe("usePersistedTableViewState — a default-hidden set that resolves late", () => {
  it("re-applies a default-hidden set that changed after mount", () => {
    let defaultHidden: readonly ColumnId[] = [];
    const { result, rerender } = renderHook(() =>
      useTestView(undefined, defaultHidden)
    );

    // Precondition, not decoration: without it, a column that was never visible
    // would satisfy the post-flip assertion below.
    expect(result.current.visibleColumns.has("b")).toBe(true);

    defaultHidden = ["b"];
    act(() => rerender());

    expect(result.current.visibleColumns.has("b")).toBe(false);
    // Only the declared column goes — a re-run must not reset the whole view.
    expect(result.current.visibleColumns.has("a")).toBe(true);
    expect(result.current.visibleColumns.has("c")).toBe(true);
  });

  /**
   * The case above is memory-only, and whitlockk's review of PR #6592 is that the
   * memory-only path is the one path where the ISS-5528 guard fix was already
   * sufficient. On a PERSISTING surface — which is every real viewer — the
   * pre-flag pass used to write its own defaults to storage, so the post-flag
   * re-run found a "saved view" this hook had just manufactured, took the
   * `saved` branch, and never reached the new default at all.
   */
  it("re-applies a late default-hidden set on a PERSISTING surface with no prior view", () => {
    let defaultHidden: readonly ColumnId[] = [];
    const { result, rerender } = renderHook(() =>
      useTestView("web", defaultHidden)
    );

    // Precondition: the column is genuinely visible, and — the part the
    // memory-only case cannot state — the unresolved pass has NOT materialized a
    // saved view. That storage entry is the whole defect: it is what the re-run
    // would restore instead of the newly-resolved default.
    expect(result.current.visibleColumns.has("b")).toBe(true);
    expect(localStorage.getItem("test:view:web")).toBeNull();

    defaultHidden = ["b"];
    act(() => rerender());

    expect(result.current.visibleColumns.has("b")).toBe(false);
    expect(result.current.visibleColumns.has("a")).toBe(true);
    expect(result.current.visibleColumns.has("c")).toBe(true);
  });

  /**
   * The other side of the same contract (ISS-5315): a view the USER shaped is
   * the whole truth about what they hid or showed, so a default that resolves
   * afterwards must not reach in and hide a column they are looking at.
   *
   * Paired with the case above deliberately. Alone, either one passes under a
   * hook that ignores the input it is about — "the late default lands" is
   * satisfied by always applying defaults, and "the saved view wins" by never
   * applying them.
   */
  it("leaves a view the user shaped alone when the default-hidden set resolves late", () => {
    let defaultHidden: readonly ColumnId[] = [];
    const { result, rerender } = renderHook(() =>
      useTestView("web", defaultHidden)
    );

    // The user shapes the view — on a dimension that is NOT column visibility,
    // so the assertion below cannot be satisfied by the toggle itself.
    act(() => result.current.setSort("date", "desc"));
    expect(localStorage.getItem("test:view:web")).not.toBeNull();

    defaultHidden = ["b"];
    act(() => rerender());

    expect(result.current.visibleColumns.has("b")).toBe(true);
    // …and their own dimension survived the re-run that restored it.
    expect(result.current.sortKey).toBe("date");
  });
});
