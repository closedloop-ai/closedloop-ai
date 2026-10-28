import {
  act,
  render as renderComponent,
  renderHook,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthAdapter } from "../../auth/auth-adapter";
import { AuthAdapterProvider } from "../../auth/provider";
import { createStaticAuthAdapter } from "../../auth/static-auth-adapter";
import type { FeatureFlagAdapter } from "../../feature-flags/feature-flag-adapter";
import { FeatureFlagAdapterProvider } from "../../feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "../../feature-flags/static-feature-flag-adapter";
import {
  ORG_SCOPED_TABLE_VIEW_STATE_FEATURE_FLAG_KEY,
  TABLE_PAGE_SIZE_LADDER_FEATURE_FLAG_KEY,
} from "../../lib/feature-flags";
import {
  type RestoredTableView,
  usePersistedTableViewState,
} from "../use-persisted-table-view-state";
import {
  COLUMN_IDS,
  type ColumnId,
  renderAsUser,
  type SortDir,
  type SortKey,
  useTestView,
} from "./persisted-table-view-state.test-support";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

/**
 * ISS-9568 — cross-tab adoption of a `storage` event on the hook's own key.
 *
 * jsdom does not fire `storage` across documents, so every case dispatches the
 * event by hand; the dispatch itself is the only signal a cross-tab write
 * exists, never `localStorage.setItem` alone.
 */
function dispatchStorage(key: string | null, newValue: string | null) {
  act(() => {
    globalThis.dispatchEvent(new StorageEvent("storage", { key, newValue }));
  });
}

// The INSTANCE, not `Storage.prototype`: jsdom gives `localStorage` an own
// `setItem`, so a prototype spy never sees a real write.
function spyOnSetItem() {
  return vi.spyOn(localStorage, "setItem");
}

function renderAsUserWithLadder(
  userId: string | null,
  ladderEnabled: boolean,
  persistKey = "web"
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AuthAdapterProvider
      adapter={createStaticAuthAdapter({ isLoaded: true, userId })}
    >
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: ladderEnabled
            ? [TABLE_PAGE_SIZE_LADDER_FEATURE_FLAG_KEY]
            : [],
        })}
      >
        {children}
      </FeatureFlagAdapterProvider>
    </AuthAdapterProvider>
  );
  return renderHook(() => useTestView(persistKey), { wrapper });
}

function renderAsOrgScopedUser(orgId: string) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AuthAdapterProvider
      adapter={createStaticAuthAdapter({
        isLoaded: true,
        userId: "user-1",
        orgId,
      })}
    >
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [ORG_SCOPED_TABLE_VIEW_STATE_FEATURE_FLAG_KEY],
        })}
      >
        {children}
      </FeatureFlagAdapterProvider>
    </AuthAdapterProvider>
  );
  return renderHook(() => useTestView("web"), { wrapper });
}

/**
 * A reactive auth adapter test double: `useAuthSnapshot` subscribes via
 * `useSyncExternalStore`, so `setUserId` (called inside `act`) changes the
 * resolved auth identity of an ALREADY-MOUNTED hook — the shape a real account
 * switch takes, which a static per-mount adapter cannot model.
 */
