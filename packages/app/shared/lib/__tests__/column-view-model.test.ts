import { describe, expect, it } from "vitest";
import {
  admitFilterableGroups,
  type ColumnViewModel,
  filterableFacetIds,
  groupableColumnOptions,
  isFilterableColumn,
  isGroupableColumn,
  isSortableColumn,
  sortableColumnOptions,
} from "../column-view-model";

/**
 * ISS-9676 — the generic column view model the shared list controls read.
 *
 * The fixture below is a SYNTHETIC surface, not Branches: these assertions are
 * about the derivation rule, and pointing them at the real declaration would
 * make them agree with whatever that declaration currently says. The Branches
 * columns are pinned against independent literals in
 * `branches/lib/__tests__/branch-column-view-model.test.ts`.
 */

const COLUMNS: readonly ColumnViewModel[] = [
  {
    id: "alpha",
    label: "Alpha",
    isSortable: true,
    isFilterable: true,
    filterFacetId: "alphaFacet",
    isGroupable: true,
    groupLabel: "Alpha dimension",
  },
  {
    id: "beta",
    label: "Beta",
    isSortable: false,
    isFilterable: true,
    filterFacetId: "betaFacet",
    isGroupable: false,
    groupLabel: null,
  },
  {
    id: "gamma",
    label: "Gamma",
    isSortable: true,
    isFilterable: false,
    filterFacetId: null,
    isGroupable: false,
    groupLabel: null,
  },
];

describe("sortableColumnOptions", () => {
  it("offers only the columns declaring isSortable, under their headers", () => {
    expect(sortableColumnOptions(COLUMNS)).toEqual([
      { id: "alpha", label: "Alpha" },
      { id: "gamma", label: "Gamma" },
    ]);
  });

  it("offers nothing when no column declares isSortable", () => {
    const none = COLUMNS.map((column) => ({ ...column, isSortable: false }));

    expect(sortableColumnOptions(none)).toEqual([]);
  });
});

describe("groupableColumnOptions", () => {
  // The dimension's own name, not the column header: "Alpha dimension" is what
  // the group menu says, and reading `label` here would silently rename it.
  it("offers the groupable columns under their group label", () => {
    expect(groupableColumnOptions(COLUMNS)).toEqual([
      { id: "alpha", label: "Alpha dimension" },
    ]);
  });
});

describe("admitFilterableGroups", () => {
  it("keeps a facet a column declares and drops one no column does", () => {
    const admitted = admitFilterableGroups(COLUMNS, [
      { id: "alphaFacet" },
      { id: "gammaFacet" },
      { id: "betaFacet" },
    ]);

    expect(admitted).toEqual([{ id: "alphaFacet" }, { id: "betaFacet" }]);
  });

  it("preserves the caller's order rather than the view model's", () => {
    const admitted = admitFilterableGroups(COLUMNS, [
      { id: "betaFacet" },
      { id: "alphaFacet" },
    ]);

    expect(admitted.map((group) => group.id)).toEqual([
      "betaFacet",
      "alphaFacet",
    ]);
  });

  it("drops a facet whose column stops declaring isFilterable", () => {
    const narrowed: readonly ColumnViewModel[] = COLUMNS.map((column) =>
      column.id === "beta"
        ? { ...column, isFilterable: false, filterFacetId: null }
        : column
    );

    expect(admitFilterableGroups(narrowed, [{ id: "betaFacet" }])).toEqual([]);
  });
});

describe("per-column predicates", () => {
  it("reports each declared capability and denies an unknown column", () => {
    expect(isSortableColumn(COLUMNS, "alpha")).toBe(true);
    expect(isSortableColumn(COLUMNS, "beta")).toBe(false);
    expect(isFilterableColumn(COLUMNS, "beta")).toBe(true);
    expect(isFilterableColumn(COLUMNS, "gamma")).toBe(false);
    expect(isGroupableColumn(COLUMNS, "alpha")).toBe(true);
    expect(isGroupableColumn(COLUMNS, "gamma")).toBe(false);
    expect(isSortableColumn(COLUMNS, "nope")).toBe(false);
    expect(isFilterableColumn(COLUMNS, "nope")).toBe(false);
    expect(isGroupableColumn(COLUMNS, "nope")).toBe(false);
  });

  it("collects the admitted facet ids", () => {
    expect([...filterableFacetIds(COLUMNS)]).toEqual([
      "alphaFacet",
      "betaFacet",
    ]);
  });
});
