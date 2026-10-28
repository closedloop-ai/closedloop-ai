import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { getItemTitle } from "@repo/app/documents/components/table/document-tree";
import type { FilterCategory } from "@repo/app/documents/components/table/filter-category";
import type { RowTypeConfig } from "@repo/app/documents/components/table/row-type-registry";

/**
 * Source emptiness per tab: the All view derives it from renderable tree
 * groups (documents + branch/session artifacts), the Branches tab from
 * collected branch rows, and the flat document categories from the filtered
 * documents list.
 */
export function computeIsSourceEmpty({
  filterCategory,
  isGroupedView,
  groupCount,
  branchItemCount,
  filteredDocumentCount,
}: {
  filterCategory: FilterCategory;
  isGroupedView: boolean;
  groupCount: number;
  branchItemCount: number;
  filteredDocumentCount: number;
}): boolean {
  if (filterCategory === "branches") {
    return branchItemCount === 0;
  }
  if (isGroupedView) {
    return groupCount === 0;
  }
  return filteredDocumentCount === 0;
}

/** Whether the current selected Documents view can offer Move to Project. */
export function canBulkMoveDocumentsSelection(input: {
  canUseDocumentBulkActions: boolean;
  filterCategory: FilterCategory;
  hierarchyPlacementEnabled: boolean;
}): boolean {
  return (
    input.canUseDocumentBulkActions &&
    (input.hierarchyPlacementEnabled ||
      input.filterCategory === "documents" ||
      input.filterCategory === "features" ||
      input.filterCategory === "plans" ||
      input.filterCategory === "all")
  );
}

/**
 * Delete-dialog copy for the two delete modes that share one dialog. A bulk
 * delete (`bulkCount > 0`) uses a generic "N items" heading with the default
 * confirmation body; a single-row delete pulls its heading and body from the
 * row-type registry (PLN-874 Task 3.5). Bulk takes precedence because
 * `handleConfirmDelete` dispatches on `pendingBulkIds.size`.
 */
export function computeDeleteDialogCopy({
  bulkCount,
  deleteTarget,
  config,
}: {
  bulkCount: number;
  deleteTarget: DocumentRowItem | null;
  config: RowTypeConfig | null;
}): { title: string; itemName: string; description: string | undefined } {
  if (bulkCount > 0) {
    return {
      title: "Items",
      itemName: `${bulkCount} item${bulkCount === 1 ? "" : "s"}`,
      description: undefined,
    };
  }
  if (!deleteTarget) {
    return { title: "Document", itemName: "", description: undefined };
  }
  const itemName = getItemTitle(deleteTarget);
  return {
    title: config?.deleteDialogTitle ?? "Document",
    itemName,
    description: config?.deleteDialogDescription?.(itemName) ?? undefined,
  };
}

/**
 * The board's band collapse, as the shared grid's port (ISS-9335).
 *
 * The board answers "is this section EXPANDED" and toggles; the grid asks "is
 * it COLLAPSED" and sets. Adapting here rather than inline keeps the inversion
 * in one place — a `!` dropped on one side of it would leave every band
 * rendering the opposite of what the reader last chose.
 *
 * The setter is guarded rather than a bare toggle: the grid states the value it
 * wants, and re-toggling on a call that already agrees would flip a band the
 * caller asked to leave alone.
 */
export function toBandCollapsePort(
  isSectionExpanded: (key: string) => boolean,
  toggleSection: (key: string) => void
): {
  isCollapsed: (groupKey: string) => boolean;
  setCollapsed: (groupKey: string, collapsed: boolean) => void;
} {
  return {
    isCollapsed: (groupKey) => !isSectionExpanded(groupKey),
    setCollapsed: (groupKey, collapsed) => {
      if (collapsed === isSectionExpanded(groupKey)) {
        toggleSection(groupKey);
      }
    },
  };
}

/**
 * The board's tree expansion, as the shared grid's port (ISS-9335). Same shape
 * as {@link toBandCollapsePort} without the inversion — both sides say
 * "expanded" — and with the same guard on the setter.
 */
export function toRowExpansionPort(
  isTreeGroupExpanded: (key: string) => boolean,
  toggleTreeGroup: (key: string) => void
): {
  isExpanded: (rowId: string) => boolean;
  setExpanded: (rowId: string, expanded: boolean) => void;
} {
  return {
    isExpanded: isTreeGroupExpanded,
    setExpanded: (rowId, expanded) => {
      if (expanded !== isTreeGroupExpanded(rowId)) {
        toggleTreeGroup(rowId);
      }
    },
  };
}
