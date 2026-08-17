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
} from "@repo/design-system/lib/table-saved-views";
import { describe, expect, it } from "vitest";

type Arrangement = { sortKey: string; hidden: string[] };

function seed(): SavedViewCollection<Arrangement> {
  return addSavedView(emptySavedViewCollection<Arrangement>(), "Mine", {
    sortKey: "name",
    hidden: ["repo"],
  });
}

describe("table saved views model", () => {
  it("adds a named view carrying its arrangement and makes it active", () => {
    const collection = seed();
    expect(collection.views).toHaveLength(1);
    expect(collection.views[0].name).toBe("Mine");
    expect(collection.views[0].arrangement).toEqual({
      sortKey: "name",
      hidden: ["repo"],
    });
    expect(collection.activeViewId).toBe(collection.views[0].id);
    expect(activeSavedView(collection)?.name).toBe("Mine");
  });

  it("rejects a blank name on create (no-op)", () => {
    const empty = emptySavedViewCollection<Arrangement>();
    const next = addSavedView(empty, "   ", { sortKey: "name", hidden: [] });
    expect(next).toBe(empty);
  });

  it("trims the stored name", () => {
    const next = addSavedView(
      emptySavedViewCollection<Arrangement>(),
      "  Padded  ",
      {
        sortKey: "name",
        hidden: [],
      }
    );
    expect(next.views[0].name).toBe("Padded");
  });

  it("renames an existing view; blank/unknown are no-ops", () => {
    const collection = seed();
    const id = collection.views[0].id;
    const renamed = renameSavedView(collection, id, "Renamed");
    expect(renamed.views[0].name).toBe("Renamed");
    expect(renameSavedView(collection, id, "  ")).toBe(collection);
    expect(renameSavedView(collection, "nope", "X")).toBe(collection);
  });

  it("deletes a view and clears the active id when the active one is removed", () => {
    const collection = seed();
    const id = collection.views[0].id;
    const deleted = deleteSavedView(collection, id);
    expect(deleted.views).toHaveLength(0);
    expect(deleted.activeViewId).toBeNull();
  });

  it("keeps the active id when a non-active view is deleted", () => {
    let collection = seed();
    collection = addSavedView(collection, "Second", {
      sortKey: "repo",
      hidden: [],
    });
    const activeId = collection.activeViewId;
    const firstId = collection.views[0].id;
    const deleted = deleteSavedView(collection, firstId);
    expect(deleted.activeViewId).toBe(activeId);
    expect(deleted.views).toHaveLength(1);
  });

  it("switches the active view, and clamps a stale id to null", () => {
    const collection = seed();
    const id = collection.views[0].id;
    expect(setActiveSavedView(collection, null).activeViewId).toBeNull();
    expect(setActiveSavedView(collection, id).activeViewId).toBe(id);
    expect(setActiveSavedView(collection, "stale").activeViewId).toBeNull();
  });

  it("normalizeSavedViewName returns null for blank", () => {
    expect(normalizeSavedViewName("  ")).toBeNull();
    expect(normalizeSavedViewName(" A ")).toBe("A");
  });

  it("createSavedViewId returns a non-empty unique id", () => {
    const a = createSavedViewId();
    const b = createSavedViewId();
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });

  it("updates an existing view's arrangement in place, keeping id/name/position", () => {
    const collection = seed();
    const id = collection.views[0].id;
    const updated = updateSavedView(collection, id, {
      sortKey: "activity",
      hidden: ["owner"],
    });
    expect(updated.views).toHaveLength(1);
    expect(updated.views[0].id).toBe(id);
    expect(updated.views[0].name).toBe("Mine");
    expect(updated.views[0].arrangement).toEqual({
      sortKey: "activity",
      hidden: ["owner"],
    });
    // Active id is untouched by an update.
    expect(updated.activeViewId).toBe(id);
  });

  it("update is a no-op for a missing id", () => {
    const collection = seed();
    expect(
      updateSavedView(collection, "nope", { sortKey: "x", hidden: [] })
    ).toBe(collection);
  });

  it("never mutates its inputs", () => {
    const collection = seed();
    const before = JSON.stringify(collection);
    addSavedView(collection, "X", { sortKey: "a", hidden: [] });
    deleteSavedView(collection, collection.views[0].id);
    renameSavedView(collection, collection.views[0].id, "Y");
    updateSavedView(collection, collection.views[0].id, {
      sortKey: "z",
      hidden: [],
    });
    setActiveSavedView(collection, null);
    expect(JSON.stringify(collection)).toBe(before);
  });
});
