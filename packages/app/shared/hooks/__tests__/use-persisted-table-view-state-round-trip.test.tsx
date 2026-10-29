import { act } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "./persisted-table-view-state.test-support";

afterEach(() => {
  localStorage.clear();
});

/**
 * ISS-9447 M4. Pins the restore->write round trip against STORAGE, not against
 * the hook's in-memory return.
 *
 * Added by M0 asserting the ERASURE, and flipped here: unknown persisted column
 * ids are now preserved rather than erased (ISS-9447 D1); the previous
 * expectation encoded a data-loss path. The in-memory half is unchanged and
 * still asserted above - an id this build has no column for is still not
 * applied, because the applied state is what the render path reads.
 *
 * Its own file because the sibling suite is at the repo's file-size ceiling; both
 * drive the ONE configuration in `persisted-table-view-state.test-support`.
 */
describe("usePersistedTableViewState - the persisted round trip (ISS-9447 M4)", () => {
  const STORAGE_KEY = "test:view:web";

  function seedSavedView(view: Record<string, unknown>) {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        hiddenColumns: [],
        sortDir: "asc",
        sortKey: "name",
        ...view,
      })
    );
  }

  function readSavedView(): Record<string, unknown> {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  }

  it("keeps an unrecognized columnOrder id IN STORAGE across a mount", () => {
    seedSavedView({ columnOrder: ["c", "future-column", "a"] });

    // No edit, no unmount, no user action - restoring was the whole trigger of
    // the loss, so it is the whole trigger of the proof.
    const { result } = render("web");

    // Carried, so a build that has the column again still has it to restore.
    // Appended after the applied ids, the rule `mergeColumnOrder` already
    // states: a slot cannot be held open for a column this build never draws.
    expect(readSavedView().columnOrder).toEqual(["c", "a", "future-column"]);
    // Carried is not applied: it stays out of the arrangement the table reads.
    expect(result.current.columnOrder).toEqual(["c", "a"]);
  });

  it("keeps an unrecognized columnWidths entry IN STORAGE across a mount", () => {
    seedSavedView({ columnWidths: { a: 120, "future-column": 240 } });

    const { result } = render("web");

    // Keyed by id rather than positional, so this is the same preservation
    // reached by a different path, not a consequence of the order case above.
    expect(readSavedView().columnWidths).toEqual({
      a: 120,
      "future-column": 240,
    });
    expect(result.current.columnWidths).toEqual({ a: 120 });
  });

  it("keeps carrying an unrecognized id through an edit to the same axis", () => {
    seedSavedView({
      columnOrder: ["c", "future-column", "a"],
      hiddenColumns: ["b", "future-column"],
    });
    const { result } = render("web");

    act(() => result.current.setColumnOrder(["a", "c"]));
    act(() => result.current.toggleColumn("c"));

    // The reader rearranging what they CAN see must not cost them what they
    // cannot: the edit rewrites the applied half and the carried half rides.
    expect(readSavedView().columnOrder).toEqual(["a", "c", "future-column"]);
    expect(readSavedView().hiddenColumns).toEqual(["b", "c", "future-column"]);
  });

  it("drops the carried ids on resetColumns, which the reader asked for", () => {
    seedSavedView({
      columnOrder: ["c", "future-column", "a"],
      columnWidths: { a: 120, "future-column": 240 },
      hiddenColumns: ["future-column"],
    });
    const { result } = render("web");

    act(() => result.current.resetColumns());

    // "Back to how the surface ships" is a choice the reader made and can see,
    // which is the whole difference between it and the mount-time erasure D1
    // removes. Carrying ids through a reset would make the reset a lie.
    expect(readSavedView().columnOrder).toEqual([]);
    expect(readSavedView().columnWidths).toEqual({});
    expect(readSavedView().hiddenColumns).toEqual([]);
  });

  it("keeps carrying the unrecognized ids across applyView, on every axis", () => {
    seedSavedView({
      columnOrder: ["c", "future-column", "a"],
      columnWidths: { a: 120, "future-column": 240 },
      hiddenColumns: ["future-column"],
    });
    const { result } = render("web");

    act(() =>
      result.current.applyView({
        // Only ids this build knows, which is the only shape a caller can
        // produce: a saved arrangement is captured FROM the capturing build's
        // own column ids (`use-branch-view-state.ts`), so one cannot hold an id
        // outside them. The case this replaced applied an
        // "other-future-column" no caller could ever pass, which is exactly why
        // the suite did not see the carried ids being dropped here.
        columnOrder: ["b", "a"],
        extras: { revealed: false, window: "7d" },
        hiddenColumns: ["c"],
        sortDir: "asc",
        sortKey: "name",
      })
    );

    // The view's arrangement is applied, and the carried ids are still beside
    // it. An arrangement captured on a build that could not see
    // `future-column` says nothing about it, so "this view did not mention it"
    // is not "the reader wants it gone" - switching views, selecting the
    // default view included, must not be a second door to the mount-time
    // erasure D1 removes.
    expect(readSavedView().columnOrder).toEqual(["b", "a", "future-column"]);
    expect(readSavedView().hiddenColumns).toEqual(["c", "future-column"]);
    expect(readSavedView().columnWidths).toEqual({
      a: 120,
      "future-column": 240,
    });
  });
});
