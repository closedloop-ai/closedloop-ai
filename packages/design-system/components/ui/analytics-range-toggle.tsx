"use client";

import { useId } from "react";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "./toggle-group";

export type AnalyticsRangeToggleOption = {
  label: string;
  value: string;
};

export type AnalyticsRangeToggleProps = {
  /** The visible group name, e.g. "Range". Defaults to "Range". */
  label?: string;
  /** The segments to render, in display order. An empty array renders the label with no segments. */
  options: AnalyticsRangeToggleOption[];
  /** The currently selected segment's value. Fully controlled — this component holds no state of its own, so a caller (or a story) must update this from `onValueChange` or the active segment never visibly changes. */
  value: string;
  onValueChange?: (value: string) => void;
  className?: string;
};

/**
 * A labeled, single-select segmented control for switching a scoped time
 * range (7d/30d/90d, etc.) or similar filter. Prefer this over a bare
 * `ToggleGroup` whenever the control needs a visible group label: it wires
 * the label to the group with `aria-labelledby` so the group has an
 * accessible name, which a raw `ToggleGroup` does not do on its own.
 *
 * @summary switches a scoped time range or similar single-select filter
 */
export function AnalyticsRangeToggle({
  label = "Range",
  options,
  value,
  onValueChange,
  className,
}: Readonly<AnalyticsRangeToggleProps>) {
  // The visible `label` is the group's name, but a bare `<span>` beside a
  // control names nothing — with `role="radiogroup"` on the group, ARIA
  // REQUIRES an accessible name, so point at that span rather than duplicating
  // its text in an `aria-label` that can drift from what is on screen
  // (WCAG 2.2 SC 1.3.1, and 2.5.3 Label in Name).
  const labelId = useId();
  return (
    <div className={className ?? "flex items-center gap-2"}>
      <span
        className="mr-2 font-medium text-muted-foreground text-xs uppercase tracking-wider"
        id={labelId}
      >
        {label}
      </span>
      {/* `outline` = the shared token-based segmented control: a bordered,
          padded container of borderless pills, bg-muted + accent-foreground on
          the active pill, muted/foreground labels. Its predecessor hardcoded a
          slate/emerald palette that failed the 4.5:1 contrast floor on the
          light product surfaces every consumer renders on. */}
      <ToggleGroup
        aria-labelledby={labelId}
        onValueChange={(nextValue) => {
          if (nextValue) {
            onValueChange?.(nextValue);
          }
        }}
        size="sm"
        type="single"
        value={value}
        variant="outline"
      >
        {options.map((option) => (
          <ToggleGroupItem key={option.value} value={option.value}>
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
