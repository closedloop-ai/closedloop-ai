import {
  applyColumnWidths,
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
} from "@repo/design-system/lib/column-order";
import { describe, expect, it } from "vitest";

/**
 * FEA-4021: unit coverage for the generic column-order helpers powering the
 * design-system `GridTable` drag/keyboard reorder. Colocated in `@repo/app`
 * because `@repo/design-system` has no test runner and this package is the
 * helper's consumer (Branches adoption).
 */

type Column = { id: string; label: string };

const COLUMNS: readonly Column[] = [
  { id: "a", label: "A" },
  { id: "b", label: "B" },
  { id: "c", label: "C" },
];

describe("moveColumn", () => {
  it("moves an id from one index to another without mutating the input", () => {
    const input = ["a", "b", "c", "d"];
    const next = moveColumn(input, 0, 2);
    expect(next).toEqual(["b", "c", "a", "d"]);
    expect(input).toEqual(["a", "b", "c", "d"]);
  });

  it("clamps an out-of-range target to the last slot", () => {
    expect(moveColumn(["a", "b", "c"], 0, 99)).toEqual(["b", "c", "a"]);
  });

  it("is a no-op when from equals to", () => {
    expect(moveColumn(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);
  });
});

describe("moveColumnByDirection", () => {
  it("moves a column one slot right", () => {
    expect(
      moveColumnByDirection(["a", "b", "c"], "a", ColumnMoveDirection.Right)
    ).toEqual(["b", "a", "c"]);
  });

  it("moves a column one slot left", () => {
    expect(
      moveColumnByDirection(["a", "b", "c"], "c", ColumnMoveDirection.Left)
    ).toEqual(["a", "c", "b"]);
  });

  it("is a no-op at the left edge", () => {
    expect(
      moveColumnByDirection(["a", "b", "c"], "a", ColumnMoveDirection.Left)
    ).toEqual(["a", "b", "c"]);
  });

  it("is a no-op at the right edge", () => {
    expect(
      moveColumnByDirection(["a", "b", "c"], "c", ColumnMoveDirection.Right)
    ).toEqual(["a", "b", "c"]);
  });

  it("is a no-op for an unknown id", () => {
    expect(
      moveColumnByDirection(["a", "b", "c"], "z", ColumnMoveDirection.Right)
    ).toEqual(["a", "b", "c"]);
  });
});

describe("orderColumns", () => {
  it("returns the input order unchanged when no order is given", () => {
    expect(orderColumns(COLUMNS).map((column) => column.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("orders columns by the given id list", () => {
    expect(
      orderColumns(COLUMNS, ["c", "a", "b"]).map((column) => column.id)
    ).toEqual(["c", "a", "b"]);
  });

  it("appends columns absent from the order at the end in natural order", () => {
    // A persisted order predating a newly-added column: the unknown column keeps
    // its natural position at the end instead of vanishing.
    expect(
      orderColumns(COLUMNS, ["c", "a"]).map((column) => column.id)
    ).toEqual(["c", "a", "b"]);
  });

  it("ignores ids in the order that the columns no longer have", () => {
    expect(
      orderColumns(COLUMNS, ["z", "b", "a", "c"]).map((column) => column.id)
    ).toEqual(["b", "a", "c"]);
  });
});

describe("mergeColumnOrder", () => {
  const ALL = ["a", "b", "c", "d"] as const;

  it("preserves a hidden column's slot when the visible subset is reordered", () => {
    // "c" is hidden; the user drags the visible subset [a,b,d] into [b,a,d].
    // "c" must keep its natural position (index 2), NOT be appended at the end.
    expect(mergeColumnOrder(ALL, ["b", "a", "d"])).toEqual([
      "b",
      "a",
      "c",
      "d",
    ]);
  });

  it("is identity when every column is visible", () => {
    expect(mergeColumnOrder(ALL, ["d", "c", "b", "a"])).toEqual([
      "d",
      "c",
      "b",
      "a",
    ]);
  });

  it("keeps multiple hidden columns in their own slots", () => {
    // Only [a,d] visible, reordered to [d,a]; "b" and "c" hold their slots.
    expect(mergeColumnOrder(ALL, ["d", "a"])).toEqual(["d", "b", "c", "a"]);
  });

  it("appends a visible id the complete order does not know about", () => {
    // Version skew: the persisted complete order predates column "e".
    expect(mergeColumnOrder(ALL, ["a", "b", "c", "d", "e"])).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("returns the complete order unchanged when nothing is visible", () => {
    expect(mergeColumnOrder(ALL, [])).toEqual(["a", "b", "c", "d"]);
  });
});

// FEA-4168: generic column-width resize helpers powering the GridTable resize
// handle. Colocated here for the same reason as the order helpers above.
describe("clampColumnWidth", () => {
  it("returns a width above the floor unchanged (rounded to a whole px)", () => {
    expect(clampColumnWidth(180.4)).toBe(180);
  });

  it("clamps a width below the floor up to the shared minimum", () => {
    expect(clampColumnWidth(MIN_COLUMN_WIDTH_PX - 20)).toBe(
      MIN_COLUMN_WIDTH_PX
    );
  });

  it("degrades a non-finite width (NaN from a bad delta) to the floor", () => {
    expect(clampColumnWidth(Number.NaN)).toBe(MIN_COLUMN_WIDTH_PX);
  });
});

describe("resizeColumnByDirection", () => {
  it("grows and shrinks by the same keyboard step", () => {
    const grown = resizeColumnByDirection(120, ColumnResizeDirection.Grow);
    const shrunk = resizeColumnByDirection(grown, ColumnResizeDirection.Shrink);
    expect(shrunk).toBe(120);
  });

  it("never shrinks below the shared floor", () => {
    expect(
      resizeColumnByDirection(MIN_COLUMN_WIDTH_PX, ColumnResizeDirection.Shrink)
    ).toBe(MIN_COLUMN_WIDTH_PX);
  });
});

describe("applyColumnWidths", () => {
  const NATURAL = { a: 150, b: 160, c: 120 } as const;

  it("returns the base widths unchanged when no overrides are given", () => {
    expect(applyColumnWidths(NATURAL)).toEqual(NATURAL);
  });

  it("overrides only the columns present in the persisted map", () => {
    expect(applyColumnWidths(NATURAL, { b: 300 })).toEqual({
      a: 150,
      b: 300,
      c: 120,
    });
  });

  it("drops an unknown persisted id so no phantom track is injected", () => {
    expect(applyColumnWidths(NATURAL, { z: 400 })).toEqual(NATURAL);
  });

  it("clamps a too-small persisted width to the shared floor", () => {
    expect(applyColumnWidths(NATURAL, { a: 10 }).a).toBe(MIN_COLUMN_WIDTH_PX);
  });
});

/**
 * ISS-5282 (review cid 3731452653): `orderColumns` appends anything a persisted
 * order predates at the END, which is the wrong degradation for a NEW column
 * shipping into an existing product — every saved view lists every OTHER id, so
 * the new column lands last for exactly the users who have drag-reordered
 * before, on a table that already overflows.
 */
describe("withMissingColumnsAtCanonicalSlots", () => {
  const CANONICAL = ["owner", "status", "cost", "signals", "repo", "branch"];

  it("splices a missing column in after its last surviving canonical predecessor", () => {
    const persisted = ["owner", "status", "cost", "repo", "branch"];
    expect(withMissingColumnsAtCanonicalSlots(CANONICAL, persisted)).toEqual([
      "owner",
      "status",
      "cost",
      "signals",
      "repo",
      "branch",
    ]);
  });

  it("places it relative to the user's own arrangement, not at a fixed index", () => {
    // The user moved every canonical predecessor to the end, so the new column
    // follows them there rather than landing at canonical index 3 in an
    // arrangement nobody actually has.
    const persisted = ["repo", "branch", "owner", "status", "cost"];
    expect(withMissingColumnsAtCanonicalSlots(CANONICAL, persisted)).toEqual([
      "repo",
      "branch",
      "owner",
      "status",
      "cost",
      "signals",
    ]);
  });

  it("leads a column whose canonical predecessors are all absent too", () => {
    // Every id before `repo` is missing, so all four are restored — and because
    // they are resolved in canonical order, each becomes the anchor for the next
    // rather than all four piling up at the front in reverse.
    const persisted = ["repo", "branch"];
    expect(withMissingColumnsAtCanonicalSlots(CANONICAL, persisted)).toEqual([
      "owner",
      "status",
      "cost",
      "signals",
      "repo",
      "branch",
    ]);
  });

  it("keeps several columns arriving together in canonical order", () => {
    const persisted = ["owner", "repo"];
    expect(withMissingColumnsAtCanonicalSlots(CANONICAL, persisted)).toEqual([
      "owner",
      "status",
      "cost",
      "signals",
      "repo",
      "branch",
    ]);
  });

  it("returns an empty order untouched — the natural order already places everything", () => {
    expect(withMissingColumnsAtCanonicalSlots(CANONICAL, [])).toEqual([]);
  });

  it("is a no-op when the persisted order already covers the canonical set", () => {
    const persisted = ["signals", "owner", "status", "cost", "repo", "branch"];
    expect(withMissingColumnsAtCanonicalSlots(CANONICAL, persisted)).toEqual(
      persisted
    );
  });

  it("never mutates its input", () => {
    const persisted = ["owner", "status", "cost", "repo", "branch"];
    withMissingColumnsAtCanonicalSlots(CANONICAL, persisted);
    expect(persisted).toEqual(["owner", "status", "cost", "repo", "branch"]);
  });

  it("preserves an id the canonical order no longer knows", () => {
    const persisted = ["owner", "retired-column", "status", "cost"];
    expect(withMissingColumnsAtCanonicalSlots(CANONICAL, persisted)).toContain(
      "retired-column"
    );
  });
});
