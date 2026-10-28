/**
 * The branches of the shared row-selection contract that a rendered grid cannot
 * easily reach (ISS-8490).
 *
 * The end-to-end behavior — Shift-click, Shift+Arrow, Space, Ctrl/Cmd+A — is
 * asserted through real key and pointer events in
 * `apps/storybook/stories/grid-table-v2.stories.tsx` and the generic-artifact
 * keyboard suite, and is deliberately NOT re-derived here. What is here is the
 * anchor bookkeeping those paths depend on and cannot isolate: an anchor the
 * current render no longer paints, and an anchor that must SURVIVE a range so a
 * second extension still measures from the origin — plus the two gestures they
 * cannot reach through this entry point: a modifier click onto a drawn range,
 * and Ctrl/Cmd held together with Shift, which pins which of the two branches
 * in `resolveGridRowSelection` reads the chord first (ISS-9461).
 */

import {
  EMPTY_GRID_ROW_SELECTION,
  type GridRowSelection,
  reconcileGridRowSelection,
  resolveGridRowSelection,
  selectAllGridRows,
  toggleGridRowSelection,
} from "@closedloop-ai/design-system/lib/grid-table-v2-selection";
import { describe, expect, it } from "vitest";

const RENDERED = ["r1", "r2", "r3", "r4"];
const PLAIN = { ctrlKey: false, metaKey: false, shiftKey: false };
const SHIFT = { ctrlKey: false, metaKey: false, shiftKey: true };
const TOGGLE = { ctrlKey: true, metaKey: false, shiftKey: false };
const META_TOGGLE = { ctrlKey: false, metaKey: true, shiftKey: false };

function selectionOf(state: GridRowSelection): string[] {
  return [...state.selectedIds];
}

describe("resolveGridRowSelection anchor semantics (ISS-9461)", () => {
  it("keeps the anchor across a range, so a second extension still measures from the origin", () => {
    const anchored = resolveGridRowSelection(
      EMPTY_GRID_ROW_SELECTION,
      "r2",
      PLAIN,
      RENDERED
    );
    const firstRange = resolveGridRowSelection(anchored, "r3", SHIFT, RENDERED);
    expect(selectionOf(firstRange)).toEqual(["r2", "r3"]);

    // Re-anchoring on each range would make this measure r3→r4 and drop r2.
    const secondRange = resolveGridRowSelection(
      firstRange,
      "r4",
      SHIFT,
      RENDERED
    );
    expect(selectionOf(secondRange)).toEqual(["r2", "r3", "r4"]);
    expect(secondRange.anchorId).toBe("r2");
  });

  it("shrinks a range back toward the anchor rather than accumulating rows", () => {
    const anchored = resolveGridRowSelection(
      EMPTY_GRID_ROW_SELECTION,
      "r1",
      PLAIN,
      RENDERED
    );
    const wide = resolveGridRowSelection(anchored, "r4", SHIFT, RENDERED);
    const narrowed = resolveGridRowSelection(wide, "r2", SHIFT, RENDERED);

    expect(selectionOf(narrowed)).toEqual(["r1", "r2"]);
  });

  it("re-anchors on a toggle, so the next range extends from the row just toggled", () => {
    const clicked = resolveGridRowSelection(
      EMPTY_GRID_ROW_SELECTION,
      "r1",
      PLAIN,
      RENDERED
    );
    const toggled = resolveGridRowSelection(clicked, "r3", TOGGLE, RENDERED);
    expect(selectionOf(toggled)).toEqual(["r1", "r3"]);

    expect(
      selectionOf(resolveGridRowSelection(toggled, "r4", SHIFT, RENDERED))
    ).toEqual(["r3", "r4"]);
  });
});

