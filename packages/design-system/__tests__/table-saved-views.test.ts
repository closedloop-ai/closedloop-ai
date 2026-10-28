import {
  activeSavedView,
  addSavedView,
  createSavedViewId,
  deleteSavedView,
  emptySavedViewCollection,
  normalizeSavedViewName,
  renameSavedView,
  type SavedViewCollection,
  setActiveSavedView,
  updateSavedView,
} from "@closedloop-ai/design-system/lib/table-saved-views";
import { afterEach, describe, expect, it, vi } from "vitest";

const VIEW_PATTERN = /^view-/;
const VIEW_2_PATTERN = /^view-[a-z0-9]+-[a-z0-9]+$/;

/**
 * ISS-7349. `lib/table-saved-views.ts` owns the create/rename/switch/delete
 * transforms behind named table arrangements. Every function in it has a
 * documented NO-OP arm — a blank name, an id that is not in the collection, a
 * stale active id — and those arms are the whole reason the module is pure
 * functions rather than inline setState calls. A story mounting the switcher
 * exercises the success path; nothing mounts a collection whose active id
 * points at a view that was deleted in another tab, which is exactly the state
 * `setActiveSavedView` exists to survive.
 */

type Arrangement = { columnOrder: string[] };

const ARRANGEMENT: Arrangement = { columnOrder: ["name", "status"] };
const OTHER_ARRANGEMENT: Arrangement = { columnOrder: ["status", "name"] };

function collectionOf(
  views: SavedViewCollection<Arrangement>["views"],
  activeViewId: string | null = null
): SavedViewCollection<Arrangement> {
  return { views, activeViewId };
}

const VIEW_A = { id: "a", name: "Mine", arrangement: ARRANGEMENT };
const VIEW_B = { id: "b", name: "Team", arrangement: OTHER_ARRANGEMENT };

describe("emptySavedViewCollection", () => {
  it("starts with no views and on the default arrangement", () => {
    expect(emptySavedViewCollection()).toEqual({
      views: [],
      activeViewId: null,
    });
  });

  it("returns a fresh object each call so callers cannot share state", () => {
    expect(emptySavedViewCollection()).not.toBe(emptySavedViewCollection());
  });
});

describe("createSavedViewId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    // unstubAllGlobals does not undo vi.spyOn; Date.now and Math.random are
    // spied below and would stay pinned for every later suite in this file.
    vi.restoreAllMocks();
  });

  it("prefers crypto.randomUUID when it is available", () => {
    const randomUUID = vi.fn(() => "uuid-from-crypto");
    vi.stubGlobal("crypto", { randomUUID });

    expect(createSavedViewId()).toBe("uuid-from-crypto");
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  it("degrades to a timestamp+random id where crypto is absent", () => {
    // The desktop renderer and browsers both have it; the fallback is the
    // "never throw" floor for any host that does not.
    //
    // Both sources are pinned. Math.random() is allowed to return exactly 0,
    // whose base-36 form is "0" — sliced from index 2 that yields an EMPTY
    // suffix, so an unpinned run fails this shape roughly never and then once.
    vi.stubGlobal("crypto", undefined);
    vi.spyOn(Date, "now").mockReturnValue(1_755_000_000_000);
    vi.spyOn(Math, "random").mockReturnValue(0.123_456_789);

    expect(createSavedViewId()).toMatch(VIEW_2_PATTERN);
  });

  it("still produces a well-formed id when Math.random returns exactly 0", () => {
    // The degenerate draw the pinned case above exists to stop being a
    // coin-flip: "0".slice(2) is "", so the id must not end at the separator.
    vi.stubGlobal("crypto", undefined);
    vi.spyOn(Date, "now").mockReturnValue(1_755_000_000_000);
    vi.spyOn(Math, "random").mockReturnValue(0);

    // Pins current behavior. It looks odd because the random segment collapses
    // to nothing, leaving a trailing separator and dropping the whole
    // collision-resistance half of the id — the property the fallback exists
    // for. Main does it anyway and a coverage PR does not change behavior.
    expect(createSavedViewId()).toBe("view-me8hoqo0-");
  });

  it("degrades when crypto exists but carries no randomUUID", () => {
    vi.stubGlobal("crypto", {});

    expect(createSavedViewId()).toMatch(VIEW_PATTERN);
  });
});

describe("normalizeSavedViewName", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeSavedViewName("  My view  ")).toBe("My view");
  });

  it.each([
    ["an empty string", ""],
    ["whitespace only", "   \t\n "],
  ])("returns null for %s", (_label, raw) => {
    expect(normalizeSavedViewName(raw)).toBeNull();
  });
});

describe("addSavedView", () => {
  it("appends the new view and makes it active", () => {
    const before = collectionOf([VIEW_A]);

    const next = addSavedView(before, "Fresh", OTHER_ARRANGEMENT);

    expect(next.views).toHaveLength(2);
    expect(next.views[1]?.name).toBe("Fresh");
    expect(next.views[1]?.arrangement).toBe(OTHER_ARRANGEMENT);
    expect(next.activeViewId).toBe(next.views[1]?.id);
    expect(before.views).toHaveLength(1);
  });

  it("trims the supplied name before storing it", () => {
    const next = addSavedView(
      emptySavedViewCollection<Arrangement>(),
      "  Padded  ",
      ARRANGEMENT
    );

    expect(next.views[0]?.name).toBe("Padded");
  });

  it("is a no-op for a blank name rather than persisting an unnamed view", () => {
    const before = collectionOf([VIEW_A], "a");

    expect(addSavedView(before, "   ", ARRANGEMENT)).toBe(before);
  });
});

