"use client";

import {
  RankInteractionMode,
  shouldShowRankSlot,
} from "@repo/app/documents/components/table/sort-keys";
import { CHIP_FOCUS_RING_CLASS } from "@repo/design-system/components/ui/chip";
import { GridContextualAction } from "@repo/design-system/components/ui/grid-interaction-contract";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import { GripVerticalIcon } from "lucide-react";

/**
 * Build the inline rank slot rendered at the start of the name cell. The slot
 * lives inside the name column (not a dedicated grid column) so the header and
 * non-rank surfaces share one grid and the table gains no extra left gutter.
 * `reserveRankSlot` rows (tree children on rank surfaces) get an empty spacer
 * of the same width so root and child indentation stays aligned.
 */
export function buildRankSlot(
  mode: RankInteractionMode | undefined,
  dragHandle: React.ReactNode,
  reserveRankSlot: boolean
): React.ReactNode {
  if (shouldShowRankSlot(mode)) {
    return (
      <div
        className={cn(
          "flex h-7 shrink-0 items-center justify-center",
          RANK_SLOT_WIDTH_CLASS
        )}
      >
        <RankSlot dragHandle={dragHandle} mode={mode} />
      </div>
    );
  }
  if (reserveRankSlot) {
    return (
      <div
        aria-hidden="true"
        className={cn(RANK_SLOT_WIDTH_CLASS, "shrink-0")}
      />
    );
  }
  return null;
}

/**
 * Rank slot rendered at the start of a row's grid when the row participates
 * in stack-rank reordering (PRD-421 / PLN-755 Phase E). The parent supplies
 * `dragHandle` (the `@dnd-kit` grip button) for the `Enabled` mode; the
 * `DisabledGrouped` branch renders an explanatory greyed icon with a tooltip.
 * Both use the shared contextual reveal with the legacy row-hover fallback.
 */
function RankSlot({
  mode,
  dragHandle,
}: {
  mode: RankInteractionMode | undefined;
  dragHandle: React.ReactNode;
}) {
  if (mode === RankInteractionMode.Enabled) {
    return (
      <GridContextualAction asChild legacyReveal="rowGroup">
        {dragHandle}
      </GridContextualAction>
    );
  }
  if (mode === RankInteractionMode.DisabledGrouped) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <GridContextualAction asChild legacyReveal="rowGroup">
            <span className="flex h-6 w-6 cursor-not-allowed items-center justify-center text-muted-foreground/40">
              <GripVerticalIcon className="h-4 w-4" />
            </span>
          </GridContextualAction>
        </TooltipTrigger>
        <TooltipContent>{RANK_DISABLED_HINT}</TooltipContent>
      </Tooltip>
    );
  }
  return null;
}

/**
 * Width of the rank slot's track. The rendered slot and the empty spacer MUST
 * carry the same width: the slot only appears on root rows, so a spacer of any
 * other width cancels or doubles one level of child indentation
 * in the ungrouped document tree. One constant so the two cannot drift apart.
 */
export const RANK_SLOT_WIDTH_CLASS = "w-7";

/**
 * The `@dnd-kit` grip button's own presentation, owned here beside the slot
 * that positions it rather than by the one caller that wires up the drag
 * listeners. The contextual wrapper supplies reveal, including the legacy
 * touch fallback for pointers without row hover.
 */
export const RANK_DRAG_HANDLE_CLASS = `flex h-6 w-6 touch-none cursor-grab items-center justify-center rounded text-muted-foreground opacity-0 touch:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-offset-2 focus-visible:ring-offset-background active:cursor-grabbing group-hover/row:opacity-100 ${CHIP_FOCUS_RING_CLASS}`;

/** Why the grip is inert while the table is grouped. */
export const RANK_DISABLED_HINT = "Disable grouping to reorder";