describe("resolveGridRowSelection — an anchor the render no longer paints", () => {
  it("falls back to selecting only the target instead of an arbitrary span", () => {
    const anchored = resolveGridRowSelection(
      EMPTY_GRID_ROW_SELECTION,
      "r1",
      PLAIN,
      RENDERED
    );
    // A filter, a page change, or a collapsed group dropped the anchor row. An
    // implementation that let `indexOf` return -1 stand would slice from the
    // list's head and sweep in rows the user never anchored on.
    const afterFilter = ["r3", "r4"];

    const extended = resolveGridRowSelection(
      anchored,
      "r4",
      SHIFT,
      afterFilter
    );

    expect(selectionOf(extended)).toEqual(["r4"]);
    expect(extended.anchorId).toBe("r4");
  });

  it("falls back the same way when no row has ever been anchored", () => {
    const extended = resolveGridRowSelection(
      EMPTY_GRID_ROW_SELECTION,
      "r3",
      SHIFT,
      RENDERED
    );

    expect(selectionOf(extended)).toEqual(["r3"]);
    expect(extended.anchorId).toBe("r3");
  });
});

/**
 * ISS-9461. The toggle-then-range direction is covered above by "re-anchors on
 * a toggle"; this is its inverse.
 */
describe("resolveGridRowSelection — a modifier click on top of a drawn range", () => {
  // Both halves of the Ctrl/Cmd chord, because the two reach the toggle branch
  // through an `||` that either side alone leaves green: asserted on Ctrl only,
  // a regression to reading `ctrlKey` and dropping `metaKey` costs every Mac
  // reader this gesture and nothing in the repo notices. The Meta coverage that
  // already exists is additive-only, so it cannot stand in for the DESELECTING
  // half below (davetho review).
  it.each([
    ["Ctrl", TOGGLE],
    ["Cmd", META_TOGGLE],
  ] as const)(
    "takes a row out of the range under %s, leaves the rest standing, and re-anchors on the row it removed",
    (_name, toggle) => {
      const anchored = resolveGridRowSelection(
        EMPTY_GRID_ROW_SELECTION,
        "r1",
        PLAIN,
        RENDERED
      );
      const drawn = resolveGridRowSelection(anchored, "r3", SHIFT, RENDERED);
      expect(selectionOf(drawn)).toEqual(["r1", "r2", "r3"]);

      // The only route to the DESELECTING half of a toggle through this entry
      // point; bare Space reaches `toggleGridRowSelection` directly.
      const subtracted = resolveGridRowSelection(drawn, "r2", toggle, RENDERED);

      expect(selectionOf(subtracted)).toEqual(["r1", "r3"]);
      // Re-anchoring on the adding half alone would leave this at r1.
      expect(subtracted.anchorId).toBe("r2");
    }
  );

  // The chord itself, which nothing else in this repo ever holds down at once:
  // every other case here is SHIFT with ctrl/meta false, or a toggle with shift
  // false. That leaves the ORDER of the two branches in
  // `resolveGridRowSelection` unpinned — move `resolveRange` below the
  // ctrl/meta branch and the whole suite stays green while Ctrl+Shift-click
  // quietly stops extending and starts flipping one row (marisolashgrove review).
  it.each([
    ["Ctrl", { ctrlKey: true, metaKey: false, shiftKey: true }],
    ["Cmd", { ctrlKey: false, metaKey: true, shiftKey: true }],
  ] as const)(
    "lets the range win when %s and Shift are held together",
    (_name, chord) => {
      const anchored = resolveGridRowSelection(
        EMPTY_GRID_ROW_SELECTION,
        "r1",
        PLAIN,
        RENDERED
      );

      const extended = resolveGridRowSelection(anchored, "r3", chord, RENDERED);

      // Under the toggle branch this would be ["r1", "r3"] anchored on r3.
      expect(selectionOf(extended)).toEqual(["r1", "r2", "r3"]);
      expect(extended.anchorId).toBe("r1");
    }
  );
});

