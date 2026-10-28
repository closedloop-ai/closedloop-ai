"use client";

import type { DragEndEvent, DragMoveEvent, DragOverEvent } from "@dnd-kit/core";
import {
  ProjectArtifactPlacementPosition,
  ProjectArtifactPlacementSource,
} from "@repo/api/src/types/project-artifact-placement";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { isDocumentRowItem } from "@repo/app/documents/components/table/row-type-registry";
import {
  getDocumentRowChildren,
  getDocumentRowId,
} from "@repo/app/documents/lib/documents-grid-groups";
import { useArtifactPlacement } from "@repo/app/projects/hooks/use-artifact-placement";
import {
  ARTIFACT_PLACEMENT_FAILED_MESSAGE,
  ARTIFACT_PLACEMENT_MOVED_MESSAGE,
} from "@repo/app/projects/lib/artifact-placement-copy";
import { useManualArtifactOrderingEnabled } from "@repo/app/shared/feature-flags/use-manual-artifact-ordering";
import {
  fitsHierarchyPlacementDepth,
  type HierarchyPlacementDirection,
  type HierarchyPlacementRow,
  resolveHierarchyKeyboardPlacement,
} from "@repo/app/shared/lib/hierarchy-placement";
import { focusSortableSubtreeHandle } from "@repo/design-system/components/ui/sortable-subtree";
import { useMemo, useRef, useState } from "react";

type UseHierarchyPlacementInput = {
  projectId: string | undefined;
  projectVersion: string | undefined;
  currentOrderingEnabled: boolean;
  renderedItems: DocumentRowItem[];
  selectedIds: ReadonlySet<string>;
  treeRoots: DocumentRowItem[];
  onInsidePlaced?: (parentId: string) => void;
};