function createReactiveAuthAdapter(initialUserId: string | null) {
  const buildSnapshot = (userId: string | null) => ({
    isLoaded: true,
    userId,
    orgId: "org_test",
    getToken: () => Promise.resolve("test-token"),
  });
  // Cached, not rebuilt per read: `useSyncExternalStore` re-renders until two
  // consecutive snapshots are identical, so a fresh object each call loops.
  let snapshot = buildSnapshot(initialUserId);
  const listeners = new Set<() => void>();
  const adapter: AuthAdapter = {
    useAuthSnapshot: () =>
      useSyncExternalStore(
        (onChange) => {
          listeners.add(onChange);
          return () => listeners.delete(onChange);
        },
        () => snapshot
      ),
  };
  return {
    adapter,
    setUserId(next: string | null) {
      snapshot = buildSnapshot(next);
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

// Module-level on purpose: the hook keys its restore on this set's IDENTITY, so
// an inline literal re-runs the restore on every render.
const DEFAULT_HIDDEN_C: readonly ColumnId[] = ["c"];

/**
 * A feature-flag adapter whose answer can change after mount — the shape a
 * PostHog flag takes when it resolves after the surface has rendered.
 */
function createReactiveLadderFlagAdapter(initiallyEnabled: boolean) {
  let enabled = initiallyEnabled;
  const listeners = new Set<() => void>();
  const adapter: FeatureFlagAdapter = {
    useFeatureFlagEnabled: (key: string) => {
      const on = useSyncExternalStore(
        (onChange) => {
          listeners.add(onChange);
          return () => listeners.delete(onChange);
        },
        () => enabled
      );
      return key === TABLE_PAGE_SIZE_LADDER_FEATURE_FLAG_KEY && on;
    },
  };
  return {
    adapter,
    setEnabled(next: boolean) {
      enabled = next;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

function renderAsUserWithReactiveLadder(initiallyEnabled: boolean) {
  const ladder = createReactiveLadderFlagAdapter(initiallyEnabled);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AuthAdapterProvider
      adapter={createStaticAuthAdapter({ isLoaded: true, userId: "user-1" })}
    >
      <FeatureFlagAdapterProvider adapter={ladder.adapter}>
        {children}
      </FeatureFlagAdapterProvider>
    </AuthAdapterProvider>
  );
  return { ...renderHook(() => useTestView("web"), { wrapper }), ladder };
}

const BLOB_HIDDEN_A_SORT_DATE = {
  sortKey: "date",
  sortDir: "desc",
  hiddenColumns: ["a"],
  columnOrder: [],
  columnWidths: {},
  window: "30d",
  revealed: true,
};

describe("usePersistedTableViewState cross-tab storage adoption", () => {
  it("adopts a cross-tab write and a later local edit does not clobber the adopted fields", () => {
    const { result } = renderAsUser("user-1");
    act(() => result.current.toggleColumn("b"));
    const setItemSpy = spyOnSetItem();
    setItemSpy.mockClear();

    dispatchStorage(
      "test:view:web:u:user-1",
      JSON.stringify(BLOB_HIDDEN_A_SORT_DATE)
    );
    expect(result.current.visibleColumns.has("a")).toBe(false);

    // A sort the adopted blob does NOT already hold, so the edit is a real
    // state change and the persist effect runs.
    act(() => result.current.setSort("name", "asc"));

    const stored = JSON.parse(
      localStorage.getItem("test:view:web:u:user-1") ?? "null"
    );
    expect(stored.hiddenColumns).toEqual(["a"]);
    expect(stored.sortKey).toBe("name");
    expect(stored.sortDir).toBe("asc");
  });

  it("adopting a cross-tab write updates state and writes nothing back", () => {
    const { result } = renderAsUser("user-1");
    const setItemSpy = spyOnSetItem();
    const callsBefore = setItemSpy.mock.calls.length;

    dispatchStorage(
      "test:view:web:u:user-1",
      JSON.stringify(BLOB_HIDDEN_A_SORT_DATE)
    );

    expect(result.current.sortKey).toBe("date");
    expect(result.current.extras).toEqual({ window: "30d", revealed: true });
    expect(result.current.visibleColumns.has("a")).toBe(false);
    expect(setItemSpy.mock.calls.length).toBe(callsBefore);
  });

  it("adopting a view on a never-saved surface does not itself materialize a write, but a real edit does", () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AuthAdapterProvider
        adapter={createStaticAuthAdapter({ isLoaded: true, userId: "user-1" })}
      >
        {children}
      </AuthAdapterProvider>
    );
    const { result } = renderHook(() => useTestView("web", DEFAULT_HIDDEN_C), {
      wrapper,
    });
    const setItemSpy = spyOnSetItem();

    dispatchStorage(
      "test:view:web:u:user-1",
      JSON.stringify(BLOB_HIDDEN_A_SORT_DATE)
    );
    expect(setItemSpy).not.toHaveBeenCalled();

    act(() => result.current.toggleColumn("b"));
    expect(setItemSpy).toHaveBeenCalled();
  });

  it("adopts an unsanctioned page size while the ladder flag is off and a following edit writes it back", () => {
    const { result } = renderAsUserWithLadder("user-1", false);
    const setItemSpy = spyOnSetItem();

    dispatchStorage(
      "test:view:web:u:user-1",
      JSON.stringify({ ...BLOB_HIDDEN_A_SORT_DATE, pageSize: 250 })
    );
    expect(result.current.pageSize).toBe(25);

    setItemSpy.mockClear();
    act(() => result.current.toggleColumn("b"));
    const stored = JSON.parse(
      localStorage.getItem("test:view:web:u:user-1") ?? "null"
    );
    expect(stored.pageSize).toBe(250);
  });

  it("adopts a page size while the ladder flag is on and a following edit writes it back", () => {
    const { result } = renderAsUserWithLadder("user-1", true);

    dispatchStorage(
      "test:view:web:u:user-1",
      JSON.stringify({ ...BLOB_HIDDEN_A_SORT_DATE, pageSize: 250 })
    );
    expect(result.current.pageSize).toBe(250);

    act(() => result.current.toggleColumn("b"));
    const stored = JSON.parse(
      localStorage.getItem("test:view:web:u:user-1") ?? "null"
    );
    expect(stored.pageSize).toBe(250);
  });

  it("promotes a page size adopted under a closed ladder gate when the gate opens, and never writes the on-screen value over it", () => {
    const { result, ladder } = renderAsUserWithReactiveLadder(false);
    const setItemSpy = spyOnSetItem();

    dispatchStorage(
      "test:view:web:u:user-1",
      JSON.stringify({ ...BLOB_HIDDEN_A_SORT_DATE, pageSize: 250 })
    );
    expect(result.current.pageSize).toBe(25);

    act(() => ladder.setEnabled(true));

    expect(result.current.pageSize).toBe(250);
    const pageSizesWritten = setItemSpy.mock.calls.map(
      ([, value]) => JSON.parse(String(value)).pageSize
    );
    expect(pageSizesWritten).not.toContain(25);

    act(() => result.current.toggleColumn("b"));
    const stored = JSON.parse(
      localStorage.getItem("test:view:web:u:user-1") ?? "null"
    );
    expect(stored.pageSize).toBe(250);
  });

  it("drops a page size adopted under a closed gate when the account changes before the gate opens", () => {
    const ladder = createReactiveLadderFlagAdapter(false);
    const auth = createReactiveAuthAdapter("user-1");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AuthAdapterProvider adapter={auth.adapter}>
        <FeatureFlagAdapterProvider adapter={ladder.adapter}>
          {children}
        </FeatureFlagAdapterProvider>
      </AuthAdapterProvider>
    );
    const { result } = renderHook(() => useTestView("web"), { wrapper });

    dispatchStorage(
      "test:view:web:u:user-1",
      JSON.stringify({ ...BLOB_HIDDEN_A_SORT_DATE, pageSize: 250 })
    );
    act(() => auth.setUserId("user-2"));
    act(() => ladder.setEnabled(true));

    expect(result.current.pageSize).toBe(25);
    expect(localStorage.getItem("test:view:web:u:user-2")).toBeNull();
  });

  it("forgets the last write when another tab clears storage, so a re-run of the persist effect writes the view back", () => {
    const { result, ladder } = renderAsUserWithReactiveLadder(false);
    dispatchStorage(
      "test:view:web:u:user-1",
      JSON.stringify(BLOB_HIDDEN_A_SORT_DATE)
    );
    expect(result.current.sortKey).toBe("date");
    const setItemSpy = spyOnSetItem();

    // `localStorage.clear()` elsewhere: the event carries no key and no value.
    dispatchStorage(null, null);
    expect(result.current.sortKey).toBe("date");

    // A persist re-run with no state change — the gate resolving — must now
    // put the view back on disk instead of deduping against bytes that are
    // no longer there.
    act(() => ladder.setEnabled(true));
    expect(setItemSpy).toHaveBeenCalled();
    expect(
      JSON.parse(localStorage.getItem("test:view:web:u:user-1") ?? "null")
        .sortKey
    ).toBe("date");
  });

  it("re-parses an adopted event through the hook's parser, applying neither unknown columns nor unknown widths", () => {
    const { result } = renderAsUser("user-1");

    dispatchStorage(
      "test:view:web:u:user-1",
      JSON.stringify({
        sortKey: "date",
        sortDir: "desc",
        hiddenColumns: ["a", "does-not-exist"],
        columnOrder: [],
        columnWidths: { b: 240, zzz: 10, c: -1 },
        window: "30d",
        revealed: true,
      })
    );

    expect(result.current.visibleColumns.has("a")).toBe(false);
    for (const id of COLUMN_IDS) {
      if (id === "a") {
        continue;
      }
      expect(result.current.visibleColumns.has(id)).toBe(true);
    }
    expect(result.current.columnWidths).toEqual({ b: 240 });
  });

  it("ignores an event whose bytes are not JSON", () => {
    const { result } = renderAsUser("user-1");
    const setItemSpy = spyOnSetItem();

    dispatchStorage("test:view:web:u:user-1", "not json{");

    expect(result.current.sortKey).toBe("name");
    expect(setItemSpy).not.toHaveBeenCalled();
  });

  it("ignores an event whose bytes parse to a non-object the hook's parser rejects", () => {
    const { result } = renderAsUser("user-1");
    const setItemSpy = spyOnSetItem();

    dispatchStorage("test:view:web:u:user-1", "42");

    expect(result.current.sortKey).toBe("name");
    expect(setItemSpy).not.toHaveBeenCalled();
  });

  it("ignores an event whose parser throws, without the throw escaping the handler", () => {
    const throwingParse = (): RestoredTableView<SortKey, SortDir, never> => {
      throw new Error("boom");
    };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AuthAdapterProvider
        adapter={createStaticAuthAdapter({ isLoaded: true, userId: "user-1" })}
      >
        {children}
      </AuthAdapterProvider>
    );
    const { result } = renderHook(
      () =>
        usePersistedTableViewState({
          persistKey: "web",
          keyPrefix: "test:view:",
          columnIds: COLUMN_IDS,
          defaultSortKey: "name" as SortKey,
          defaultSortDir: "asc" as SortDir,
          sortDirs: ["asc", "desc"] as const,
          defaultExtras: {},
          parse: throwingParse,
        }),
      { wrapper }
    );

    expect(() =>
      dispatchStorage(
        "test:view:web:u:user-1",
        JSON.stringify(BLOB_HIDDEN_A_SORT_DATE)
      )
    ).not.toThrow();
    expect(result.current.sortKey).toBe("name");
  });

  it("keeps state on a removal event and lets a following local edit write again", () => {
    const { result } = renderAsUser("user-1");
    act(() => result.current.setSort("date"));
    const setItemSpy = spyOnSetItem();

    dispatchStorage("test:view:web:u:user-1", null);
    expect(result.current.sortKey).toBe("date");

    setItemSpy.mockClear();
    act(() => result.current.toggleColumn("b"));
    expect(setItemSpy).toHaveBeenCalled();
  });

  it("ignores an event on a different key", () => {
    const { result } = renderAsUser("user-1");

    dispatchStorage("test:view:other", JSON.stringify(BLOB_HIDDEN_A_SORT_DATE));

    expect(result.current.sortKey).toBe("name");
    expect(result.current.visibleColumns.has("a")).toBe(true);
  });

  it("subscribes only to the active org-scoped key after migration fallbacks restore", () => {
    localStorage.setItem(
      "test:view:web:u:user-1",
      JSON.stringify(BLOB_HIDDEN_A_SORT_DATE)
    );
    const { result } = renderAsOrgScopedUser("org-a");

    expect(result.current.sortKey).toBe("date");

    dispatchStorage(
      "test:view:web:u:user-1",
      JSON.stringify({
        ...BLOB_HIDDEN_A_SORT_DATE,
        hiddenColumns: ["b"],
      })
    );
    dispatchStorage(
      "test:view:web::id:user-1:org-b",
      JSON.stringify({
        ...BLOB_HIDDEN_A_SORT_DATE,
        hiddenColumns: ["b"],
      })
    );
    expect(result.current.visibleColumns.has("a")).toBe(false);
    expect(result.current.visibleColumns.has("b")).toBe(true);

    dispatchStorage(
      "test:view:web::id:user-1:org-a",
      JSON.stringify({
        ...BLOB_HIDDEN_A_SORT_DATE,
        hiddenColumns: ["b"],
      })
    );
    expect(result.current.visibleColumns.has("a")).toBe(true);
    expect(result.current.visibleColumns.has("b")).toBe(false);
  });

  it("is not subscribed before auth has loaded, so no event is adopted and nothing is written", () => {
    const { result } = renderAsUser("user-1", "web", false);
    const setItemSpy = spyOnSetItem();

    dispatchStorage(
      "test:view:web:u:user-1",
      JSON.stringify(BLOB_HIDDEN_A_SORT_DATE)
    );
    dispatchStorage("test:view:web", JSON.stringify(BLOB_HIDDEN_A_SORT_DATE));

    expect(result.current.sortKey).toBe("name");
    expect(setItemSpy).not.toHaveBeenCalled();
  });

  it("does not throw and does not write after unmount", () => {
    const { unmount } = renderAsUser("user-1");
    const setItemSpy = spyOnSetItem();
    unmount();

    expect(() =>
      dispatchStorage(
        "test:view:web:u:user-1",
        JSON.stringify(BLOB_HIDDEN_A_SORT_DATE)
      )
    ).not.toThrow();
    expect(setItemSpy).not.toHaveBeenCalled();
  });

  it("resubscribes to the new user's key when the resolved account changes mid-life", () => {
    const { adapter, setUserId } = createReactiveAuthAdapter("user-1");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AuthAdapterProvider adapter={adapter}>{children}</AuthAdapterProvider>
    );
    const { result } = renderHook(() => useTestView("web"), { wrapper });

    act(() => setUserId("user-2"));

    dispatchStorage(
      "test:view:web:u:user-1",
      JSON.stringify(BLOB_HIDDEN_A_SORT_DATE)
    );
    expect(result.current.sortKey).toBe("name");

    dispatchStorage(
      "test:view:web:u:user-2",
      JSON.stringify(BLOB_HIDDEN_A_SORT_DATE)
    );
    expect(result.current.sortKey).toBe("date");
  });

  it("adopts the second of two back-to-back events dispatched before a flush", () => {
    const { result } = renderAsUser("user-1");

    act(() => {
      globalThis.dispatchEvent(
        new StorageEvent("storage", {
          key: "test:view:web:u:user-1",
          newValue: JSON.stringify(BLOB_HIDDEN_A_SORT_DATE),
        })
      );
      globalThis.dispatchEvent(
        new StorageEvent("storage", {
          key: "test:view:web:u:user-1",
          newValue: JSON.stringify({
            ...BLOB_HIDDEN_A_SORT_DATE,
            hiddenColumns: ["b"],
            sortKey: "name",
          }),
        })
      );
    });

    expect(result.current.sortKey).toBe("name");
    expect(result.current.visibleColumns.has("b")).toBe(false);
    expect(result.current.visibleColumns.has("a")).toBe(true);
  });

  it("serializes a local edit after adoption with only the edited field changed, key order intact", () => {
    const { result } = renderAsUser("user-1");

    dispatchStorage(
      "test:view:web:u:user-1",
      JSON.stringify(BLOB_HIDDEN_A_SORT_DATE)
    );

    act(() => result.current.setSort("name"));

    const stored = localStorage.getItem("test:view:web:u:user-1");
    const expected = JSON.stringify({
      window: "30d",
      revealed: true,
      sortKey: "name",
      sortDir: "desc",
      hiddenColumns: ["a"],
      columnOrder: [],
      columnWidths: {},
      pageSize: 25,
    });
    expect(stored).toBe(expected);
  });
  // ISS-9447 D1 x ISS-9568: adoption reads storage, so it is the same
  // unknown-provenance boundary a mount-time restore is. Both regression tests
  // below fail on a merge that routes adoption through the applied state alone:
  // the adopting tab writes back an arrangement with the sibling's newer
  // columns deleted, which is the erasure ISS-9447 exists to stop, reached
  // through a door it did not have when it shipped.
  it("carries an adopted arrangement's unknown column ids back into the next local write", () => {
    const { result } = renderAsUser("user-1");

    dispatchStorage(
      "test:view:web:u:user-1",
      JSON.stringify({
        sortKey: "date",
        sortDir: "desc",
        hiddenColumns: ["a", "from-newer-build"],
        columnOrder: ["b", "also-newer"],
        columnWidths: { b: 240, newer: 180 },
        pageSize: 25,
        window: "30d",
        revealed: true,
      })
    );

    // Not applied: the render path still sees only ids this build can draw.
    expect(result.current.columnWidths).toEqual({ b: 240 });

    act(() => result.current.setSort("name"));

    const stored = JSON.parse(
      localStorage.getItem("test:view:web:u:user-1") ?? "null"
    );
    expect(stored.hiddenColumns).toEqual(["a", "from-newer-build"]);
    expect(stored.columnOrder).toEqual(["b", "also-newer"]);
    expect(stored.columnWidths).toEqual({ b: 240, newer: 180 });
    expect(stored.sortKey).toBe("name");
  });

  it("does not echo a write for an adopted arrangement that carries unknown column ids", () => {
    const { result } = renderAsUser("user-1");
    const setItemSpy = spyOnSetItem();

    dispatchStorage(
      "test:view:web:u:user-1",
      JSON.stringify({
        sortKey: "date",
        sortDir: "desc",
        hiddenColumns: ["a", "from-newer-build"],
        columnOrder: [],
        columnWidths: {},
        pageSize: 25,
        window: "30d",
        revealed: true,
      })
    );

    // The dedupe ref is seeded by the SAME serializer the persist effect runs,
    // carried ids included, so the two compute identical bytes and nothing is
    // written. A serializer that folded the carried ids in on only one of those
    // two paths would differ here and echo.
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(result.current.sortKey).toBe("date");
  });

  it("ignores a remote write that lands before this tab's own edit has flushed", () => {
    const key = "test:view:web:u:user-1";
    const captured: { current: TableViewStore | null } = { current: null };
    function Harness() {
      const value = useTestView("web");
      captured.current = value;
      return (
        <RemoteWriteOnCommit
          payload={JSON.stringify(BLOB_HIDDEN_A_SORT_DATE)}
          storageKey={key}
          when={!value.visibleColumns.has("b")}
        />
      );
    }

    renderComponent(
      <AuthAdapterProvider
        adapter={createStaticAuthAdapter({ isLoaded: true, userId: "user-1" })}
      >
        <Harness />
      </AuthAdapterProvider>
    );
    act(() => captured.current?.toggleColumn("b"));

    // The remote write fired in the same flush that carried "hide b", before the
    // persist effect wrote it. Adopting there would have replaced the edit in
    // memory (`hiddenColumns` back to ["a"], sort to "date") AND seeded the
    // dedupe ref with the remote bytes, so the pending flush would have found
    // nothing to do: gone from screen and never on disk. All three assertions
    // fail without the guard.
    expect(captured.current?.visibleColumns.has("b")).toBe(false);
    expect(captured.current?.sortKey).toBe("name");
    const stored = JSON.parse(localStorage.getItem(key) ?? "null");
    expect(stored.hiddenColumns).toEqual(["b"]);
  });

  it("adopts again once the edit that blocked adoption has been written", () => {
    const { result } = renderAsUser("user-1");

    act(() => result.current.toggleColumn("b"));
    // The persist effect has run inside that `act`, so this tab owes disk
    // nothing — the guard above must not latch.
    dispatchStorage(
      "test:view:web:u:user-1",
      JSON.stringify(BLOB_HIDDEN_A_SORT_DATE)
    );

    expect(result.current.sortKey).toBe("date");
    expect(result.current.visibleColumns.has("a")).toBe(false);
    expect(result.current.visibleColumns.has("b")).toBe(true);
  });

  it("ignores a sessionStorage event carrying this hook's key", () => {
    const { result } = renderAsUser("user-1");
    const setItemSpy = spyOnSetItem();

    // Same origin, same key, WRONG area: a document sharing this tab's session
    // (an iframe) wrote `sessionStorage`. `localStorage` never changed, so there
    // is nothing to adopt. Without the `storageArea` check this reads as a
    // sibling-tab view and is applied.
    act(() => {
      const event = new StorageEvent("storage", {
        key: "test:view:web:u:user-1",
        newValue: JSON.stringify(BLOB_HIDDEN_A_SORT_DATE),
      });
      Object.defineProperty(event, "storageArea", { value: sessionStorage });
      globalThis.dispatchEvent(event);
    });

    expect(result.current.sortKey).toBe("name");
    expect(result.current.visibleColumns.has("a")).toBe(true);
    expect(setItemSpy).not.toHaveBeenCalled();
  });

  it("still adopts an event whose storageArea is localStorage", () => {
    const { result } = renderAsUser("user-1");

    act(() => {
      const event = new StorageEvent("storage", {
        key: "test:view:web:u:user-1",
        newValue: JSON.stringify(BLOB_HIDDEN_A_SORT_DATE),
      });
      Object.defineProperty(event, "storageArea", { value: localStorage });
      globalThis.dispatchEvent(event);
    });

    expect(result.current.sortKey).toBe("date");
  });
});

type TableViewStore = ReturnType<typeof useTestView>;

/**
 * Dispatches ONE remote `storage` write on the first commit where `when` is
 * true, from a CHILD of the hook host. React flushes a child's passive effect
 * before its parent's, so the write lands after the local edit's render has
 * committed but before the parent's persist effect has run — the same gap a
 * real browser opens between a commit and the passive flush that writes it.
 */
function RemoteWriteOnCommit({
  when,
  storageKey,
  payload,
}: {
  when: boolean;
  storageKey: string;
  payload: string;
}) {
  const firedRef = useRef(false);
  useEffect(() => {
    if (!when || firedRef.current) {
      return;
    }
    firedRef.current = true;
    globalThis.dispatchEvent(
      new StorageEvent("storage", { key: storageKey, newValue: payload })
    );
  });
  return null;
}