describe("toggleGridRowSelection and selectAllGridRows", () => {
  it("flips one row without disturbing the rest of the selection", () => {
    const both = toggleGridRowSelection(
      toggleGridRowSelection(EMPTY_GRID_ROW_SELECTION, "r1"),
      "r3"
    );

    expect(selectionOf(toggleGridRowSelection(both, "r1"))).toEqual(["r3"]);
  });

  it("anchors select-all on the first rendered row", () => {
    const all = selectAllGridRows(RENDERED);
    expect(selectionOf(all)).toEqual(RENDERED);

    // Without that anchor the very next Shift+Arrow would replace the whole
    // select-all with a single row.
    expect(
      selectionOf(resolveGridRowSelection(all, "r2", SHIFT, RENDERED))
    ).toEqual(["r1", "r2"]);
  });

  it("leaves the anchor null when there is nothing rendered to select", () => {
    expect(selectAllGridRows([])).toEqual(EMPTY_GRID_ROW_SELECTION);
  });
});

/**
 * ISS-9574. The rule that runs when the ROWS move rather than when the reader
 * acts. Its list argument is the current visible row set: the host's rows after
 * filtering, paging and live changes, or the post-collapse set the grid reports
 * through `onRenderedItemsChange`.
 *
 * Every case below drives `reconcileGridRowSelection` directly. What it CANNOT
 * prove is that a host calls it; `use-grid-row-selection.test.ts` and the
 * Generic Artifact reconciliation suites own that half at the current shared
 * and production boundaries.
 */
describe("reconcileGridRowSelection (ISS-9574)", () => {
  it("drops a selected row the current row set no longer contains", () => {
    const selection: GridRowSelection = {
      anchorId: "r1",
      selectedIds: new Set(["r1", "r2", "r3"]),
    };

    const reconciled = reconcileGridRowSelection(selection, ["r1", "r3"]);

    expect(selectionOf(reconciled)).toEqual(["r1", "r3"]);
    expect(reconciled.anchorId).toBe("r1");
  });

  it("drops an anchor the row set no longer contains, so a later Shift is not a range from a vanished row", () => {
    const selection: GridRowSelection = {
      anchorId: "r1",
      selectedIds: new Set(["r3"]),
    };

    const reconciled = reconcileGridRowSelection(selection, ["r2", "r3", "r4"]);

    expect(reconciled.anchorId).toBeNull();
    // The counterfactual the null anchor buys: with `r1` still anchoring, this
    // Shift would extend across the whole remaining set. It resolves to a plain
    // selection instead — a range the reader could have drawn by hand.
    expect(
      selectionOf(
        resolveGridRowSelection(reconciled, "r4", SHIFT, ["r2", "r3", "r4"])
      )
    ).toEqual(["r4"]);
  });

  it("returns the SAME selection by identity when every id and the anchor survive", () => {
    const selection: GridRowSelection = {
      anchorId: "r2",
      selectedIds: new Set(["r2", "r3"]),
    };

    // Identity, not equality: a host calls this from an effect, and a fresh
    // object every render is a write loop rather than a no-op.
    expect(reconcileGridRowSelection(selection, RENDERED)).toBe(selection);
  });

  it("drops rows and the anchor hidden inside a collapsed group", () => {
    const selection: GridRowSelection = {
      anchorId: "r3",
      selectedIds: new Set(["r3", "r4"]),
    };

    const reconciled = reconcileGridRowSelection(selection, ["r1"]);

    expect(reconciled).toEqual(EMPTY_GRID_ROW_SELECTION);
    expect(
      selectionOf(resolveGridRowSelection(reconciled, "r1", SHIFT, ["r1"]))
    ).toEqual(["r1"]);
  });

  it("empties a selection whose every row left, anchor included", () => {
    const selection: GridRowSelection = {
      anchorId: "r1",
      selectedIds: new Set(["r1", "r2"]),
    };

    const reconciled = reconcileGridRowSelection(selection, []);

    expect(reconciled).toEqual(EMPTY_GRID_ROW_SELECTION);
  });
});
