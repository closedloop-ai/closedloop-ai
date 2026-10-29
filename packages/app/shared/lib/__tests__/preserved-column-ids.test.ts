import { MAX_CUSTOM_FIELDS_PER_ORG } from "@repo/api/src/types/custom-field";
import { describe, expect, it } from "vitest";
import {
  MAX_SERIALIZED_TABLE_VIEW_LENGTH,
  serializeTableView,
} from "../../hooks/persisted-table-view-snapshot";
import {
  filterValidColumnOrder,
  filterValidColumnWidths,
  MAX_PRESERVED_COLUMN_IDS_PER_AXIS,
  NO_PRESERVED_COLUMN_IDS,
  partitionPreservedColumnIds,
  resizeColumnWidth,
} from "../preserved-column-ids";
import { PERSISTED_COLUMN_WIDTHS_SCHEMA } from "../view-state-axes";

const VALID_COLUMN_IDS: ReadonlySet<string> = new Set(["a", "b"]);

/**
 * ISS-9447 M4. The one rule the hook's own round-trip suite cannot reach: what
 * gets carried is decided by the width as well as the id.
 *
 * Through the hook both halves look identical, because the APPLIED filter drops
 * an unknown id either way. Only here can a malformed width for an unknown id be
 * told apart from a well-formed one.
 */
describe("partitionPreservedColumnIds", () => {
  it("carries an unknown id's width across, but never a malformed one", () => {
    const preserved = partitionPreservedColumnIds(
      {
        columnWidths: {
          a: 120,
          "future-column": 240,
          "malformed-column": Number.NaN,
          "negative-column": -8,
        },
      },
      VALID_COLUMN_IDS
    );

    // Version skew is what D1 preserves. A width that is not a width is corrupt
    // data, and writing it back under the banner of forward compatibility would
    // persist a bad value — so it is dropped, exactly as it is for a known id.
    expect(preserved.columnWidths).toEqual({ "future-column": 240 });
  });

  it("carries a width at the ceiling but not one past it", () => {
    const preserved = partitionPreservedColumnIds(
      {
        columnWidths: {
          "at-ceiling-column": 10_000,
          "max-value-column": Number.MAX_VALUE,
          "past-ceiling-column": 10_001,
          "sub-pixel-column": 120.5,
        },
      },
      VALID_COLUMN_IDS
    );

    // `Number.MAX_VALUE` is finite and positive, so a floor alone stores it and
    // the column becomes an enormous CSS track the moment a build knows the id
    // again — the magnitude case the repo's bad-data rule names as the one that
    // actually reaches storage. The literals are deliberate: they pin the
    // CHOSEN ceiling, so moving it has to be a decision rather than a silently
    // passing test. The bound is inclusive, and a fractional width stays usable
    // — a real drag on a fractional-DPR display produces one.
    expect(preserved.columnWidths).toEqual({
      "at-ceiling-column": 10_000,
      "sub-pixel-column": 120.5,
    });
  });
});

/**
 * ISS-9449. The carry is BOUNDED: past `MAX_PRESERVED_COLUMN_IDS_PER_AXIS` the
 * oldest carried entries go, and "oldest" is read off the layout
 * `mergePreservedColumnIds` writes — arrays put the carry after the applied
 * ids (so the tail is the oldest), widths spread the carry first (so the front
 * is the oldest). A recognized id is partitioned to the applied half before the
 * cap runs, so it can never be the one dropped.
 */
