import {
  appendTableSort,
  countActiveGroupingLevels,
  EMPTY_TABLE_GROUPING,
  removePrimaryGroupingLevel,
  removeTableSort,
  resolveFieldLabel,
  setPrimaryGroupingField,
  setPrimaryTableSort,
  setTableSortDirection,
  swapGroupingLevels,
  type TableGroupingState,
  TableGroupOrder,
} from "@closedloop-ai/design-system/components/ui/table-toolbar-model";
import { describe, expect, it } from "vitest";

/**
 * ISS-7051. The two-level grouping transitions are the only real logic in the
 * v2 toolbar, and every one of them is a rule that is easy to get subtly wrong
 * in a way no type catches:
 *
 *  - removing the primary level must PROMOTE the secondary, not ungroup;
 *  - choosing a field the other level already uses must drop that other level,
 *    or the table groups twice by one column and paints one row per group;
 *  - a swap must carry each level's order and empty-group setting with it.
 *
 * They live in the model as pure functions precisely so they can be pinned here
 * rather than through a popover, and so a surface that reproduces the toolbar
 * uses the same rules instead of its own.
 */

const STATUS_THEN_OWNER: TableGroupingState = {
  primary: {
    fieldId: "status",
    order: TableGroupOrder.Descending,
    showEmptyGroups: true,
  },
  secondary: {
    fieldId: "owner",
    order: TableGroupOrder.Ascending,
    showEmptyGroups: false,
  },
};

const STATUS_ONLY: TableGroupingState = {
  primary: STATUS_THEN_OWNER.primary,
  secondary: EMPTY_TABLE_GROUPING.secondary,
};

describe("countActiveGroupingLevels", () => {
  it.each([
    ["nothing grouped", EMPTY_TABLE_GROUPING, 0],
    ["one level", STATUS_ONLY, 1],
    ["two levels", STATUS_THEN_OWNER, 2],
  ])("counts %s", (_label, grouping, expected) => {
    expect(countActiveGroupingLevels(grouping)).toBe(expected);
  });
});

describe("removePrimaryGroupingLevel", () => {
  it("promotes the secondary level into the primary slot", () => {
    const next = removePrimaryGroupingLevel(STATUS_THEN_OWNER);

    // "group by Status, then Owner" minus Status is "group by Owner" — NOT an
    // ungrouped table, which is what dropping the level outright would give.
    expect(next.primary).toEqual(STATUS_THEN_OWNER.secondary);
    expect(next.secondary.fieldId).toBeNull();
  });

  it("carries the promoted level's order rather than resetting it", () => {
    const next = removePrimaryGroupingLevel({
      ...STATUS_THEN_OWNER,
      secondary: {
        fieldId: "owner",
        order: TableGroupOrder.Descending,
        showEmptyGroups: true,
      },
    });

    expect(next.primary.order).toBe(TableGroupOrder.Descending);
    expect(next.primary.showEmptyGroups).toBe(true);
  });

  it("ungroups when there is no secondary level to promote", () => {
    expect(removePrimaryGroupingLevel(STATUS_ONLY).primary.fieldId).toBeNull();
  });
});

describe("setPrimaryGroupingField", () => {
  it("drops the secondary level when the two would collide", () => {
    const next = setPrimaryGroupingField(STATUS_THEN_OWNER, "owner");

    expect(next.primary.fieldId).toBe("owner");
    expect(next.secondary.fieldId).toBeNull();
  });

  it("leaves a non-colliding secondary level alone", () => {
    const next = setPrimaryGroupingField(STATUS_THEN_OWNER, "priority");

    expect(next.primary.fieldId).toBe("priority");
    expect(next.secondary).toEqual(STATUS_THEN_OWNER.secondary);
  });

  it("clears both levels when the primary field is cleared", () => {
    expect(setPrimaryGroupingField(STATUS_THEN_OWNER, null)).toEqual(
      EMPTY_TABLE_GROUPING
    );
  });
});

describe("swapGroupingLevels", () => {
  it("exchanges the levels with their order and empty-group settings", () => {
    const next = swapGroupingLevels(STATUS_THEN_OWNER);

    expect(next.primary).toEqual(STATUS_THEN_OWNER.secondary);
    expect(next.secondary).toEqual(STATUS_THEN_OWNER.primary);
  });

  it("is a no-op with only one level", () => {
    expect(swapGroupingLevels(STATUS_ONLY)).toEqual(STATUS_ONLY);
  });
});

describe("resolveFieldLabel", () => {
  const OPTIONS = [
    { id: "status", label: "Status" },
    { id: "owner", label: "Owner" },
  ];

  it("resolves a known field", () => {
    expect(resolveFieldLabel(OPTIONS, "owner", "None")).toBe("Owner");
  });

  it("falls back for no selection", () => {
    expect(resolveFieldLabel(OPTIONS, null, "None")).toBe("None");
  });

  it("falls back for a field that is no longer an option", () => {
    // A persisted saved view can name a column that has since been removed;
    // the menu must render its fallback rather than an empty trigger.
    expect(resolveFieldLabel(OPTIONS, "retired-column", "None")).toBe("None");
  });
});

describe("ordered table sorts", () => {
  const SORTS = [
    { fieldId: "status", direction: "asc" as const },
    { fieldId: "owner", direction: "desc" as const },
  ];

  it("appends a unique secondary sort without replacing the primary", () => {
    expect(appendTableSort(SORTS, "updated", "desc")).toEqual([
      ...SORTS,
      { fieldId: "updated", direction: "desc" },
    ]);
    expect(appendTableSort(SORTS, "status")).toEqual(SORTS);
  });

  it("updates and removes one clause without disturbing precedence", () => {
    expect(setTableSortDirection(SORTS, "owner", "asc")).toEqual([
      SORTS[0],
      { fieldId: "owner", direction: "asc" },
    ]);
    expect(removeTableSort(SORTS, "status")).toEqual([SORTS[1]]);
  });

  it("promotes a header-selected field while retaining secondary clauses", () => {
    expect(setPrimaryTableSort(SORTS, "owner", "asc")).toEqual([
      { fieldId: "owner", direction: "asc" },
      SORTS[0],
    ]);
  });
});
