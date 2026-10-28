"use client";

import type { Active, Announcements, Over } from "@dnd-kit/core";
import { useDndContext } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ariaPresentationProps } from "@closedloop-ai/design-system/lib/grid-table-aria";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import type {
  ComponentPropsWithRef,
  PointerEventHandler,
  ReactNode,
} from "react";
import { createContext, useContext } from "react";

const SORTABLE_SUBTREE_ANNOUNCEMENT_LABEL =
  "sortableSubtreeAnnouncementLabel" as const;
const SORTABLE_SUBTREE_HANDLE_ID = "data-sortable-subtree-handle-id" as const;
const SortableAncestorDragging = createContext(false);

export type SortableSubtreeHandle = {
  buttonProps: ComponentPropsWithRef<"button"> & {
    [SORTABLE_SUBTREE_HANDLE_ID]: string;
  };
};

export type SortableSubtreeRoot = SortableSubtreeHandle & {
  /** Pointer-only binding for a surface's approved row or title drag target. */
  pointerTargetProps: Pick<ComponentPropsWithRef<"div">, "onPointerDown">;
};

export type SortableSubtreeProps = {
  id: string;
  /** The owning surface supplies its existing accessible reorder label. */
  handleLabel: string;
  /** Human-readable row label used by drag orientation announcements. */
  announcementLabel?: string;
  /** Renders the root with an accessible handle and optional wider pointer target. */
  renderRoot: (bindings: SortableSubtreeRoot) => ReactNode;
  children?: ReactNode;
  /** Optional valid placement preview owned by the consuming hierarchy. */
  dropPosition?: "after" | "before" | "inside";
  /** Structural wrappers must not interrupt table ownership of their rows. */
  insideAriaTable?: boolean;
  /** Keeps a dragged row and its neighbors in place beneath a separate preview. */
  preserveSourcePosition?: boolean;
  /** Locks the rendered drag transform to the vertical axis for vertical lists. */
  restrictToVerticalAxis?: boolean;
};

/** Title-aware dnd-kit orientation copy that never exposes internal row ids. */
export const sortableSubtreeAnnouncements: Announcements = {
  onDragStart: ({ active }) => {
    const label = sortableSubtreeAnnouncementLabel(active);
    return label ? `Picked up draggable item ${label}.` : undefined;
  },
  onDragOver: ({ active, over }) => {
    const activeLabel = sortableSubtreeAnnouncementLabel(active);
    if (!activeLabel) {
      return undefined;
    }
    if (!over) {
      return `Draggable item ${activeLabel} is no longer over a droppable area.`;
    }
    const overLabel = sortableSubtreeAnnouncementLabel(over);
    return overLabel
      ? `Draggable item ${activeLabel} was moved over droppable area ${overLabel}.`
      : undefined;
  },
  // The owning mutation announces the authoritative result after it settles.
  onDragEnd: () => undefined,
  onDragCancel: ({ active }) => {
    const label = sortableSubtreeAnnouncementLabel(active);
    return label
      ? `Dragging was cancelled. Draggable item ${label} was dropped.`
      : undefined;
  },
};

/** Moves a root and its visible descendants as one unit without scaling unequal subtrees. */
export function SortableSubtree({
  announcementLabel,
  children,
  dropPosition,
  handleLabel,
  id,
  insideAriaTable = false,
  preserveSourcePosition = false,
  renderRoot,
  restrictToVerticalAxis = false,
}: SortableSubtreeProps) {
  const ancestorDragging = useContext(SortableAncestorDragging);
  const { active } = useDndContext();
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    id,
    data: sortableSubtreeAnnouncementData(announcementLabel),
  });
  const handlePointerDown: PointerEventHandler<HTMLDivElement> | undefined =
    listeners?.onPointerDown
      ? (event) => listeners.onPointerDown?.(event)
      : undefined;
  let visibleTransform = transform;
  if (ancestorDragging || (preserveSourcePosition && (active || isDragging))) {
    visibleTransform = null;
  } else if (restrictToVerticalAxis && transform) {
    visibleTransform = { ...transform, x: 0 };
  }
  const isLegacyDraggedSubtree =
    isDragging && !preserveSourcePosition && !restrictToVerticalAxis;

  return (
    <div
      {...ariaPresentationProps(insideAriaTable)}
      className={cn(
        "relative",
        isDragging &&
          preserveSourcePosition &&
          "bg-accent/40 [&>div>*]:bg-accent/40",
        dropPosition === "inside" && "ring-2 ring-primary ring-inset"
      )}
      data-drop-position={dropPosition}
      data-dragging={isDragging ? true : undefined}
      data-sortable-subtree-id={id}
      ref={setNodeRef}
      style={{
        opacity: isLegacyDraggedSubtree ? 0.4 : undefined,
        position: isLegacyDraggedSubtree ? "relative" : undefined,
        zIndex: isLegacyDraggedSubtree ? 1 : undefined,
        transform: CSS.Translate.toString(visibleTransform),
        transition:
          ancestorDragging || (preserveSourcePosition && (active || isDragging))
            ? undefined
            : transition,
      }}
    >
      <div className="relative">
        {renderRoot({
        buttonProps: {
          ...attributes,
          ...listeners,
          "aria-label": handleLabel,
          [SORTABLE_SUBTREE_HANDLE_ID]: String(id),
          ref: setActivatorNodeRef,
          type: "button",
        },
        pointerTargetProps: { onPointerDown: handlePointerDown },
        })}
        {dropPosition === "inside" ? (
          <span aria-hidden="true" className="pointer-events-none absolute inset-0 z-10 ring-2 ring-primary ring-inset" />
        ) : null}
      </div>
      {dropPosition === "before" || dropPosition === "after" ? (
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-x-0 z-10 h-px bg-primary",
            dropPosition === "before" ? "top-0" : "bottom-0"
          )}
          data-drop-line={dropPosition}
        />
      ) : null}
      <SortableAncestorDragging.Provider value={ancestorDragging || isDragging}>
        {children}
      </SortableAncestorDragging.Provider>
    </div>
  );
}

/** Restores focus to the existing handle for one sortable subtree. */
export function focusSortableSubtreeHandle(
  root: ParentNode,
  id: string
): boolean {
  const handle = Array.from(
    root.querySelectorAll<HTMLButtonElement>(`[${SORTABLE_SUBTREE_HANDLE_ID}]`)
  ).find(
    (candidate) => candidate.getAttribute(SORTABLE_SUBTREE_HANDLE_ID) === id
  );
  handle?.focus();
  return handle !== undefined;
}

export function sortableSubtreeAnnouncementLabel(
  item: Active | Over | null
): string | undefined {
  const label: unknown =
    item?.data.current?.[SORTABLE_SUBTREE_ANNOUNCEMENT_LABEL];
  return typeof label === "string" && label.trim().length > 0
    ? label
    : undefined;
}

/**
 * The drag `data` that {@link sortableSubtreeAnnouncements} reads its label
 * from, for a draggable or droppable registered outside `SortableSubtree`.
 */
export function sortableSubtreeAnnouncementData(label: string | undefined): {
  [SORTABLE_SUBTREE_ANNOUNCEMENT_LABEL]: string | undefined;
} {
  return { [SORTABLE_SUBTREE_ANNOUNCEMENT_LABEL]: label };
}