/** Bind mastered hierarchy placement to the existing Documents View rank surface. */
export function useHierarchyPlacement({
  projectId,
  projectVersion,
  currentOrderingEnabled,
  renderedItems,
  selectedIds,
  treeRoots,
  onInsidePlaced,
}: UseHierarchyPlacementInput) {
  const flagEnabled = useManualArtifactOrderingEnabled();
  const enabled = Boolean(projectId && flagEnabled && currentOrderingEnabled);
  const placement = useArtifactPlacement(projectId ?? "", enabled);
  const [announcement, setAnnouncement] = useState("");
  const [preview, setPreview] = useState<{
    targetArtifactId: string;
    position: ProjectArtifactPlacementPosition;
  } | null>(null);
  // Drag callbacks publish synchronously; release refreshes this same snapshot.
  const latestPlacement = useRef<typeof preview>(null);
  const visibleIds = useMemo(
    () => renderedItems.filter(isDocumentRowItem).map((item) => item.data.id),
    [renderedItems]
  );
  const documentIds = useMemo(() => new Set(visibleIds), [visibleIds]);
  const hierarchyRows = useMemo(
    () => buildHierarchyRows(treeRoots),
    [treeRoots]
  );
  const hierarchyRowIndexById = useMemo(
    () => new Map(hierarchyRows.map((row, index) => [row.id, index])),
    [hierarchyRows]
  );
  const parentById = useMemo(
    () => new Map(hierarchyRows.map(({ id, parentId }) => [id, parentId])),
    [hierarchyRows]
  );

  const mutatePlacement = (
    sourceArtifactIds: string[],
    targetArtifactId: string | undefined,
    position: ProjectArtifactPlacementPosition,
    source: Exclude<
      ProjectArtifactPlacementSource,
      typeof ProjectArtifactPlacementSource.Undo
    >
  ) => {
    if (!(enabled && projectId)) {
      return;
    }
    placement.mutate(
      {
        sourceArtifactIds,
        destinationProjectId: projectId,
        position,
        ...(targetArtifactId ? { targetArtifactId } : {}),
        ...(projectVersion
          ? { expectedProjectVersions: { [projectId]: projectVersion } }
          : {}),
        source,
      },
      {
        onSuccess: () => {
          setAnnouncement(ARTIFACT_PLACEMENT_MOVED_MESSAGE);
          if (
            position === ProjectArtifactPlacementPosition.Inside &&
            targetArtifactId
          ) {
            onInsidePlaced?.(targetArtifactId);
            globalThis.requestAnimationFrame?.(() => {
              focusSortableSubtreeHandle(
                globalThis.document,
                sourceArtifactIds[0] ?? ""
              );
            });
          }
        },
        onError: () => setAnnouncement(ARTIFACT_PLACEMENT_FAILED_MESSAGE),
      }
    );
  };

  // One admission for the sortable, native-grid and keyboard paths: Document
  // rows only (ISS-12893 AC3), and PRD-725's scope line "silent rejection of
  // circular ancestry and moves beyond four visible levels" (ISS-12893 AC5).
  // The depth rule is for project placement only.
  const placementIsAllowed = (
    activeId: string,
    targetId: string,
    position: Exclude<
      ProjectArtifactPlacementPosition,
      typeof ProjectArtifactPlacementPosition.Root
    >
  ): boolean => {
    if (!(enabled && documentIds.has(activeId) && documentIds.has(targetId))) {
      return false;
    }
    const sourceIds = orderedSourceIds(activeId, visibleIds, selectedIds);
    return (
      !isSourceOrDescendant(targetId, sourceIds, parentById) &&
      fitsHierarchyPlacementDepth(
        hierarchyRows,
        hierarchyRowIndexById,
        sourceIds,
        targetId,
        position
      )
    );
  };

  const placementForEvent = (
    event: DragEndEvent | DragOverEvent | DragMoveEvent
  ) => {
    const targetArtifactId = event.over ? String(event.over.id) : undefined;
    const position = pointerPosition(event);
    if (
      !(
        targetArtifactId &&
        placementIsAllowed(String(event.active.id), targetArtifactId, position)
      )
    ) {
      return null;
    }
    return {
      targetArtifactId,
      position,
    };
  };

  const updatePreview = (event: DragOverEvent | DragMoveEvent) => {
    const nextPlacement = placementForEvent(event);
    latestPlacement.current = nextPlacement;
    setPreview(nextPlacement);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    latestPlacement.current = placementForEvent(event);
    const settledPlacement = latestPlacement.current;
    latestPlacement.current = null;
    setPreview(null);
    if (!(enabled && settledPlacement)) {
      return;
    }
    mutatePlacement(
      orderedSourceIds(String(event.active.id), visibleIds, selectedIds),
      settledPlacement.targetArtifactId,
      settledPlacement.position,
      ProjectArtifactPlacementSource.Pointer
    );
  };

  const handleDragOver = (event: DragOverEvent) => {
    updatePreview(event);
  };

  const handleKeyboardPlacement = (
    artifactId: string,
    direction: HierarchyPlacementDirection
  ) => {
    if (!documentIds.has(artifactId)) {
      return;
    }
    const sourceArtifactIds = orderedSourceIds(
      artifactId,
      visibleIds,
      selectedIds
    );
    const target = resolveHierarchyKeyboardPlacement(
      hierarchyRows.filter((row) => documentIds.has(row.id)),
      artifactId,
      direction,
      new Set(sourceArtifactIds)
    );
    if (
      !(
        target &&
        fitsHierarchyPlacementDepth(
          hierarchyRows,
          hierarchyRowIndexById,
          sourceArtifactIds,
          target.targetArtifactId,
          target.position
        )
      )
    ) {
      return;
    }
    mutatePlacement(
      sourceArtifactIds,
      target.targetArtifactId,
      target.position,
      ProjectArtifactPlacementSource.Keyboard
    );
  };

  const canDropOnRow = (
    item: DocumentRowItem,
    target: DocumentRowItem,
    position: "before" | "inside" | "after"
  ): boolean => {
    if (!(isDocumentRowItem(item) && isDocumentRowItem(target))) {
      return false;
    }
    return placementIsAllowed(item.data.id, target.data.id, position);
  };

  const handleGridRowDrop = (
    item: DocumentRowItem,
    target: DocumentRowItem,
    position: "before" | "inside" | "after"
  ) => {
    if (!canDropOnRow(item, target, position)) {
      return;
    }
    mutatePlacement(
      orderedSourceIds(item.data.id, visibleIds, selectedIds),
      target.data.id,
      position,
      ProjectArtifactPlacementSource.Pointer
    );
  };

  return {
    announcement,
    canDragRow: (item: DocumentRowItem) => enabled && isDocumentRowItem(item),
    canDropOnRow,
    enabled,
    handleDragCancel: () => {
      latestPlacement.current = null;
      setPreview(null);
    },
    handleDragEnd,
    handleDragMove: updatePreview,
    handleDragOver,
    handleGridRowDrop,
    handleKeyboardPlacement,
    itemIds: enabled ? visibleIds : [],
    preview,
  };
}

