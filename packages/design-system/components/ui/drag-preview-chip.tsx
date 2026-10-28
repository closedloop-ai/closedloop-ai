"use client";

import { GripVerticalIcon } from "lucide-react";

export type DragPreviewChipProps = {
  dropTarget?: {
    element: HTMLElement;
    placement: "before" | "inside" | "after";
  };
  label: string;
  sourceElement: HTMLElement;
  x: number;
  y: number;
};

/** A domain-free pointer drag preview shared by hierarchy and grid rows. */
export function DragPreviewChip({
  dropTarget,
  label,
  sourceElement,
  x,
  y,
}: DragPreviewChipProps) {
  const viewportWidth = globalThis.innerWidth;
  const sourceWidth = sourceElement.getBoundingClientRect().width;
  let visibleWidth =
    sourceWidth > 0 ? Math.min(viewportWidth, sourceWidth) : viewportWidth;
  for (
    let ancestor = sourceElement.parentElement;
    ancestor;
    ancestor = ancestor.parentElement
  ) {
    if (ancestor.clientWidth > 0) {
      visibleWidth = Math.min(visibleWidth, ancestor.clientWidth);
    }
  }
  const availableWidth = Math.max(0, Math.min(visibleWidth, viewportWidth - x));
  const top =
    dropTarget?.placement === "inside"
      ? Math.max(y, dropTarget.element.getBoundingClientRect().bottom)
      : y;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed z-50 flex translate-y-3 items-center gap-2 rounded-md border border-primary bg-background px-2 py-1 text-foreground"
      data-drag-preview-chip
      data-testid="drag-preview-chip"
      style={{
        left: x,
        maxWidth: `min(var(--container-sm), ${availableWidth}px)`,
        top,
        width: "max-content",
      }}
    >
      <GripVerticalIcon className="size-4 shrink-0" />
      <span className="min-w-0 truncate" data-drag-preview-title>
        {label}
      </span>
    </div>
  );
}
