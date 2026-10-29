"use client";

// Grid Table Toolbar v2 promotion candidate, derived from the approved Generic
// Artifact prototype's list shell.

import {
  ToggleGroup,
  ToggleGroupItem,
} from "@closedloop-ai/design-system/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./grid-table-v2-tooltip";

/** The toolbar's date-range presets. `All` is unbounded, not a window. */
export type TableDateRangeOption = {
  value: string;
  label: string;
  /** Text on the segment itself. Defaults to `value` (e.g. "7d", "30d"). */
  shortLabel?: string;
};

/**
 * The date-range segmented control that opens every v2 list toolbar.
 *
 * The segments are terse ("7d", "30d") because the control lives at the far
 * left of a row that has to fit filters, sort, grouping and options — so each
 * segment carries a full `aria-label` and the group carries a tooltip, and the
 * short text never becomes the only description of what the segment does.
 *
 * `ToggleGroup` in single mode reports `""` when the active segment is clicked
 * again; that is swallowed rather than forwarded, because a list with NO date
 * range selected is not a state this control can render — "everything" is the
 * `all` preset, which is a segment.
 */
export function TableDateRangeToggle({
  label = "Filter by date range",
  onValueChange,
  options,
  value,
}: {
  /** Names the group for screen readers and fills the tooltip. */
  label?: string;
  onValueChange: (value: string) => void;
  options: readonly TableDateRangeOption[];
  value: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <ToggleGroup
          aria-label={label}
          onValueChange={(next) => {
            if (next) {
              onValueChange(next);
            }
          }}
          type="single"
          value={value}
          variant="outline"
        >
          {options.map((option) => (
            <ToggleGroupItem
              aria-label={option.label}
              className="px-2.5 data-[variant=outline]:h-[26px]"
              key={option.value}
              value={option.value}
            >
              {option.shortLabel ?? option.value}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
