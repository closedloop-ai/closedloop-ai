"use client";

import type {
  DragCancelEvent,
  DragEndEvent,
  DragMoveEvent,
  DragOverEvent,
  DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  type ProjectArtifactPlacementPosition as PlacementPosition,
  ProjectArtifactPlacementPosition,
} from "@repo/api/src/types/project-artifact-placement";
import { DndProvider } from "@repo/app/shared/components/dnd-provider";
import {
  DragPreviewChip,
  type DragPreviewChipProps,
} from "@repo/design-system/components/ui/drag-preview-chip";
import {
  focusSortableSubtreeHandle,
  sortableSubtreeAnnouncementLabel,
  sortableSubtreeAnnouncements,
} from "@repo/design-system/components/ui/sortable-subtree";
import { type ReactNode, useRef, useState } from "react";
import { createPortal } from "react-dom";

type DocumentsPlacementBodyProps = {
  children: ReactNode;
  enabled: boolean;
  itemIds: string[];
  manualPlacementEnabled: boolean;
  onDragCancel?: (event: DragCancelEvent) => void;
  onDragEnd: (event: DragEndEvent) => void;
  onDragMove?: (event: DragMoveEvent) => void;
  onDragOver?: (event: DragOverEvent) => void;
  placementPreview?: {
    position: PlacementPosition;
    targetArtifactId: string;
  } | null;
};

/** Keeps drag providers out of document-list surfaces where ordering is inactive. */
export function DocumentsPlacementBody({
  children,
  enabled,
  itemIds,
  manualPlacementEnabled,
  onDragCancel,
  onDragEnd,
  onDragMove,
  onDragOver,
  placementPreview,
}: Readonly<DocumentsPlacementBodyProps>) {
  const suppressNextClick = useRef(false);
  const placementContainerRef = useRef<HTMLDivElement>(null);
  const dragPreviewStart = useRef<DragPreviewChipProps | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreviewChipProps | null>(
    null
  );
  if (!enabled) {
    return children;
  }
  if (!manualPlacementEnabled) {
    return (
      <DndProvider onDragEnd={onDragEnd}>
        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
          {children}
        </SortableContext>
      </DndProvider>
    );
  }
  return (
    <DndProvider
      announcements={sortableSubtreeAnnouncements}
      onDragCancel={(event) => {
        dragPreviewStart.current = null;
        setDragPreview(null);
        suppressNextClick.current = false;
        onDragCancel?.(event);
      }}
      onDragEnd={(event) => {
        dragPreviewStart.current = null;
        setDragPreview(null);
        onDragEnd(event);
        if (event.activatorEvent.type === "pointerdown") {
          focusSortableSubtreeHandle(
            globalThis.document,
            String(event.active.id)
          );
        }
      }}
      onDragMove={(event) => {
        const start = dragPreviewStart.current;
        if (start) {
          setDragPreview({
            ...start,
            y: start.y + event.delta.y,
          });
        }
        onDragMove?.(event);
      }}
      onDragOver={onDragOver}
      onDragStart={(event) => {
        suppressNextClick.current = event.activatorEvent.type === "pointerdown";
        const preview = pointerDragPreview(event);
        dragPreviewStart.current = preview;
        setDragPreview(preview);
      }}
    >
      <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
        <div
          onClickCapture={(event) => {
            if (!suppressNextClick.current) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            suppressNextClick.current = false;
          }}
          onKeyDownCapture={() => {
            suppressNextClick.current = false;
          }}
          onPointerDownCapture={() => {
            suppressNextClick.current = false;
          }}
          ref={placementContainerRef}
        >
          {children}
        </div>
      </SortableContext>
      {dragPreview
        ? createPortal(
            <DragPreviewChip
              {...dragPreview}
              dropTarget={resolvePreviewDropTarget(
                placementContainerRef.current,
                placementPreview
              )}
            />,
            globalThis.document.body
          )
        : null}
    </DndProvider>
  );
}

function resolvePreviewDropTarget(
  container: HTMLElement | null,
  preview: DocumentsPlacementBodyProps["placementPreview"]
): DragPreviewChipProps["dropTarget"] {
  if (
    !(container && preview) ||
    preview.position === ProjectArtifactPlacementPosition.Root
  ) {
    return undefined;
  }
  const subtree = Array.from(
    container.querySelectorAll<HTMLElement>("[data-sortable-subtree-id]")
  ).find(
    (candidate) =>
      candidate.dataset.sortableSubtreeId === preview.targetArtifactId
  );
  const rootRow = subtree?.firstElementChild;
  const element = rootRow instanceof HTMLElement ? rootRow : subtree;
  return element ? { element, placement: preview.position } : undefined;
}

function pointerDragPreview(
  event: DragStartEvent
): DragPreviewChipProps | null {
  const activator = event.activatorEvent;
  const label = sortableSubtreeAnnouncementLabel(event.active);
  if (
    !label ||
    activator.type !== "pointerdown" ||
    !(activator instanceof globalThis.PointerEvent)
  ) {
    return null;
  }
  const handle = Array.from(
    globalThis.document.querySelectorAll<HTMLElement>(
      "[data-sortable-subtree-handle-id]"
    )
  ).find(
    (candidate) =>
      candidate.dataset.sortableSubtreeHandleId === String(event.active.id)
  );
  const row = handle?.closest<HTMLElement>("[data-sortable-subtree-id]");
  if (!(handle && row)) {
    return null;
  }
  return {
    label,
    sourceElement: row,
    x: handle.getBoundingClientRect().left,
    y: activator.clientY,
  };
}
