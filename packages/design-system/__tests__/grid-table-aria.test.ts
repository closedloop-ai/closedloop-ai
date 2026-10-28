import {
  ariaCellProps,
  ariaColumnHeaderProps,
  ariaPresentationProps,
  ariaRowGroupProps,
  ariaRowProps,
  ariaTableProps,
  FIRST_COLUMN_INDEX,
  getColumnCount,
  getDataColumnIndex,
  resolveGridColumnTracks,
} from "@closedloop-ai/design-system/lib/grid-table-aria";
import { describe, expect, it } from "vitest";

/**
 * ISS-7349. A CSS-grid table has no implicit column relationships, so a screen
 * reader pairs a body cell with its column header purely by `aria-colindex`.
 * The module exists because that arithmetic has to be IDENTICAL on both sides —
 * a body row numbering from a different base resolves every cell against the
 * header one column to its left, silently, with nothing to fail.
 *
 * SCOPE, because the rendered contract is owned elsewhere. `packages/app/shared/
 * lib/__tests__/grid-table-aria-semantics.test.tsx` owns GridTable's ARIA
 * contract from the consumer side, per this package's AGENTS.md, and it already
 * asserts the exact `aria-colindex` arrays and resolves each body cell to its
 * header — so an off-by-one in the numbering DOES fail there, and this file
 * must not restate that.
 *
 * What is left to this file is the builders' own arms, which that suite cannot
 * reach: it renders a table and never imports these functions, so the opted-out
 * (`enabled: false`) arms, the colspan omission, and the blank-label naming
 * arm have no render that exercises them. Those, and the "both or neither"
 * pairing that keeps a role and its index together, are what these pin.
 */

describe("column numbering", () => {
  it("starts the grid at 1-based index 1", () => {
    // Both the header row and the body rows begin numbering here; the two must
    // share this base or every cell resolves against the wrong header.
    expect(FIRST_COLUMN_INDEX).toBe(1);
  });

  it("places the first data column immediately after the lead", () => {
    expect(getDataColumnIndex(FIRST_COLUMN_INDEX, 0)).toBe(2);
  });

  it("advances one index per data column", () => {
    expect(getDataColumnIndex(FIRST_COLUMN_INDEX, 3)).toBe(5);
  });

  it("counts the lead track plus every data column", () => {
    expect(getColumnCount(FIRST_COLUMN_INDEX, 4)).toBe(5);
  });

  it("counts the lead alone when there are no data columns", () => {
    expect(getColumnCount(FIRST_COLUMN_INDEX, 0)).toBe(1);
  });

  it("keeps the last data column's index inside the declared column count", () => {
    // The invariant that actually matters: the highest index a row emits must
    // not exceed the aria-colcount the table declares.
    const dataColumnCount = 4;

    expect(getDataColumnIndex(FIRST_COLUMN_INDEX, dataColumnCount - 1)).toBe(
      getColumnCount(FIRST_COLUMN_INDEX, dataColumnCount)
    );
  });
});

describe("ariaTableProps", () => {
  it("declares the table role and column count when enabled", () => {
    expect(ariaTableProps(true, 5)).toEqual({
      "aria-colcount": 5,
      role: "table",
    });
  });

  it("emits nothing when the caller has not opted in", () => {
    // An aria-colindex on a role-less element is an unsupported attribute, so
    // the disabled arm must emit NEITHER half.
    expect(ariaTableProps(false, 5)).toEqual({});
  });
});

describe("ariaRowGroupProps / ariaRowProps / ariaPresentationProps", () => {
  it.each([
    ["rowgroup", ariaRowGroupProps, { role: "rowgroup" }],
    ["row", ariaRowProps, { role: "row" }],
    ["presentation", ariaPresentationProps, { role: "presentation" }],
  ])("declares the %s role when enabled", (_label, build, expected) => {
    expect(build(true)).toEqual(expected);
  });

  it.each([
    ["rowgroup", ariaRowGroupProps],
    ["row", ariaRowProps],
    ["presentation", ariaPresentationProps],
  ])("emits nothing for %s when disabled", (_label, build) => {
    expect(build(false)).toEqual({});
  });
});

