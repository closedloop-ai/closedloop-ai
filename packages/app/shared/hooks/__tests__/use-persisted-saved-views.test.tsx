import {
  emptySavedViewCollection,
  type SavedViewCollection,
} from "@repo/design-system/lib/table-saved-views";
import {
  act,
  render as renderComponent,
  renderHook,
} from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePersistedSavedViews } from "../use-persisted-saved-views";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

type Arrangement = { sortKey: string; hidden: string[] };

const KEY_PREFIX = "test:saved-views:";

// A permissive parser: keep any object with a `views` array + `activeViewId`,
// else the empty collection. Enough to exercise the store's persistence.
function parse(raw: unknown): SavedViewCollection<Arrangement> | null {
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.views)) {
    return null;
  }
  return {
    views: record.views as SavedViewCollection<Arrangement>["views"],
    activeViewId:
      typeof record.activeViewId === "string" ? record.activeViewId : null,
  };
}

function render(persistKey?: string) {
  return renderHook(() =>
    usePersistedSavedViews<Arrangement>({
      persistKey,
      keyPrefix: KEY_PREFIX,
      parse,
    })
  );
}

function renderWithKey(initialKey?: string) {
  return renderHook(
    ({ persistKey }: { persistKey?: string }) =>
      usePersistedSavedViews<Arrangement>({
        persistKey,
        keyPrefix: KEY_PREFIX,
        parse,
      }),
    { initialProps: { persistKey: initialKey } }
  );
}