describe("partitionPreservedColumnIds — the per-axis cap", () => {
  const ids = (count: number, prefix: string) =>
    Array.from({ length: count }, (_, index) => `${prefix}${index}`);

  it("carries exactly the cap whole", () => {
    const unknown = ids(MAX_PRESERVED_COLUMN_IDS_PER_AXIS, "u");
    const preserved = partitionPreservedColumnIds(
      { columnOrder: unknown, hiddenColumns: unknown },
      VALID_COLUMN_IDS
    );
    expect(preserved.columnOrder).toEqual(unknown);
    expect(preserved.hiddenColumns).toEqual(unknown);
  });

  it("drops the TAIL of a carried array past the cap — the oldest carry", () => {
    const unknown = ids(MAX_PRESERVED_COLUMN_IDS_PER_AXIS + 1, "u");
    const preserved = partitionPreservedColumnIds(
      { columnOrder: unknown, hiddenColumns: unknown },
      VALID_COLUMN_IDS
    );
    // The literal pins the CHOSEN cap: moving it is a decision, not a drift.
    expect(preserved.columnOrder).toHaveLength(64);
    expect(preserved.columnOrder).toEqual(unknown.slice(0, 64));
    expect(preserved.hiddenColumns).toEqual(unknown.slice(0, 64));
    expect(preserved.columnOrder).not.toContain("u64");
  });

  it("drops the FRONT of the carried widths past the cap — the oldest carry", () => {
    const columnWidths = Object.fromEntries(
      ids(MAX_PRESERVED_COLUMN_IDS_PER_AXIS + 2, "w").map((id, index) => [
        id,
        100 + index,
      ])
    );
    const preserved = partitionPreservedColumnIds(
      { columnWidths },
      VALID_COLUMN_IDS
    );
    expect(Object.keys(preserved.columnWidths)).toHaveLength(64);
    expect(preserved.columnWidths).not.toHaveProperty("w0");
    expect(preserved.columnWidths).not.toHaveProperty("w1");
    expect(preserved.columnWidths.w2).toBe(102);
    expect(preserved.columnWidths.w65).toBe(165);
  });

  it("never lets the cap reach a recognized id", () => {
    const unknown = ids(MAX_PRESERVED_COLUMN_IDS_PER_AXIS + 5, "u");
    // Recognized ids sit at the very end, where an array cap would cut.
    const columnOrder = [...unknown, "a", "b"];
    const columnWidths = {
      ...Object.fromEntries(unknown.map((id) => [id, 120])),
      a: 200,
    };
    const preserved = partitionPreservedColumnIds(
      { columnOrder, columnWidths, hiddenColumns: [...unknown, "b"] },
      VALID_COLUMN_IDS
    );
    // The applied half is untouched by the cap: neither carried nor dropped.
    expect(preserved.columnOrder).not.toContain("a");
    expect(preserved.columnOrder).not.toContain("b");
    expect(preserved.hiddenColumns).not.toContain("b");
    expect(preserved.columnWidths).not.toHaveProperty("a");
    expect(preserved.columnOrder).toHaveLength(64);
    expect(Object.keys(preserved.columnWidths)).toHaveLength(64);
  });
});

/**
 * ISS-9447 (review). The PARSE boundary and the CARRY/APPLY boundary have to
 * answer "is this a width" identically.
 *
 * They did not. `PERSISTED_COLUMN_WIDTHS_SCHEMA` was `finite && > 0` with no
 * ceiling while `partitionPreservedColumnIds` refused anything past 10_000, so a
 * stored 10001 survived into a named Branches view's arrangement and was
 * filtered out of the live one — and the modified-marker comparison, which holds
 * the saved map against the filtered live map, then read the view as "Modified"
 * the instant it opened. Nothing the reader could do reconciled it.
 *
 * Driven as an AGREEMENT rather than as two copies of a constant: the defect was
 * a disagreement, so the assertion is that both boundaries reach the same
 * verdict on the same input. Move either predicate and this reddens.
 */
describe("the width predicate is one predicate", () => {
  it.each([
    ["at the ceiling", 10_000, true],
    ["past the ceiling", 10_001, false],
    ["an implausible magnitude", Number.MAX_VALUE, false],
    ["sub-pixel", 120.5, true],
    ["zero", 0, false],
  ])("agrees on a width %s", (_case, width, usable) => {
    const parsed = PERSISTED_COLUMN_WIDTHS_SCHEMA.parse({ unknown: width });
    const carried = partitionPreservedColumnIds(
      { columnWidths: { unknown: width } },
      VALID_COLUMN_IDS
    );

    expect(Object.hasOwn(parsed, "unknown")).toBe(usable);
    expect(Object.hasOwn(carried.columnWidths, "unknown")).toBe(usable);
  });
});

/**
 * ISS-9449 (review). The applied order is the axis a corrupt record could make
 * arbitrarily long out of ids this build KNOWS — every other axis is bounded by
 * its own shape (a `Set`, a `Record`, the per-axis carry cap). Shedding the
 * carry cannot shrink an order made of recognized ids, so without a dedupe a
 * record of one known id repeated past the serialized ceiling is refused on
 * every write and the reader's edits never persist.
 */
describe("filterValidColumnOrder", () => {
  it("keeps each known id once, in first-seen order", () => {
    expect(
      filterValidColumnOrder(["b", "a", "b", "a", "b"], VALID_COLUMN_IDS)
    ).toEqual(["b", "a"]);
  });

  it("drops ids this build has no column for", () => {
    // The carry, not this axis, is where an unknown id belongs.
    expect(
      filterValidColumnOrder(["a", "future-column", "b"], VALID_COLUMN_IDS)
    ).toEqual(["a", "b"]);
  });

  it("bounds the axis by the column count, whatever the record's length", () => {
    const corrupt = Array.from({ length: 20_000 }, () => "a");
    expect(filterValidColumnOrder(corrupt, VALID_COLUMN_IDS)).toEqual(["a"]);
    expect(
      filterValidColumnOrder([...corrupt, "b", ...corrupt], VALID_COLUMN_IDS)
        .length
    ).toBeLessThanOrEqual(VALID_COLUMN_IDS.size);
  });

  it("is identity on a well-formed order", () => {
    // The dedupe changes only a record no build writes, which is what makes it
    // safe to run on every restore and every applied view.
    expect(filterValidColumnOrder(["b", "a"], VALID_COLUMN_IDS)).toEqual([
      "b",
      "a",
    ]);
    expect(filterValidColumnOrder(undefined, VALID_COLUMN_IDS)).toEqual([]);
  });
});

