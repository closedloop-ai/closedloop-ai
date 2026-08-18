import {
  emptySavedViewCollection,
  type SavedViewCollection,
} from "@repo/design-system/lib/table-saved-views";
import { act, renderHook } from "@testing-library/react";
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
});
