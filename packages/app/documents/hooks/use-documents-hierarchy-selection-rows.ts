"use client";

import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import {
  buildCollapseVisibleItems,
  buildRenderedItems,
} from "@repo/app/documents/lib/table-view-pipeline";
import { useMemo } from "react";
import { useContextGroupExpansion } from "./use-context-group-expansion";
import { useHierarchyPlacement } from "./use-hierarchy-placement";

type HierarchySelectionRowsInput = Parameters<
  typeof buildCollapseVisibleItems
>[0] & {
  contextExpandedIds: Set<string>;
  isGroupExpanded: (key: string) => boolean;
  toggleGroup: (key: string) => void;
  isTreeGroupExpanded: (key: string) => boolean;
  projectId: string | undefined;
  projectVersion: string | undefined;
  currentOrderingEnabled: boolean;
  renderedItems: DocumentRowItem[];
  selectedIds: ReadonlySet<string>;
  treeRoots: DocumentRowItem[];
};

/** Keep selection and paint projections aligned with the expansion mode the body renders. */
export function useDocumentsHierarchySelectionRows({
  contextExpandedIds,
  isGroupExpanded,
  toggleGroup,
  isTreeGroupExpanded,
  projectId,
  projectVersion,
  currentOrderingEnabled,
  renderedItems,
  selectedIds,
  treeRoots,
  groupBy,
  gridGroups,
  isGroupedView,
  flatItems,
  groups,
  isSectionExpanded,
}: HierarchySelectionRowsInput) {
  const manualExpansion = useContextGroupExpansion({
    contextExpandedIds,
    defaultExpanded: true,
    isGroupExpanded,
    toggleGroup,
  });
  const manuallyExpandedItems = useMemo(
    (): DocumentRowItem[] =>
      buildRenderedItems({
        groupBy,
        gridGroups,
        isGroupedView,
        flatItems,
        groups,
        isGroupExpanded: manualExpansion.isTreeGroupExpanded,
      }),
    [
      groupBy,
      gridGroups,
      isGroupedView,
      flatItems,
      groups,
      manualExpansion.isTreeGroupExpanded,
    ]
  );
  const hierarchyPlacement = useHierarchyPlacement({
    projectId,
    projectVersion,
    currentOrderingEnabled,
    renderedItems: manuallyExpandedItems,
    selectedIds,
    treeRoots,
    onInsidePlaced: manualExpansion.expandTreeGroup,
  });
  const visibleRenderedItems = hierarchyPlacement.enabled
    ? manuallyExpandedItems
    : renderedItems;
  const selectableRenderedItems = useMemo(
    () =>
      hierarchyPlacement.enabled
        ? visibleRenderedItems.filter((item) => item.kind === "document")
        : visibleRenderedItems,
    [hierarchyPlacement.enabled, visibleRenderedItems]
  );
  const activeExpansion = hierarchyPlacement.enabled
    ? manualExpansion.isTreeGroupExpanded
    : isTreeGroupExpanded;
  const paintedItems = useMemo(
    () =>
      buildCollapseVisibleItems({
        groupBy,
        gridGroups,
        isGroupedView,
        flatItems,
        groups,
        isGroupExpanded: activeExpansion,
        isSectionExpanded,
      }),
    [
      groupBy,
      gridGroups,
      isGroupedView,
      flatItems,
      groups,
      activeExpansion,
      isSectionExpanded,
    ]
  );
  const selectablePaintedItems = useMemo(
    () =>
      hierarchyPlacement.enabled
        ? paintedItems.filter((item) => item.kind === "document")
        : paintedItems,
    [hierarchyPlacement.enabled, paintedItems]
  );

  return {
    hierarchyPlacement,
    manualExpansion,
    paintedItems,
    selectablePaintedItems,
    selectableRenderedItems,
    visibleRenderedItems,
  };
}

/** Resolve the move request from the same visible population used by selection. */
export function collectHierarchyMoveEntities(
  selectedIds: ReadonlySet<string>,
  renderedItems: readonly DocumentRowItem[]
) {
  return renderedItems
    .filter((item) => selectedIds.has(item.data.id))
    .map((item) => ({ id: item.data.id }));
}
