import {
  HierarchyAvailability,
  type WireHierarchyAvailability,
} from "@repo/api/src/types/project-tree";
import { TableCellValueState } from "@repo/design-system/components/ui/table-cell-value-state";

/** Preserve each server read state in the existing table-cell vocabulary. */
export function hierarchyAvailabilityState(
  availability: WireHierarchyAvailability | undefined
): TableCellValueState | null {
  switch (availability) {
    case HierarchyAvailability.Error:
      return TableCellValueState.Error;
    case HierarchyAvailability.Partial:
      return TableCellValueState.Partial;
    case HierarchyAvailability.PermissionHidden:
      return TableCellValueState.Forbidden;
    case HierarchyAvailability.Unavailable:
      return TableCellValueState.Unavailable;
    case HierarchyAvailability.Complete:
    case undefined:
      return null;
    default:
      return TableCellValueState.Unavailable;
  }
}
