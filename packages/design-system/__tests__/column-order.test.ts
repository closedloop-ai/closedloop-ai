import {
  applyColumnWidths,
  CARD_FALLBACK_BREAKPOINT,
  COLUMN_RESIZE_KEYBOARD_STEP_PX,
  ColumnMoveDirection,
  ColumnResizeDirection,
  clampColumnWidth,
  MIN_COLUMN_WIDTH_PX,
  mergeColumnOrder,
  moveColumn,
  moveColumnByDirection,
  orderColumns,
  resizeColumnByDirection,
  withMissingColumnsAtCanonicalSlots,
} from "@closedloop-ai/design-system/lib/column-order";
import { describe, expect, it } from "vitest";

/**
 * ISS-7349. `lib/column-order.ts` is the persisted-arrangement model for every
 * `GridTable` in the product: what a user drags, hides, and resizes is written
 * through these functions and read back through them on the next mount. The
 * story sweep exercises one drag on one table; what it cannot reach is the
 * version-skew surface these functions exist for — a persisted order that
 * predates a column, a saved width for an id that no longer exists, a drop
 * index past the last track, a NaN from a pointer delta. Each of those is a
 * documented degradation rule, and each one silently loses a user's arrangement
 * if it regresses.
 */

const COLUMNS = ["name", "status", "owner", "updated"];

type Column = { id: string; label: string };

const COLUMN_DESCRIPTORS: Column[] = [
  { id: "name", label: "Name" },
  { id: "status", label: "Status" },
  { id: "owner", label: "Owner" },
];

const idsOf = (columns: readonly Column[]) => columns.map((c) => c.id);

describe("moveColumn", () => {
  it("moves a column forward without mutating the input", () => {
    const input = [...COLUMNS];

    const next = moveColumn(input, 0, 2);

    expect(next).toEqual(["status", "owner", "name", "updated"]);
    expect(input).toEqual(COLUMNS);
  });

  it("moves a column backward", () => {
    expect(moveColumn(COLUMNS, 3, 1)).toEqual([
      "name",
      "updated",
      "status",
      "owner",
    ]);
  });

  it("returns an equal copy when the indices are the same", () => {
    const next = moveColumn(COLUMNS, 2, 2);

    expect(next).toEqual(COLUMNS);
    expect(next).not.toBe(COLUMNS);
  });

  it("clamps an over-range drop to the last slot instead of dropping the id", () => {
    // Dragging past the last column is a normal pointer gesture; the id must
    // land, not vanish.
    expect(moveColumn(COLUMNS, 0, 99)).toEqual([
      "status",
      "owner",
      "updated",
      "name",
    ]);
  });

  it("clamps a negative source index to the first slot", () => {
    expect(moveColumn(COLUMNS, -5, 2)).toEqual([
      "status",
      "owner",
      "name",
      "updated",
    ]);
  });

  it("clamps -1 to the FIRST slot rather than letting splice read from the end", () => {
    // The case that actually distinguishes the lower clamp: Array#splice treats
    // a negative index as an offset from the END, so an unclamped -1 would grab
    // the LAST column. -1 must mean "before the first", i.e. a no-op move of the
    // first column onto itself.
    expect(moveColumn(COLUMNS, -1, 0)).toEqual(COLUMNS);
  });

  it("returns an empty array for empty input", () => {
    // clampIndex's length-0 arm: both indices resolve to 0, so from === to.
    expect(moveColumn([], 0, 3)).toEqual([]);
  });
});

describe("moveColumnByDirection", () => {
  it("moves a column one slot left", () => {
    expect(
      moveColumnByDirection(COLUMNS, "owner", ColumnMoveDirection.Left)
    ).toEqual(["name", "owner", "status", "updated"]);
  });

  it("moves a column one slot right", () => {
    expect(
      moveColumnByDirection(COLUMNS, "status", ColumnMoveDirection.Right)
    ).toEqual(["name", "owner", "status", "updated"]);
  });

  it("is a no-op at the left edge", () => {
    expect(
      moveColumnByDirection(COLUMNS, "name", ColumnMoveDirection.Left)
    ).toEqual(COLUMNS);
  });

  it("is a no-op at the right edge", () => {
    expect(
      moveColumnByDirection(COLUMNS, "updated", ColumnMoveDirection.Right)
    ).toEqual(COLUMNS);
  });

  it("is a no-op for an id that is not present", () => {
    const next = moveColumnByDirection(
      COLUMNS,
      "ghost",
      ColumnMoveDirection.Right
    );

    expect(next).toEqual(COLUMNS);
    expect(next).not.toBe(COLUMNS);
  });
});

