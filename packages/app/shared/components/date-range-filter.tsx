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
 * Compact, always-visible segmented control for a table time window.
 *
 * DEFAULTS to the shared Sessions/Branches range set (7d / 30d / 90d / All):
 * the selected range drives both the list query and the summary-metric query,
 * so the cards reflect the window. Single-select — a click on the active range
 * is a no-op (never clears to empty).
 *
 * The `ranges` / `labels` / `shortLabels` / `ariaLabel` props are optional and
 * default to that shared set, so the Sessions/Branches toolbars render exactly
 * as before. Surfaces with their own window vocabulary (e.g. the Agents
 * workspace's All / 30 / 60 / 90 day set) pass their own const-object values,
 * label maps, and aria-label — reusing this one control instead of a second
 * structurally-identical ToggleGroup.
 */
export function DateRangeFilter<Range extends string = DateRange>({
  value,
  onChange,
  className,
  ranges = DATE_RANGES as unknown as readonly Range[],
  labels = DATE_RANGE_LABELS as unknown as Record<Range, string>,
  shortLabels = DATE_RANGE_SHORT_LABELS as unknown as Record<Range, string>,
  ariaLabel = "Date range",
}: {
  value: Range;
  onChange: (range: Range) => void;
  className?: string;
  /** Render order of the segmented control. Defaults to the shared set. */
  ranges?: readonly Range[];
  /** Accessible per-option labels. Defaults to the shared set. */
  labels?: Record<Range, string>;
  /** Compact per-option labels shown on the pills. Defaults to the shared set. */
  shortLabels?: Record<Range, string>;
  /** Accessible label for the whole control. */
  ariaLabel?: string;
}) {
  return (
    <ToggleGroup
      aria-label={ariaLabel}
      className={cn(className)}
      onValueChange={(next) => {
        if (next) {
          onChange(next as Range);
        }
      }}
      type="single"
      value={value}
      variant="outline"
    >
      {ranges.map((range) => (
        <ToggleGroupItem
          aria-label={labels[range]}
          // Shrink the pills from the outline default (h-7) to 26px so the whole
          // control lands at 32px (26 + p-0.5 frame + border), matching the
          // sibling Filter/View buttons (h-8) instead of the native 34px frame.
          className="px-2.5 data-[variant=outline]:h-[26px]"
          key={range}
          value={range}
        >
          {shortLabels[range]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
