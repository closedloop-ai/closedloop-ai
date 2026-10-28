import { HierarchyAvailability } from "@repo/api/src/types/project-tree";
import { TableCellValueState } from "@repo/design-system/components/ui/table-cell-value-state";
import { describe, expect, it } from "vitest";
import { hierarchyAvailabilityState } from "../hierarchy-availability-state";

describe("hierarchyAvailabilityState", () => {
  it.each([
    [HierarchyAvailability.Complete, null],
    [HierarchyAvailability.Partial, TableCellValueState.Partial],
    [HierarchyAvailability.PermissionHidden, TableCellValueState.Forbidden],
    [HierarchyAvailability.Unavailable, TableCellValueState.Unavailable],
    [HierarchyAvailability.Error, TableCellValueState.Error],
    [undefined, null],
    ["future-read-state", TableCellValueState.Unavailable],
  ])(
    "maps %s to %s without collapsing distinct read states",
    (value, expected) => {
      expect(hierarchyAvailabilityState(value)).toBe(expected);
    }
  );
});
