"use client";

import { manualReorderHandleLabel } from "@repo/app/shared/lib/manual-reorder-handle-label";
import { CHIP_FOCUS_RING_CLASS } from "@repo/design-system/components/ui/chip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { GridContextualAction } from "@repo/design-system/components/ui/grid-interaction-contract";
import { GridRowDragHandle } from "@repo/design-system/components/ui/grid-row-drag-handle";
import { MoveBetweenSectionsIcon } from "@repo/design-system/components/ui/move-between-sections-icon";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { CheckIcon } from "lucide-react";
import type { KeyboardEvent } from "react";
import type { GenericArtifact } from "../fixtures";

export function ArtifactHierarchyControls({
  artifact,
  disabled,
  onMoveDown,
  onMoveGroupByOffset,
  onMoveIn,
  onMoveOut,
  onMoveUp,
}: {
  artifact: GenericArtifact;
  disabled?: boolean;
  onMoveDown: () => void;
  onMoveGroupByOffset?: (offset: -1 | 1) => void;
  onMoveIn?: () => void;
  onMoveOut?: () => void;
  onMoveUp: () => void;
}) {
  const handleKeyboardMove = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!(event.metaKey || event.ctrlKey)) {
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (event.shiftKey && onMoveGroupByOffset) {
        onMoveGroupByOffset(-1);
      } else {
        onMoveUp();
      }
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (event.shiftKey && onMoveGroupByOffset) {
        onMoveGroupByOffset(1);
      } else {
        onMoveDown();
      }
    } else if (event.key === "ArrowLeft" && onMoveOut) {
      event.preventDefault();
      onMoveOut();
    } else if (event.key === "ArrowRight" && onMoveIn) {
      event.preventDefault();
      onMoveIn();
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <GridRowDragHandle
          aria-label={manualReorderHandleLabel(artifact.slug || artifact.title)}
          className={`touch-none text-muted-foreground/40 opacity-0 touch:opacity-100 transition-colors focus-visible:cursor-default focus-visible:opacity-100 focus-visible:ring-offset-2 focus-visible:ring-offset-background group-hover:opacity-100 ${CHIP_FOCUS_RING_CLASS}`}
          data-preserve-artifact-selection=""
          disabled={disabled}
          draggable={!disabled}
          legacyReveal="row"
          onKeyDown={handleKeyboardMove}
        />
      </TooltipTrigger>
      <TooltipContent>
        {disabled ? "Clear sorting to reorder artifacts" : "Drag to reorder"}
      </TooltipContent>
    </Tooltip>
  );
}

export function ArtifactSectionMoveMenu({
  currentSectionKey,
  onMove,
  sections,
}: {
  currentSectionKey: string;
  onMove: (sectionKey: string) => void;
  sections: readonly { key: string; label: string }[];
}) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <GridContextualAction asChild legacyReveal="row">
              <button
                aria-label="Move between sections"
                className="mr-1 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted data-[state=open]:text-foreground"
                data-preserve-artifact-selection=""
                type="button"
              >
                <MoveBetweenSectionsIcon />
              </button>
            </GridContextualAction>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Move between sections</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        className="w-44"
        data-preserve-artifact-selection=""
      >
        <DropdownMenuLabel className="font-normal text-muted-foreground">
          Move between sections
        </DropdownMenuLabel>
        {sections.map((section) => (
          <DropdownMenuItem
            key={section.key}
            onSelect={() => onMove(section.key)}
          >
            <CheckIcon
              className={
                section.key === currentSectionKey ? "opacity-100" : "opacity-0"
              }
            />
            {section.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