describe("usePersistedSavedViews", () => {
  it("starts empty on the default arrangement", () => {
    const { result } = render("surface");
    expect(result.current.views).toHaveLength(0);
    expect(result.current.activeViewId).toBeNull();
  });

  it("create → persists to localStorage and makes the view active", () => {
    const { result } = render("surface");
    act(() => {
      result.current.createView("Mine", { sortKey: "name", hidden: ["repo"] });
    });
    expect(result.current.views).toHaveLength(1);
    expect(result.current.activeViewId).toBe(result.current.views[0].id);

    const stored = JSON.parse(
      localStorage.getItem(`${KEY_PREFIX}surface`) ?? "{}"
    );
    expect(stored.views).toHaveLength(1);
    expect(stored.views[0].name).toBe("Mine");
    expect(stored.views[0].arrangement).toEqual({
      sortKey: "name",
      hidden: ["repo"],
    });
  });

  it("restores a persisted collection on mount", () => {
    const seeded: SavedViewCollection<Arrangement> = {
      views: [
        {
          id: "v1",
          name: "Seeded",
          arrangement: { sortKey: "repo", hidden: [] },
        },
      ],
      activeViewId: "v1",
    };
    localStorage.setItem(`${KEY_PREFIX}surface`, JSON.stringify(seeded));

    const { result } = render("surface");
    expect(result.current.views).toHaveLength(1);
    expect(result.current.views[0].name).toBe("Seeded");
    expect(result.current.activeViewId).toBe("v1");
  });

  it("rename → updates the stored name", () => {
    const { result } = render("surface");
    act(() => {
      result.current.createView("Mine", { sortKey: "name", hidden: [] });
    });
    const id = result.current.views[0].id;
    act(() => result.current.renameView(id, "Renamed"));
    expect(result.current.views[0].name).toBe("Renamed");
    const stored = JSON.parse(
      localStorage.getItem(`${KEY_PREFIX}surface`) ?? "{}"
    );
    expect(stored.views[0].name).toBe("Renamed");
  });

  it("delete → removes the view and clears the active id when it was active", () => {
    const { result } = render("surface");
    act(() => {
      result.current.createView("Mine", { sortKey: "name", hidden: [] });
    });
    const id = result.current.views[0].id;
    act(() => result.current.deleteView(id));
    expect(result.current.views).toHaveLength(0);
    expect(result.current.activeViewId).toBeNull();
  });

  it("selectView returns the target arrangement to apply, or null for default", () => {
    const { result } = render("surface");
    act(() => {
      result.current.createView("A", { sortKey: "name", hidden: ["repo"] });
    });
    const id = result.current.views[0].id;

    let applied: Arrangement | null = null;
    act(() => {
      applied = result.current.selectView(id);
    });
    expect(applied).toEqual({ sortKey: "name", hidden: ["repo"] });
    expect(result.current.activeViewId).toBe(id);

    act(() => {
      applied = result.current.selectView(null);
    });
    expect(applied).toBeNull();
    expect(result.current.activeViewId).toBeNull();
  });

  it("is memory-only (no persistence) without a persistKey", () => {
    const { result } = render(undefined);
    act(() => {
      result.current.createView("Mine", { sortKey: "name", hidden: [] });
    });
    expect(result.current.views).toHaveLength(1);
    expect(localStorage.length).toBe(0);
  });

  it("re-restores the new key's collection on an A→B identity transition without leaking A into B", () => {
    // Seed distinct collections for two identities (e.g. two orgs).
    const seededB: SavedViewCollection<Arrangement> = {
      views: [
        {
          id: "b1",
          name: "Org B View",
          arrangement: { sortKey: "repo", hidden: [] },
        },
      ],
      activeViewId: "b1",
    };
    localStorage.setItem(`${KEY_PREFIX}orgB`, JSON.stringify(seededB));

    const { result, rerender } = renderWithKey("orgA");
    // Create a view under identity A.
    act(() => {
      result.current.createView("Org A View", {
        sortKey: "name",
        hidden: ["repo"],
      });
    });
    expect(result.current.views).toHaveLength(1);
    expect(result.current.views[0].name).toBe("Org A View");

    // Switch identity WITHOUT a remount (org switch keeps the component mounted).
    act(() => rerender({ persistKey: "orgB" }));

    // The store must now reflect B's persisted collection, not A's in-memory one.
    expect(result.current.views).toHaveLength(1);
    expect(result.current.views[0].name).toBe("Org B View");

    // And A's key must be untouched — B's collection was NOT written over A.
    const storedA = JSON.parse(
      localStorage.getItem(`${KEY_PREFIX}orgA`) ?? "{}"
    );
    expect(storedA.views).toHaveLength(1);
    expect(storedA.views[0].name).toBe("Org A View");
    // B's key must not have been clobbered by A's in-memory collection.
    const storedB = JSON.parse(
      localStorage.getItem(`${KEY_PREFIX}orgB`) ?? "{}"
    );
    expect(storedB.views[0].name).toBe("Org B View");
  });

  it("resets to empty when identity changes to a key with no persisted collection", () => {
    const { result, rerender } = renderWithKey("orgA");
    act(() => {
      result.current.createView("Org A View", { sortKey: "name", hidden: [] });
    });
    expect(result.current.views).toHaveLength(1);

    act(() => rerender({ persistKey: "orgFresh" }));
    // A fresh identity starts empty; A's view must not carry over.
    expect(result.current.views).toHaveLength(0);
    expect(result.current.activeViewId).toBeNull();
  });

  it("degrades to empty when the parser rejects the persisted value", () => {
    localStorage.setItem(`${KEY_PREFIX}surface`, "not json{");
    const { result } = render("surface");
    expect(result.current.views).toHaveLength(0);
    expect(result.current.activeViewId).toBeNull();
    expect(emptySavedViewCollection().views).toHaveLength(0);
  });

  it("rolls the mutation back and reports when the write fails (quota / private mode)", () => {
    const onPersistError = vi.fn();
    // First render restores (nothing on disk) and seeds the rollback baseline;
    // only the mutation's write should hit the throwing setItem. Spy on the
    // localStorage INSTANCE — jsdom gives it an own `setItem`, so a prototype
    // spy would not intercept it.
    const setItemSpy = vi
      .spyOn(localStorage, "setItem")
      .mockImplementation(() => {
        throw new DOMException("quota", "QuotaExceededError");
      });

    const { result } = renderHook(() =>
      usePersistedSavedViews<Arrangement>({
        persistKey: "surface",
        keyPrefix: KEY_PREFIX,
        parse,
        onPersistError,
      })
    );

    act(() => {
      result.current.createView("Mine", { sortKey: "name", hidden: [] });
    });

    // The write failed, so the in-memory collection is rolled back to the
    // last-persisted (empty) value — no phantom "saved" row survives — and the
    // failure is surfaced to the feature layer exactly once.
    expect(result.current.views).toHaveLength(0);
    expect(result.current.activeViewId).toBeNull();
    expect(onPersistError).toHaveBeenCalledTimes(1);
    // Nothing durable landed on disk for this key.
    expect(setItemSpy).toHaveBeenCalled();
    setItemSpy.mockRestore();
    expect(localStorage.getItem(`${KEY_PREFIX}surface`)).toBeNull();
  });

  it("adopts a remote view between two flushed local edits, and the next write carries all three (ISS-9568)", () => {
    const { result } = render("surface");
    act(() => {
      result.current.createView("Mine", { sortKey: "name", hidden: [] });
    });
    const stored = JSON.parse(
      localStorage.getItem(`${KEY_PREFIX}surface`) ?? "{}"
    );
    const withTheirs = {
      views: [
        ...stored.views,
        {
          id: "theirs-1",
          name: "Theirs",
          arrangement: { sortKey: "repo", hidden: [] },
        },
      ],
      activeViewId: stored.activeViewId,
    };

    act(() => {
      globalThis.dispatchEvent(
        new StorageEvent("storage", {
          key: `${KEY_PREFIX}surface`,
          newValue: JSON.stringify(withTheirs),
        })
      );
    });

    act(() => {
      result.current.createView("Ours", { sortKey: "owner", hidden: [] });
    });

    const finalStored = JSON.parse(
      localStorage.getItem(`${KEY_PREFIX}surface`) ?? "{}"
    );
    const names = finalStored.views.map((view: { name: string }) => view.name);
    expect(names).toEqual(expect.arrayContaining(["Mine", "Theirs", "Ours"]));
  });

  it("ignores a remote write that lands before this tab's own mutation has flushed (ISS-9568)", () => {
    const key = `${KEY_PREFIX}surface`;
    const theirs = JSON.stringify({
      activeViewId: null,
      views: [
        {
          arrangement: { hidden: [], sortKey: "repo" },
          id: "theirs-1",
          name: "Theirs",
        },
      ],
    });

    const captured: { current: SavedViewsStore | null } = { current: null };
    function Harness() {
      const value = usePersistedSavedViews<Arrangement>({
        keyPrefix: KEY_PREFIX,
        parse,
        persistKey: "surface",
      });
      captured.current = value;
      return (
        <RemoteWriteOnCommit
          payload={theirs}
          storageKey={key}
          when={value.views.some((view) => view.name === "Mine")}
        />
      );
    }

    renderComponent(<Harness />);
    act(() => {
      captured.current?.createView("Mine", { hidden: [], sortKey: "name" });
    });

    // The remote write fired in the same flush that carried "Mine", before the
    // persist effect wrote it. Adopting there would have replaced "Mine" in
    // memory and seeded the write-back baseline to the adopted collection, so
    // the pending flush would have found nothing to do: gone from memory and
    // never on disk. Both assertions fail without the guard.
    expect(captured.current?.views.map((view) => view.name)).toEqual(["Mine"]);
    const stored = JSON.parse(localStorage.getItem(key) ?? "{}");
    expect(stored.views.map((view: { name: string }) => view.name)).toEqual([
      "Mine",
    ]);
  });

  it("adopts a remote view without writing it back, and counts the adoption", () => {
    const { result } = render("surface");
    act(() => {
      result.current.createView("Mine", { sortKey: "name", hidden: [] });
    });
    const stored = JSON.parse(
      localStorage.getItem(`${KEY_PREFIX}surface`) ?? "{}"
    );
    const withTheirs = {
      views: [
        ...stored.views,
        {
          id: "theirs-1",
          name: "Theirs",
          arrangement: { sortKey: "repo", hidden: [] },
        },
      ],
      activeViewId: stored.activeViewId,
    };
    const setItemSpy = vi.spyOn(localStorage, "setItem");
    const callsBefore = setItemSpy.mock.calls.length;

    act(() => {
      globalThis.dispatchEvent(
        new StorageEvent("storage", {
          key: `${KEY_PREFIX}surface`,
          newValue: JSON.stringify(withTheirs),
        })
      );
    });

    expect(result.current.views.map((view) => view.name)).toEqual(
      expect.arrayContaining(["Theirs"])
    );
    expect(setItemSpy.mock.calls.length).toBe(callsBefore);
    expect(result.current.adoptionCount).toBe(1);
  });

  it("rolls a failed local write back to the adopted collection, not the pre-adoption one", () => {
    const onPersistError = vi.fn();
    const { result } = renderHook(() =>
      usePersistedSavedViews<Arrangement>({
        persistKey: "surface",
        keyPrefix: KEY_PREFIX,
        parse,
        onPersistError,
      })
    );
    act(() => {
      result.current.createView("Mine", { sortKey: "name", hidden: [] });
    });
    const stored = JSON.parse(
      localStorage.getItem(`${KEY_PREFIX}surface`) ?? "{}"
    );
    const withTheirs = {
      views: [
        ...stored.views,
        {
          id: "theirs-1",
          name: "Theirs",
          arrangement: { sortKey: "repo", hidden: [] },
        },
      ],
      activeViewId: stored.activeViewId,
    };
    act(() => {
      globalThis.dispatchEvent(
        new StorageEvent("storage", {
          key: `${KEY_PREFIX}surface`,
          newValue: JSON.stringify(withTheirs),
        })
      );
    });
    expect(result.current.views.map((view) => view.name)).toEqual(
      expect.arrayContaining(["Theirs"])
    );

    const setItemSpy = vi
      .spyOn(localStorage, "setItem")
      .mockImplementation(() => {
        throw new DOMException("quota", "QuotaExceededError");
      });

    act(() => {
      result.current.createView("Ours", { sortKey: "owner", hidden: [] });
    });

    expect(onPersistError).toHaveBeenCalledTimes(1);
    const names = result.current.views.map((view) => view.name);
    expect(names).toEqual(expect.arrayContaining(["Mine", "Theirs"]));
    expect(names).not.toContain("Ours");
    setItemSpy.mockRestore();
  });

  it("ignores a storage event whose newValue is null", () => {
    const { result } = render("surface");
    act(() => {
      result.current.createView("Mine", { sortKey: "name", hidden: [] });
    });
    const before = result.current.views;
    const setItemSpy = vi.spyOn(localStorage, "setItem");
    const callsBefore = setItemSpy.mock.calls.length;

    act(() => {
      globalThis.dispatchEvent(
        new StorageEvent("storage", {
          key: `${KEY_PREFIX}surface`,
          newValue: null,
        })
      );
    });

    expect(result.current.views).toEqual(before);
    expect(setItemSpy.mock.calls.length).toBe(callsBefore);
    expect(result.current.adoptionCount).toBe(0);
  });

  it("ignores a storage event whose newValue is not valid JSON", () => {
    const { result } = render("surface");
    act(() => {
      result.current.createView("Mine", { sortKey: "name", hidden: [] });
    });
    const before = result.current.views;
    const setItemSpy = vi.spyOn(localStorage, "setItem");
    const callsBefore = setItemSpy.mock.calls.length;

    act(() => {
      globalThis.dispatchEvent(
        new StorageEvent("storage", {
          key: `${KEY_PREFIX}surface`,
          newValue: "not json{",
        })
      );
    });

    expect(result.current.views).toEqual(before);
    expect(setItemSpy.mock.calls.length).toBe(callsBefore);
    expect(result.current.adoptionCount).toBe(0);
  });

  it("ignores a storage event whose newValue the parser rejects", () => {
    const { result } = render("surface");
    act(() => {
      result.current.createView("Mine", { sortKey: "name", hidden: [] });
    });
    const before = result.current.views;
    const setItemSpy = vi.spyOn(localStorage, "setItem");
    const callsBefore = setItemSpy.mock.calls.length;

    act(() => {
      globalThis.dispatchEvent(
        new StorageEvent("storage", {
          key: `${KEY_PREFIX}surface`,
          newValue: JSON.stringify({ nope: true }),
        })
      );
    });

    expect(result.current.views).toEqual(before);
    expect(setItemSpy.mock.calls.length).toBe(callsBefore);
    expect(result.current.adoptionCount).toBe(0);
  });

  it("ignores a storage event when the parser throws", () => {
    const throwingParse = (): SavedViewCollection<Arrangement> | null => {
      throw new Error("boom");
    };
    const { result } = renderHook(() =>
      usePersistedSavedViews<Arrangement>({
        persistKey: "surface",
        keyPrefix: KEY_PREFIX,
        parse: throwingParse,
      })
    );
    const setItemSpy = vi.spyOn(localStorage, "setItem");
    const callsBefore = setItemSpy.mock.calls.length;

    act(() => {
      globalThis.dispatchEvent(
        new StorageEvent("storage", {
          key: `${KEY_PREFIX}surface`,
          newValue: JSON.stringify({ views: [], activeViewId: null }),
        })
      );
    });

    expect(result.current.views).toHaveLength(0);
    expect(setItemSpy.mock.calls.length).toBe(callsBefore);
    expect(result.current.adoptionCount).toBe(0);
  });

  it("never adopts a remote write on a memory-only surface (no persistKey)", () => {
    const { result } = render(undefined);

    act(() => {
      globalThis.dispatchEvent(
        new StorageEvent("storage", {
          key: `${KEY_PREFIX}undefined`,
          newValue: JSON.stringify({
            views: [
              {
                id: "x",
                name: "X",
                arrangement: { sortKey: "name", hidden: [] },
              },
            ],
            activeViewId: "x",
          }),
        })
      );
    });
    expect(result.current.views).toHaveLength(0);
    expect(result.current.adoptionCount).toBe(0);

    act(() => {
      globalThis.dispatchEvent(
        new StorageEvent("storage", {
          key: `${KEY_PREFIX}surface`,
          newValue: JSON.stringify({
            views: [
              {
                id: "y",
                name: "Y",
                arrangement: { sortKey: "name", hidden: [] },
              },
            ],
            activeViewId: "y",
          }),
        })
      );
    });
    expect(result.current.views).toHaveLength(0);
    expect(result.current.adoptionCount).toBe(0);
  });

  it("stops listening for storage events after unmount", () => {
    const { result, unmount } = render("surface");
    act(() => {
      result.current.createView("Mine", { sortKey: "name", hidden: [] });
    });
    const storedBefore = localStorage.getItem(`${KEY_PREFIX}surface`);
    unmount();

    expect(() => {
      act(() => {
        globalThis.dispatchEvent(
          new StorageEvent("storage", {
            key: `${KEY_PREFIX}surface`,
            newValue: JSON.stringify({ views: [], activeViewId: null }),
          })
        );
      });
    }).not.toThrow();
    expect(localStorage.getItem(`${KEY_PREFIX}surface`)).toBe(storedBefore);
  });

  it("only adopts a storage event on the currently active key after an in-place identity change", () => {
    const { result, rerender } = renderWithKey("orgA");
    act(() => {
      result.current.createView("A View", { sortKey: "name", hidden: [] });
    });

    act(() => rerender({ persistKey: "orgB" }));
    expect(result.current.views).toHaveLength(0);

    act(() => {
      globalThis.dispatchEvent(
        new StorageEvent("storage", {
          key: `${KEY_PREFIX}orgA`,
          newValue: JSON.stringify({
            views: [
              {
                id: "ignored",
                name: "Ignored",
                arrangement: { sortKey: "name", hidden: [] },
              },
            ],
            activeViewId: null,
          }),
        })
      );
    });
    expect(result.current.views).toHaveLength(0);

    act(() => {
      globalThis.dispatchEvent(
        new StorageEvent("storage", {
          key: `${KEY_PREFIX}orgB`,
          newValue: JSON.stringify({
            views: [
              {
                id: "b-adopt",
                name: "B Adopted",
                arrangement: { sortKey: "name", hidden: [] },
              },
            ],
            activeViewId: "b-adopt",
          }),
        })
      );
    });
    expect(result.current.views).toHaveLength(1);
    expect(result.current.views[0].name).toBe("B Adopted");
  });
});

/**
 * Dispatches ONE remote `storage` write on the first commit where `when` is
 * true, from a CHILD of the hook host. React flushes a child's passive effect
 * before its parent's, so the write lands after the mutation's render has
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

type SavedViewsStore = ReturnType<typeof usePersistedSavedViews<Arrangement>>;