describe("ariaCellProps", () => {
  it("pairs the cell role with its column index", () => {
    expect(ariaCellProps(true, 3)).toEqual({
      "aria-colindex": 3,
      role: "cell",
    });
  });

  it("omits aria-colspan for a single-track cell", () => {
    expect(ariaCellProps(true, 3)).not.toHaveProperty("aria-colspan");
  });

  it("carries a colspan for a cell that spans the whole row", () => {
    expect(ariaCellProps(true, 1, 5)).toEqual({
      "aria-colindex": 1,
      "aria-colspan": 5,
      role: "cell",
    });
  });

  it("emits nothing when disabled, even with a colspan", () => {
    expect(ariaCellProps(false, 1, 5)).toEqual({});
  });
});

describe("ariaColumnHeaderProps", () => {
  it("pairs the columnheader role with its column index", () => {
    expect(ariaColumnHeaderProps(true, 2)).toEqual({
      "aria-colindex": 2,
      role: "columnheader",
    });
  });

  it("omits aria-label when the header has a visible label", () => {
    expect(ariaColumnHeaderProps(true, 2)).not.toHaveProperty("aria-label");
  });

  it("names a header whose visible label is intentionally empty", () => {
    // Without this, every body cell in that track is announced under a blank
    // header.
    expect(ariaColumnHeaderProps(true, 6, "Actions")).toEqual({
      "aria-colindex": 6,
      "aria-label": "Actions",
      role: "columnheader",
    });
  });

  it("emits nothing when disabled, even with a label", () => {
    expect(ariaColumnHeaderProps(false, 6, "Actions")).toEqual({});
  });
});

/**
 * ISS-9564. The resolver every layer of a grid reads its track numbering from.
 * The values are pinned literals rather than expressions over
 * `FIRST_COLUMN_INDEX`: restating the arithmetic under test would make any
 * self-consistent numbering pass, including a wrong one.
 */
describe("resolveGridColumnTracks", () => {
  it("numbers a grid with no utility track from the first track", () => {
    const { dataColumnIndex, ...rest } = resolveGridColumnTracks({
      hasLeadingUtility: false,
      dataColumnCount: 3,
    });

    // `toStrictEqual` on the rest, so a key that stopped being emitted fails
    // here: a MISSING key and an `undefined` one are equal under `toEqual`.
    expect(rest).toStrictEqual({
      hasLeadingUtility: false,
      leadingUtilityColumnIndex: undefined,
      leadColumnIndex: 1,
      columnCount: 4,
      trailingColumnIndex: undefined,
    });
    expect(typeof dataColumnIndex).toBe("function");
  });

  it("shifts every index by the utility track when one exists", () => {
    const { dataColumnIndex, ...rest } = resolveGridColumnTracks({
      hasLeadingUtility: true,
      dataColumnCount: 3,
    });

    expect(rest).toStrictEqual({
      hasLeadingUtility: true,
      leadingUtilityColumnIndex: 1,
      leadColumnIndex: 2,
      columnCount: 5,
      trailingColumnIndex: undefined,
    });
    expect(typeof dataColumnIndex).toBe("function");
  });

  it("numbers the data columns after whichever lead track it resolved", () => {
    const withUtility = resolveGridColumnTracks({
      hasLeadingUtility: true,
      dataColumnCount: 2,
    });
    const withoutUtility = resolveGridColumnTracks({
      hasLeadingUtility: false,
      dataColumnCount: 2,
    });

    expect([0, 1].map((index) => withUtility.dataColumnIndex(index))).toEqual([
      3, 4,
    ]);
    expect(
      [0, 1].map((index) => withoutUtility.dataColumnIndex(index))
    ).toEqual([2, 3]);
  });

  it("counts a caller-owned trailing track toward the column count", () => {
    // Otherwise the trailing cell's own `aria-colindex` exceeds the count the
    // table publishes, which is the one arithmetic error a reader can detect.
    const tracks = resolveGridColumnTracks({
      hasLeadingUtility: true,
      dataColumnCount: 2,
      hasTrailingTrack: true,
    });

    expect(tracks.columnCount).toBe(5);
    expect(tracks.trailingColumnIndex).toBe(5);
  });
});