describe("orderColumns", () => {
  it("returns a copy in input order when no persisted order is supplied", () => {
    const next = orderColumns(COLUMN_DESCRIPTORS);

    expect(idsOf(next)).toEqual(["name", "status", "owner"]);
    expect(next).not.toBe(COLUMN_DESCRIPTORS);
  });

  it("returns a copy in input order for an empty persisted order", () => {
    expect(idsOf(orderColumns(COLUMN_DESCRIPTORS, []))).toEqual([
      "name",
      "status",
      "owner",
    ]);
  });

  it("emits persisted ids first, in the persisted order", () => {
    expect(idsOf(orderColumns(COLUMN_DESCRIPTORS, ["owner", "name"]))).toEqual([
      "owner",
      "name",
      "status",
    ]);
  });

  it("appends a column the persisted order predates rather than dropping it", () => {
    // Version skew: a saved order written before "owner" existed.
    expect(idsOf(orderColumns(COLUMN_DESCRIPTORS, ["status", "name"]))).toEqual(
      ["status", "name", "owner"]
    );
  });

  it("ignores a persisted id with no matching column", () => {
    expect(idsOf(orderColumns(COLUMN_DESCRIPTORS, ["ghost", "owner"]))).toEqual(
      ["owner", "name", "status"]
    );
  });

  it("emits a duplicated persisted id only once", () => {
    expect(
      idsOf(orderColumns(COLUMN_DESCRIPTORS, ["owner", "owner", "name"]))
    ).toEqual(["owner", "name", "status"]);
  });
});

describe("mergeColumnOrder", () => {
  it("substitutes the reordered visible subset into the slots it owns", () => {
    // "status" is hidden, so it is absent from visibleOrder and must keep its
    // own slot while the visible ids fill the rest.
    expect(
      mergeColumnOrder(
        ["name", "status", "owner", "updated"],
        ["owner", "name", "updated"]
      )
    ).toEqual(["owner", "status", "name", "updated"]);
  });

  it("keeps the complete order when nothing was reordered", () => {
    expect(mergeColumnOrder(COLUMNS, COLUMNS)).toEqual(COLUMNS);
  });

  it("appends a visible id the complete order does not know about", () => {
    // Version skew in the other direction — a newly-added column the persisted
    // complete order predates.
    expect(
      mergeColumnOrder(["name", "status"], ["status", "name", "fresh"])
    ).toEqual(["status", "name", "fresh"]);
  });

  it("emits nothing for an empty complete order and no visible ids", () => {
    expect(mergeColumnOrder([], [])).toEqual([]);
  });

  it("emits a duplicated visible id only once", () => {
    // "a" is not in the visible subset so it keeps its own slot; "b" consumes
    // the first of its two queue entries and the second is swallowed by the
    // emitted set rather than appended.
    expect(mergeColumnOrder(["a", "b"], ["b", "b"])).toEqual(["a", "b"]);
  });
});

describe("clampColumnWidth", () => {
  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("degrades %s to the shared floor", (_label, width) => {
    // A bad pointer delta must not collapse a column to zero width.
    expect(clampColumnWidth(width)).toBe(MIN_COLUMN_WIDTH_PX);
  });

  it("clamps a sub-floor width up to the floor", () => {
    expect(clampColumnWidth(10)).toBe(MIN_COLUMN_WIDTH_PX);
  });

  it("rounds a fractional width to a whole pixel so the persisted value is stable", () => {
    expect(clampColumnWidth(180.4)).toBe(180);
    expect(clampColumnWidth(180.6)).toBe(181);
  });

  it("passes a width already at the floor through unchanged", () => {
    expect(clampColumnWidth(MIN_COLUMN_WIDTH_PX)).toBe(MIN_COLUMN_WIDTH_PX);
  });
});

describe("resizeColumnByDirection", () => {
  it("widens by one keyboard step", () => {
    expect(resizeColumnByDirection(200, ColumnResizeDirection.Grow)).toBe(
      200 + COLUMN_RESIZE_KEYBOARD_STEP_PX
    );
  });

  it("narrows by one keyboard step", () => {
    expect(resizeColumnByDirection(200, ColumnResizeDirection.Shrink)).toBe(
      200 - COLUMN_RESIZE_KEYBOARD_STEP_PX
    );
  });

  it("stops at the floor rather than shrinking past it", () => {
    // Repeated keyboard shrink is the path that reaches this; the column must
    // stay grabbable.
    expect(
      resizeColumnByDirection(MIN_COLUMN_WIDTH_PX, ColumnResizeDirection.Shrink)
    ).toBe(MIN_COLUMN_WIDTH_PX);
  });
});

