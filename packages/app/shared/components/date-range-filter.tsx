"use client";

import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { cn } from "@repo/design-system/lib/utils";
import {
  DATE_RANGE_LABELS,
  DATE_RANGE_SHORT_LABELS,
  DATE_RANGES,
  type DateRange,
} from "../lib/format-utils";

/**
 * Compact, always-visible segmented control for the table time window
 * (7d / 30d / 90d / All). First-class filter shared by the sessions and
 * branches toolbars on both surfaces; the selected range drives both the list
 * query and the summary-metric query, so the cards reflect the window. Single-
 * select — a click on the active range is a no-op (never clears to empty).
 */
export function DateRangeFilter({
  value,
  onChange,
  className,
}: {
  value: DateRange;
  onChange: (range: DateRange) => void;
  className?: string;
}) {
  return (
    <ToggleGroup
      className={cn(className)}
      onValueChange={(next) => {
        if (next) {
          onChange(next as DateRange);
        }
      }}
      type="single"
      value={value}
      variant="outline"
    >
      {DATE_RANGES.map((range) => (
        <ToggleGroupItem
          aria-label={DATE_RANGE_LABELS[range]}
          // Shrink the pills from the outline default (h-7) to 26px so the whole
          // control lands at 32px (26 + p-0.5 frame + border), matching the
          // sibling Filter/View buttons (h-8) instead of the native 34px frame.
          className="px-2.5 data-[variant=outline]:h-[26px]"
          key={range}
          value={range}
        >
          {DATE_RANGE_SHORT_LABELS[range]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