describe("renameSavedView", () => {
  it("renames the matching view and leaves its siblings alone", () => {
    const before = collectionOf([VIEW_A, VIEW_B], "a");

    const next = renameSavedView(before, "a", "Renamed");

    expect(next.views[0]?.name).toBe("Renamed");
    expect(next.views[1]).toEqual(VIEW_B);
    expect(next.activeViewId).toBe("a");
    expect(before.views[0]?.name).toBe("Mine");
  });

  it("is a no-op for an id that is not in the collection", () => {
    const before = collectionOf([VIEW_A]);

    expect(renameSavedView(before, "ghost", "Renamed")).toBe(before);
  });

  it("is a no-op for a blank name", () => {
    const before = collectionOf([VIEW_A]);

    expect(renameSavedView(before, "a", "  ")).toBe(before);
  });
});

describe("deleteSavedView", () => {
  it("removes the view and clears the active id when it was active", () => {
    // The whole point of the fallback: no dangling id may survive a delete.
    const before = collectionOf([VIEW_A, VIEW_B], "a");

    const next = deleteSavedView(before, "a");

    expect(next.views).toEqual([VIEW_B]);
    expect(next.activeViewId).toBeNull();
  });

  it("preserves an unrelated active id", () => {
    const before = collectionOf([VIEW_A, VIEW_B], "b");

    expect(deleteSavedView(before, "a").activeViewId).toBe("b");
  });

  it("is a no-op for an id that is not in the collection", () => {
    const before = collectionOf([VIEW_A], "a");

    expect(deleteSavedView(before, "ghost")).toBe(before);
  });
});

describe("updateSavedView", () => {
  it("overwrites the arrangement while keeping id, name, and position", () => {
    const before = collectionOf([VIEW_A, VIEW_B], "a");

    const next = updateSavedView(before, "a", OTHER_ARRANGEMENT);

    expect(next.views[0]).toEqual({
      id: "a",
      name: "Mine",
      arrangement: OTHER_ARRANGEMENT,
    });
    expect(next.views[1]).toEqual(VIEW_B);
    expect(before.views[0]?.arrangement).toBe(ARRANGEMENT);
  });

  it("is a no-op for an id that is not in the collection", () => {
    const before = collectionOf([VIEW_A]);

    expect(updateSavedView(before, "ghost", OTHER_ARRANGEMENT)).toBe(before);
  });
});

describe("setActiveSavedView", () => {
  it("switches to an existing view", () => {
    const before = collectionOf([VIEW_A, VIEW_B], "a");

    expect(setActiveSavedView(before, "b").activeViewId).toBe("b");
  });

  it("switches back to the default arrangement for null", () => {
    const before = collectionOf([VIEW_A], "a");

    expect(setActiveSavedView(before, null).activeViewId).toBeNull();
  });

  it("clears the active id when the target view does not exist", () => {
    // A stale id (deleted in another tab, or a persisted blob predating a
    // delete) must never leave the switcher pointing at a missing view.
    const before = collectionOf([VIEW_A], "a");

    expect(setActiveSavedView(before, "ghost").activeViewId).toBeNull();
  });

  it("never mutates the source collection", () => {
    const before = collectionOf([VIEW_A], "a");

    setActiveSavedView(before, null);

    expect(before.activeViewId).toBe("a");
  });
});

describe("activeSavedView", () => {
  it("returns null when on the default arrangement", () => {
    expect(activeSavedView(collectionOf([VIEW_A], null))).toBeNull();
  });

  it("returns the matching view", () => {
    expect(activeSavedView(collectionOf([VIEW_A, VIEW_B], "b"))).toEqual(
      VIEW_B
    );
  });

  it("returns null when the active id names a view that is gone", () => {
    // Reads must not throw on a collection that setActiveSavedView has not yet
    // had a chance to repair.
    expect(activeSavedView(collectionOf([VIEW_A], "ghost"))).toBeNull();
  });
});

/**
 * ISS-9565. Every transform in this module documents "Returns a new collection;
 * inputs are never mutated". Four of the five per-function blocks above already
 * assert something about the SOURCE collection after the call, so each covers
 * its own transform; `deleteSavedView` was the one that only ever read the
 * returned value.
 *
 * What no single block can state is the invariant across all five at once, and
 * that is what this case is for: it is the assertion a sixth transform, or a
 * refactor that reaches for `push`/`splice` in any of them, has to get past.
 *
 * It lives here rather than beside a consumer because the module is this
 * package's. It previously sat in
 * `packages/app/shared/lib/__tests__/table-saved-views.test.ts`, a copy of this
 * file that ran the same pure model from a package that does not own it, and
 * whose only unique coverage was this one case.
 */
describe("transform immutability", () => {
  it("leaves the source collection byte-identical across every transform", () => {
    const source = collectionOf([VIEW_A, VIEW_B], "a");
    const before = JSON.stringify(source);

    addSavedView(source, "Added", ARRANGEMENT);
    renameSavedView(source, "a", "Renamed");
    updateSavedView(source, "a", OTHER_ARRANGEMENT);
    deleteSavedView(source, "a");
    setActiveSavedView(source, "b");

    expect(JSON.stringify(source)).toBe(before);
  });
});