describe("applyColumnWidths", () => {
  const NATURAL = { name: 300, status: 120 } as const;

  it("returns the base map unchanged when nothing is persisted", () => {
    const merged = applyColumnWidths(NATURAL);

    expect(merged).toEqual({ name: 300, status: 120 });
    expect(merged).not.toBe(NATURAL);
  });

  it("overlays a persisted width for a known column", () => {
    expect(applyColumnWidths(NATURAL, { status: 200 })).toEqual({
      name: 300,
      status: 200,
    });
  });

  it("ignores a persisted width for an unknown column", () => {
    // A stale id from an older saved view must not inject a phantom track.
    expect(applyColumnWidths(NATURAL, { ghost: 999 })).toEqual({
      name: 300,
      status: 120,
    });
  });

  it("clamps a persisted width that is below the floor", () => {
    expect(applyColumnWidths(NATURAL, { status: 4 })).toEqual({
      name: 300,
      status: MIN_COLUMN_WIDTH_PX,
    });
  });

  it("clamps a non-finite persisted width to the floor", () => {
    expect(applyColumnWidths(NATURAL, { name: Number.NaN })).toEqual({
      name: MIN_COLUMN_WIDTH_PX,
      status: 120,
    });
  });
});

describe("withMissingColumnsAtCanonicalSlots", () => {
  const CANONICAL = ["name", "status", "owner", "updated"];

  it("returns an empty persisted order untouched", () => {
    // Empty means "no persisted opinion" — the natural order already has every
    // column in its canonical slot.
    expect(withMissingColumnsAtCanonicalSlots(CANONICAL, [])).toEqual([]);
  });

  it("splices a missing id in after its last surviving predecessor", () => {
    // "owner" is new. Its canonical predecessors are name/status; "status" is
    // the last of them present, so owner lands immediately after it — NOT at
    // the end, which is what orderColumns would do.
    expect(
      withMissingColumnsAtCanonicalSlots(CANONICAL, [
        "updated",
        "name",
        "status",
      ])
    ).toEqual(["updated", "name", "status", "owner"]);
  });

  it("places a missing id after the predecessor that sits LAST in the user's order", () => {
    // The predecessor that wins is the one furthest right in the USER'S array,
    // not the one furthest along canonically. Here owner's predecessors are
    // name and status; the user dragged "name" to the end, so owner follows it
    // there and lands last — the same slot orderColumns would have given it,
    // arrived at for a different reason. Pins current behavior; it looks odd
    // because "canonical neighbourhood" reads as "next to status", and the
    // relative-placement rule can put the new column anywhere the user has
    // moved its last predecessor to.
    expect(
      withMissingColumnsAtCanonicalSlots(CANONICAL, [
        "status",
        "updated",
        "name",
      ])
    ).toEqual(["status", "updated", "name", "owner"]);
  });

  it("follows its last predecessor to the front when the user moved it there", () => {
    // The mirror of the case above, and the one that shows the rule is really
    // relative: with "status" last-in-user-order at index 0, owner lands at 1
    // rather than at its canonical index.
    expect(
      withMissingColumnsAtCanonicalSlots(CANONICAL, ["status", "updated"])
    ).toEqual(["name", "status", "owner", "updated"]);
  });

  it("leads with a missing id when none of its predecessors survive", () => {
    // lastIndexOfAny returns -1, so the splice index is 0. Every remaining id
    // is one canonical order ranks after it, so leading is the only consistent
    // placement.
    expect(
      withMissingColumnsAtCanonicalSlots(CANONICAL, ["owner", "updated"])
    ).toEqual(["name", "status", "owner", "updated"]);
  });

  it("keeps two columns arriving together in canonical order relative to each other", () => {
    expect(
      withMissingColumnsAtCanonicalSlots(CANONICAL, ["name", "updated"])
    ).toEqual(["name", "status", "owner", "updated"]);
  });

  it("returns a copy when nothing is missing", () => {
    const persisted = ["updated", "owner", "status", "name"];

    const next = withMissingColumnsAtCanonicalSlots(CANONICAL, persisted);

    expect(next).toEqual(persisted);
    expect(next).not.toBe(persisted);
  });
});

describe("shared layout constants", () => {
  it("pins the card-fallback breakpoint to the Tailwind md breakpoint", () => {
    // Consumers derive column budgets from this; a silent change moves the
    // grid/card switch on every table at once.
    expect(CARD_FALLBACK_BREAKPOINT).toBe(768);
  });

  it("pins the shared width floor and keyboard step", () => {
    expect(MIN_COLUMN_WIDTH_PX).toBe(60);
    expect(COLUMN_RESIZE_KEYBOARD_STEP_PX).toBe(16);
  });
});
