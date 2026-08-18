import {
  COLLAPSE_EMPTY,
  type CollapseCellKey,
  collapseConstantColumns,
  shouldCollapseColumn,
} from "@repo/design-system/lib/collapse-columns";
import { describe, expect, it } from "vitest";

/**
 * FEA-3968: unit coverage for the generic constant/empty column-collapse helper
 * shared by the Loops (`DataTable`), Branches, and Agents (`GridTable`) tables.
 * Colocated in `@repo/app` because `@repo/design-system` has no test runner and
 * this package is the helper's consumer.
 */

type Row = { id: string; command: string; owner: string | null; count: number };

const COLUMNS = [
  { id: "command", width: "120px" },
  { id: "owner", width: "120px" },
  { id: "count", width: "80px" },
] as const;

// Only the categorical columns opt in; `count` has no case, so the extractor
// returns the empty sentinel for it (as the real table extractors do for
// out-of-scope columns). Paired with `collapseEmptyColumns: false`, that means
// `count` is never collapsed — the constant rule ignores the empty sentinel.
function keyOf(columnId: string, row: Row): CollapseCellKey {
  switch (columnId) {
    case "command":
      return row.command;
    case "owner":
      return row.owner ?? COLLAPSE_EMPTY;
    default:
      return COLLAPSE_EMPTY;
  }
}

// The constant-only mode the Loops/Branches/Agents tables use.
const CONSTANT_ONLY = { collapseEmptyColumns: false } as const;

describe("shouldCollapseColumn", () => {
  it("collapses a column that is constant across every visible row", () => {
    const rows: Row[] = [
      { id: "1", command: "manual", owner: "a", count: 1 },
      { id: "2", command: "manual", owner: "b", count: 2 },
    ];
    expect(shouldCollapseColumn("command", rows, keyOf)).toBe(true);
  });

  it("keeps a column whose value varies across rows", () => {
    const rows: Row[] = [
      { id: "1", command: "manual", owner: "a", count: 1 },
      { id: "2", command: "execute", owner: "b", count: 2 },
    ];
    expect(shouldCollapseColumn("command", rows, keyOf)).toBe(false);
  });

  it("collapses an empty column even for a single row (empty rule on)", () => {
    const rows: Row[] = [{ id: "1", command: "manual", owner: null, count: 1 }];
    expect(shouldCollapseColumn("owner", rows, keyOf)).toBe(true);
  });

  it("keeps an all-empty column when the empty rule is off", () => {
    // With `collapseEmptyColumns: false`, an all-empty column (owner null on
    // every row, or a column with no extractor case) is NOT collapsed — only a
    // genuinely repeated non-empty value collapses.
    const rows: Row[] = [
      { id: "1", command: "manual", owner: null, count: 1 },
      { id: "2", command: "manual", owner: null, count: 2 },
    ];
    expect(shouldCollapseColumn("owner", rows, keyOf, CONSTANT_ONLY)).toBe(
      false
    );
  });

  it("does NOT collapse a constant column when only one row is visible", () => {
    // A single row is trivially constant; the constant rule needs two rows so a
    // one-row filtered view keeps its columns.
    const rows: Row[] = [{ id: "1", command: "manual", owner: "a", count: 1 }];
    expect(shouldCollapseColumn("command", rows, keyOf)).toBe(false);
  });

  it("keeps a column with no extractor entry regardless of value", () => {
    const rows: Row[] = [
      { id: "1", command: "manual", owner: "a", count: 5 },
      { id: "2", command: "execute", owner: "b", count: 5 },
    ];
    // `count` returns the empty sentinel (no extractor case) ⇒ the constant rule
    // ignores it and the empty rule is off ⇒ never collapsed.
    expect(shouldCollapseColumn("count", rows, keyOf, CONSTANT_ONLY)).toBe(
      false
    );
  });
});

describe("collapseConstantColumns", () => {
  it("drops the constant/empty columns and keeps the rest in order (empty rule on)", () => {
    const rows: Row[] = [
      { id: "1", command: "manual", owner: null, count: 1 },
      { id: "2", command: "manual", owner: null, count: 2 },
    ];
    const kept = collapseConstantColumns(COLUMNS, rows, keyOf);
    // command constant ⇒ dropped; owner empty ⇒ dropped (empty rule on); count
    // is also empty via the extractor ⇒ dropped. Nothing informative remains.
    expect(kept.map((column) => column.id)).toEqual([]);
  });

  it("in constant-only mode drops only the repeated non-empty column", () => {
    const rows: Row[] = [
      { id: "1", command: "manual", owner: null, count: 1 },
      { id: "2", command: "manual", owner: null, count: 2 },
    ];
    const kept = collapseConstantColumns(
      COLUMNS,
      rows,
      keyOf,
      undefined,
      CONSTANT_ONLY
    );
    // command constant ⇒ dropped; owner (empty) and count (no extractor) kept.
    expect(kept.map((column) => column.id)).toEqual(["owner", "count"]);
  });

  it("returns every column unchanged when there are no rows", () => {
    const kept = collapseConstantColumns(COLUMNS, [], keyOf);
    expect(kept.map((column) => column.id)).toEqual([
      "command",
      "owner",
      "count",
    ]);
  });

  it("protects columns named in keepColumnIds even when constant", () => {
    const rows: Row[] = [
      { id: "1", command: "manual", owner: "a", count: 1 },
      { id: "2", command: "manual", owner: "b", count: 2 },
    ];
    const kept = collapseConstantColumns(
      COLUMNS,
      rows,
      keyOf,
      new Set(["command"]),
      CONSTANT_ONLY
    );
    // command is constant but protected ⇒ kept; owner varies ⇒ kept; count has
    // no extractor and the empty rule is off ⇒ kept.
    expect(kept.map((column) => column.id)).toEqual([
      "command",
      "owner",
      "count",
    ]);
  });
});
