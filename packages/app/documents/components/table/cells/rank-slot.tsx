"use client";

import {
  RankInteractionMode,
  shouldShowRankSlot,
} from "@repo/app/documents/components/table/sort-keys";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
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
      <div className="flex h-7 w-7 shrink-0 items-center justify-center">
        <RankSlot dragHandle={dragHandle} mode={mode} />
      </div>
    );
  }
  if (reserveRankSlot) {
    return <div aria-hidden="true" className="w-7 shrink-0" />;
  }
  return null;
}

/**
 * Rank slot rendered at the start of a row's grid when the row participates
 * in stack-rank reordering (PRD-421 / PLN-755 Phase E). The parent supplies
 * `dragHandle` (the `@dnd-kit` grip button) for the `Enabled` mode; the
 * `DisabledGrouped` branch renders an explanatory greyed icon with a tooltip.
 * Both reveal on row hover (`group-hover/row`) to match the enabled handle and
 * avoid a permanently-visible grip on every grouped row.
 */
function RankSlot({
  mode,
  dragHandle,
}: {
  mode: RankInteractionMode | undefined;
  dragHandle: React.ReactNode;
}) {
  if (mode === RankInteractionMode.Enabled) {
    return <>{dragHandle}</>;
  }
  if (mode === RankInteractionMode.DisabledGrouped) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex h-6 w-6 cursor-not-allowed items-center justify-center text-muted-foreground/40 opacity-0 group-hover/row:opacity-100">
            <GripVerticalIcon className="h-4 w-4" />
          </span>
        </TooltipTrigger>
        <TooltipContent>Disable grouping to reorder</TooltipContent>
      </Tooltip>
    );
  }
  return null;
}
