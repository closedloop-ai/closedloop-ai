import {
  COLLAPSE_EMPTY,
  type CollapseKeyExtractor,
  collapseConstantColumns,
  shouldCollapseColumn,
} from "@closedloop-ai/design-system/lib/collapse-columns";
import { describe, expect, it } from "vitest";

/**
 * ISS-7349. `lib/collapse-columns.ts` decides which columns a table DROPS. Get
 * a branch wrong here and a column silently disappears from a user's table —
 * the failure mode is invisible, because a missing column looks exactly like a
 * column that was never configured.
 *
 * The rules that most want pinning are the ones the module header argues for at
 * length and no story can reach: the two-row floor under the constant rule (a
 * single filtered row is trivially uniform), the deliberate refusal to treat an
 * all-empty column as "constant", and the opposite treatment an unmapped column
 * gets under each mode.
 */

type Row = { id: string; status: string | null; owner: string | null };

const COLUMNS = [
  { id: "status", label: "Status" },
  { id: "owner", label: "Owner" },
  { id: "unmapped", label: "Unmapped" },
];

const getKey: CollapseKeyExtractor<Row> = (columnId, item) => {
  if (columnId === "status") {
    return item.status;
  }
  if (columnId === "owner") {
    return item.owner;
  }
  // "unmapped" deliberately falls through with no entry — the extractor
  // returns undefined, which normalizes to the empty sentinel.
  return;
};

const idsOf = (columns: readonly { id: string }[]) =>
  columns.map((column) => column.id);

const CONSTANT_STATUS: Row[] = [
  { id: "1", status: "open", owner: "ada" },
  { id: "2", status: "open", owner: "linus" },
];

const VARIED: Row[] = [
  { id: "1", status: "open", owner: "ada" },
  { id: "2", status: "done", owner: "linus" },
];

const EMPTY_OWNER: Row[] = [
  { id: "1", status: "open", owner: null },
  { id: "2", status: "done", owner: null },
];

describe("shouldCollapseColumn", () => {
  it("keeps every column when there are no rows", () => {
    // Nothing to read means nothing to conclude — collapsing here would drop a
    // column on an empty page and leave it missing when rows arrive.
    expect(shouldCollapseColumn("status", [], getKey)).toBe(false);
  });

  it("collapses a column whose value is identical on every row", () => {
    expect(shouldCollapseColumn("status", CONSTANT_STATUS, getKey)).toBe(true);
  });

  it("keeps a column whose value varies", () => {
    expect(shouldCollapseColumn("status", VARIED, getKey)).toBe(false);
  });

  it("collapses an all-empty column under the default empty rule", () => {
    expect(shouldCollapseColumn("owner", EMPTY_OWNER, getKey)).toBe(true);
  });

  it("keeps an all-empty column when the empty rule is disabled", () => {
    // isConstantAcrossRows returns false for a leading empty sentinel, which is
    // what stops the constant rule standing in for the disabled empty rule.
    expect(
      shouldCollapseColumn("owner", EMPTY_OWNER, getKey, {
        collapseEmptyColumns: false,
      })
    ).toBe(false);
  });

  it("collapses an all-empty single-row column under the empty rule", () => {
    // The empty rule has no row floor — one row with nothing in it is still
    // nothing to show.
    expect(shouldCollapseColumn("owner", [EMPTY_OWNER[0]], getKey)).toBe(true);
  });

  it("keeps a single-row column that is only incidentally uniform", () => {
    // The constant rule's two-row floor: one row is trivially constant, so
    // collapsing here would hide a column because a filter matched one item.
    expect(
      shouldCollapseColumn("status", [CONSTANT_STATUS[0]], getKey, {
        collapseEmptyColumns: false,
      })
    ).toBe(false);
  });

  it("treats undefined from the extractor as the empty sentinel", () => {
    expect(shouldCollapseColumn("unmapped", VARIED, getKey)).toBe(true);
  });

  it("distinguishes the empty sentinel from an empty-string key", () => {
    // Two rows both keyed "" are CONSTANT, not empty — so they collapse under
    // the constant rule even with the empty rule switched off.
    const emptyStringKeys: CollapseKeyExtractor<Row> = () => "";

    expect(
      shouldCollapseColumn("status", VARIED, emptyStringKeys, {
        collapseEmptyColumns: false,
      })
    ).toBe(true);
  });

  it("collapses on an explicit empty sentinel from the extractor", () => {
    const alwaysEmpty: CollapseKeyExtractor<Row> = () => COLLAPSE_EMPTY;

    expect(shouldCollapseColumn("status", VARIED, alwaysEmpty)).toBe(true);
  });
});

describe("collapseConstantColumns", () => {
  it("returns a copy of every column when there are no rows", () => {
    const next = collapseConstantColumns(COLUMNS, [], getKey);

    expect(idsOf(next)).toEqual(["status", "owner", "unmapped"]);
    expect(next).not.toBe(COLUMNS);
  });

  it("drops constant and empty columns while preserving the survivors' order", () => {
    const next = collapseConstantColumns(COLUMNS, CONSTANT_STATUS, getKey);

    // status is constant, unmapped is empty; owner varies and survives.
    expect(idsOf(next)).toEqual(["owner"]);
  });

  it("keeps a protected column even when its value is constant", () => {
    const next = collapseConstantColumns(
      COLUMNS,
      CONSTANT_STATUS,
      getKey,
      new Set(["status"])
    );

    expect(idsOf(next)).toContain("status");
  });

  it("keeps an unmapped column under the constant-only mode", () => {
    // The safety property the header calls out: with the empty rule off, a
    // column the caller forgot to map can never silently disappear.
    const next = collapseConstantColumns(COLUMNS, VARIED, getKey, undefined, {
      collapseEmptyColumns: false,
    });

    expect(idsOf(next)).toEqual(["status", "owner", "unmapped"]);
  });

  it("drops an unmapped column under the empty-rule default", () => {
    const next = collapseConstantColumns(COLUMNS, VARIED, getKey);

    expect(idsOf(next)).toEqual(["status", "owner"]);
  });

  it("never mutates the input column list", () => {
    collapseConstantColumns(COLUMNS, CONSTANT_STATUS, getKey);

    expect(idsOf(COLUMNS)).toEqual(["status", "owner", "unmapped"]);
  });
});
