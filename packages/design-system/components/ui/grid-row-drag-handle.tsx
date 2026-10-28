"use client";

import {
  GridContextualAction,
  type GridContextualActionLegacyReveal,
} from "@closedloop-ai/design-system/components/ui/grid-interaction-contract";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import { GripVerticalIcon } from "lucide-react";
import type { ComponentProps } from "react";

export type GridRowDragHandleProps = Omit<
  ComponentProps<"button">,
  "aria-label" | "children" | "type"
> & {
  "aria-label": string;
  legacyReveal?: GridContextualActionLegacyReveal;
};

/**
 * The canonical six-dot row reorder affordance. It is a native drag source by
 * default while the owning row retains payload, eligibility, and movement
 * semantics.
 */
export function GridRowDragHandle({
  className,
  draggable = true,
  legacyReveal,
  ...props
}: GridRowDragHandleProps) {
  return (
    <GridContextualAction asChild legacyReveal={legacyReveal}>
      <button
        className={cn(
          "flex h-full min-h-6 w-6 shrink-0 cursor-grab items-center justify-center text-muted-foreground hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-30",
          className
        )}
        data-grid-row-drag-handle=""
        draggable={draggable}
        type="button"
        {...props}
      >
        <GripVerticalIcon className="size-4" />
      </button>
    </GridContextualAction>
  );
}