function pointerPosition(
  event: DragEndEvent | DragOverEvent | DragMoveEvent
): Exclude<
  ProjectArtifactPlacementPosition,
  typeof ProjectArtifactPlacementPosition.Root
> {
  const target = event.over;
  const translated = event.active.rect.current.translated;
  if (!target) {
    return ProjectArtifactPlacementPosition.After;
  }
  const pointer = event.activatorEvent;
  let pointerY = target.rect.top + target.rect.height / 2;
  if (pointer.type === "pointerdown" && "clientY" in pointer) {
    pointerY = Number(pointer.clientY) + event.delta.y;
  } else if (translated) {
    pointerY = translated.top + translated.height / 2;
  }
  const row = Array.from(
    globalThis.document.querySelectorAll<HTMLElement>(
      "[data-sortable-subtree-id]"
    )
  ).find(
    (candidate) => candidate.dataset.sortableSubtreeId === String(target.id)
  )?.firstElementChild;
  const rootHeight = row?.getBoundingClientRect().height ?? target.rect.height;
  const ratio = (pointerY - target.rect.top) / rootHeight;
  if (ratio < 1 / 3) {
    return ProjectArtifactPlacementPosition.Before;
  }
  if (ratio > 2 / 3) {
    return ProjectArtifactPlacementPosition.After;
  }
  return ProjectArtifactPlacementPosition.Inside;
}

function orderedSourceIds(
  activeId: string,
  visibleIds: string[],
  selectedIds: ReadonlySet<string>
): string[] {
  if (!selectedIds.has(activeId)) {
    return [activeId];
  }
  return visibleIds.filter((id) => selectedIds.has(id));
}

function isSourceOrDescendant(
  targetId: string,
  sourceArtifactIds: readonly string[],
  parentById: ReadonlyMap<string, string | null>
): boolean {
  const sources = new Set(sourceArtifactIds);
  const visited = new Set<string>();
  let currentId: string | null = targetId;
  while (currentId && !visited.has(currentId)) {
    if (sources.has(currentId)) {
      return true;
    }
    visited.add(currentId);
    currentId = parentById.get(currentId) ?? null;
  }
  return currentId !== null;
}

function buildHierarchyRows(
  roots: readonly DocumentRowItem[]
): HierarchyPlacementRow[] {
  const rows: HierarchyPlacementRow[] = [];
  const visit = (
    items: readonly DocumentRowItem[],
    parentId: string | null,
    depth: number
  ) => {
    for (const item of items) {
      const id = getDocumentRowId(item);
      rows.push({ id, parentId, depth });
      visit(getDocumentRowChildren(item) ?? [], id, depth + 1);
    }
  };
  visit(roots, null, 0);
  return rows;
}