/**
 * ISS-10356. A width-only id (Sessions' `custom-field:*`) is one this build
 * draws but does not declare: its width is APPLIED, never carried as skew, and
 * — being open-ended — bounded by the custom-field limit, not the carry's cap.
 * Its hidden and order entries are not width-only, so they stay the skew they
 * always were.
 */
describe("width-only column ids", () => {
  const isWidthOnly = (id: string) => id.startsWith("custom-field:");

  it("applies a width-only id's width instead of carrying it, and nothing else about it", () => {
    const stored = {
      columnOrder: ["custom-field:x"],
      columnWidths: { a: 120, "custom-field:x": 200, "future-column": 240 },
      hiddenColumns: ["custom-field:x"],
    };

    expect(
      filterValidColumnWidths(
        stored.columnWidths,
        VALID_COLUMN_IDS,
        isWidthOnly
      )
    ).toEqual({ a: 120, "custom-field:x": 200 });
    expect(
      partitionPreservedColumnIds(stored, VALID_COLUMN_IDS, isWidthOnly)
    ).toEqual({
      columnOrder: ["custom-field:x"],
      columnWidths: { "future-column": 240 },
      hiddenColumns: ["custom-field:x"],
    });
  });

  it("keeps a width-only width past the carry's skew cap (whitlockk, PR #8117)", () => {
    const columnWidths = customFieldWidths(
      MAX_PRESERVED_COLUMN_IDS_PER_AXIS + 1
    );

    expect(
      filterValidColumnWidths(columnWidths, VALID_COLUMN_IDS, isWidthOnly)
    ).toEqual(columnWidths);
  });

  it("applies at most one width per custom field an org may define, dropping the oldest", () => {
    const columnWidths = {
      a: 150,
      ...customFieldWidths(MAX_CUSTOM_FIELDS_PER_ORG + 2),
    };

    const applied = filterValidColumnWidths(
      columnWidths,
      VALID_COLUMN_IDS,
      isWidthOnly
    );

    // The width-only cap plus the declared one, which the cap never reaches.
    expect(Object.keys(applied)).toHaveLength(MAX_CUSTOM_FIELDS_PER_ORG + 1);
    expect(applied.a).toBe(150);
    expect(applied).not.toHaveProperty("custom-field:0");
    expect(applied).not.toHaveProperty("custom-field:1");
    expect(applied[`custom-field:${MAX_CUSTOM_FIELDS_PER_ORG + 1}`]).toBe(
      100 + MAX_CUSTOM_FIELDS_PER_ORG + 1
    );
  });

  it("drops the width resized longest ago, not the one first resized", () => {
    const atCap = customFieldWidths(MAX_CUSTOM_FIELDS_PER_ORG);

    const refreshed = resizeColumnWidth(
      atCap,
      { id: "custom-field:0", widthPx: 222 },
      VALID_COLUMN_IDS,
      isWidthOnly
    );
    const next = resizeColumnWidth(
      refreshed,
      { id: "custom-field:new", widthPx: 333 },
      VALID_COLUMN_IDS,
      isWidthOnly
    );

    expect(Object.keys(next)).toHaveLength(MAX_CUSTOM_FIELDS_PER_ORG);
    expect(next["custom-field:0"]).toBe(222);
    expect(next["custom-field:new"]).toBe(333);
    expect(next).not.toHaveProperty("custom-field:1");
  });

  it("serializes a view at the width-only cap within the write ceiling (ISS-9449)", () => {
    // The widest a real entry gets: a UUID id (`CustomField.id`) and the
    // longest spelling a usable width can take.
    const columnWidths = Object.fromEntries(
      Array.from({ length: MAX_CUSTOM_FIELDS_PER_ORG }, (_, i) => [
        `custom-field:${String(i).padStart(8, "0")}-0000-7000-8000-000000000000`,
        2.225_073_858_507_201_4e-308,
      ])
    );

    const serialized = serializeTableView({
      columnOrder: [],
      columnWidths,
      extras: {},
      hiddenColumns: [],
      opaqueFields: {},
      pageSize: 25,
      preservedColumnIds: NO_PRESERVED_COLUMN_IDS,
      sortDir: "desc",
      sortKey: null,
    });

    expect(serialized).not.toBeNull();
    expect(serialized?.length).toBeLessThan(MAX_SERIALIZED_TABLE_VIEW_LENGTH);
  });
});

function customFieldWidths(count: number): Record<string, number> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`custom-field:${i}`, 100 + i])
  );
}
