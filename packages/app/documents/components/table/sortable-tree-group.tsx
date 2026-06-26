"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVerticalIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Wraps an entire tree group — the root row plus its visible children — in a
 * single `@dnd-kit` sortable node so a stack-rank drag moves the whole subtree
 * as a unit (PRD-421 / PLN-755). The transform/opacity applied to the wrapper
 * carry the root and every child together; wrapping only the root row (the
 * earlier approach) left children visually detached mid-drag.
 *
 * The grip handle is rendered into the ROOT row via `renderRoot` — only the
 * root carries the rank slot. Listeners + attributes bind to the grip button
 * only (not the wrapper) so row-internal interactive cells (assignee popover,
 * status dropdown, inline edits) stay clickable, matching the
 * `enum-option-builder.tsx` precedent.
 */
export function SortableTreeGroup({
  id,
  renderRoot,
  children,
}: {
  id: string;
  renderRoot: (dragHandle: ReactNode) => ReactNode;
  children?: ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style: React.CSSProperties = {
    // Translate-only (not `CSS.Transform`): groups have variable heights
    // (root + N children), and `CSS.Transform.toString` would also emit the
    // scaleX/scaleY dnd-kit derives from the active-vs-target size difference,
    // stretching a short group into a tall slot and squashing a tall group
    // into a short one. A vertical list only ever needs the y translation.
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    // Pin the dragged group above sibling rows while a drag is in flight so its
    // rows are not clipped by the next group's background. `position: relative`
    // is required for `zIndex` to take effect in normal block flow.
    position: isDragging ? "relative" : undefined,
    zIndex: isDragging ? 1 : undefined,
  };

  const dragHandle = (
    <button
      aria-label="Reorder row"
      className="flex h-6 w-6 cursor-grab items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground focus-visible:opacity-100 active:cursor-grabbing group-hover/row:opacity-100"
      type="button"
      {...attributes}
      {...listeners}
    >
      <GripVerticalIcon className="h-4 w-4" />
    </button>
  );

  return (
    <div ref={setNodeRef} style={style}>
      {renderRoot(dragHandle)}
      {children}
    </div>
  );
}
