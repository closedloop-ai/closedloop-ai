"use client";

import { TIMELINE_SCALE_VISIBLE_LABEL_FLAG_KEY } from "@repo/api/src/types/timeline-scale-visible-label-flag";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { useId } from "react";
import { useFeatureFlagEnabledOptional } from "../feature-flags/use-feature-flag-enabled";

/**
 * The visible leading label, held here rather than taken from `title` for the
 * reason `TimelineGroupByControl` holds "Group by" rather than printing its own
 * `title`: the two strings are not the same string. `title` is the group's
 * verbose assistive-tech name and its hover tooltip, which a caller is free to
 * make descriptive; this is the short word that sits in the control row beside
 * the pills. Printing `title` would put whatever the next caller passes for
 * screen readers into the layout.
 */
const SCALE_LABEL = "Timeline scale";

/**
 * ISS-10599: the group named itself to assistive tech and to nobody else —
 * `title` reached `aria-label` only. A sighted reader saw a bare row of
 * duration pills (`5m 15m 1h 12h`) with nothing distinguishing it from
 * `DateRangeFilter`'s own bare duration pills (`7d 30d 90d All`) elsewhere in
 * the product, so a coarse `12h` bin read as "showing a 12-hour window".
 *
 * Gated behind {@link TIMELINE_SCALE_VISIBLE_LABEL_FLAG_KEY}, default off
 * (ISS-4779 closed-by-default) — one key for both shells that mount this.
 * Read here, at the one site that swaps on it, never taken as a prop: a shell
 * passing its own answer in is the `no-threaded-feature-flag` defect, and the
 * two shells could then disagree about a shared control. `…Optional` because
 * this renders under mount sites with no flag provider (Storybook, the
 * mini-table tests), where it resolves closed instead of crashing the subtree.
 *
 * ON mirrors this row's own sibling `TimelineGroupByControl`: a visible span
 * carrying {@link SCALE_LABEL}, the group named from that rendered text through
 * `aria-labelledby`, and `title` left as the separate verbose name/tooltip on
 * the group itself. OFF is byte-for-byte the shipped control.
 *
 * WHICH MEANS THE TWO STATES NAME THE GROUP FROM DIFFERENT PLACES, and they
 * agree only while `title` equals {@link SCALE_LABEL} — which it does for both
 * call sites today, because neither overrides the default. A caller that passes
 * something descriptive would be named by THAT string with the flag off and by
 * {@link SCALE_LABEL} with it on, and every `getByRole("radiogroup", { name })`
 * query in the suites would follow the flag. The prop is kept rather than
 * dropped because it is still the group's tooltip and its verbose
 * assistive-tech name, exactly as on the sibling; what must not be assumed is
 * that a future caller's `title` is the name in both states.
 */
export function TimelineScaleControl<TValue extends string>({
  ariaDescribedBy,
  className,
  itemClassName,
  onValueChange,
  options,
  title = SCALE_LABEL,
  value,
}: Readonly<{
  ariaDescribedBy?: string;
  className?: string;
  itemClassName?: string;
  onValueChange: (value: TValue) => void;
  options: readonly TValue[];
  title?: string;
  value: TValue;
}>) {
  const visibleLabelEnabled = useFeatureFlagEnabledOptional(
    TIMELINE_SCALE_VISIBLE_LABEL_FLAG_KEY
  );
  const labelId = useId();

  if (!visibleLabelEnabled) {
    return (
      <ScaleToggleGroup
        ariaDescribedBy={ariaDescribedBy}
        ariaLabel={title}
        className={className}
        itemClassName={itemClassName}
        onValueChange={onValueChange}
        options={options}
        value={value}
      />
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span
        className="whitespace-nowrap text-muted-foreground text-xs"
        id={labelId}
      >
        {SCALE_LABEL}
      </span>
      <ScaleToggleGroup
        ariaDescribedBy={ariaDescribedBy}
        ariaLabelledBy={labelId}
        className={className}
        itemClassName={itemClassName}
        onValueChange={onValueChange}
        options={options}
        title={title}
        value={value}
      />
    </div>
  );
}

export function TimelinePositionScrubber({
  className,
  leadingLabel,
  onPositionChange,
  position,
  title,
  totalColumns,
}: Readonly<{
  className?: string;
  leadingLabel: string;
  onPositionChange: (column: number) => void;
  position: number;
  title: string;
  totalColumns: number;
}>) {
  return (
    <div className={className ?? "mt-3 flex items-center gap-3"}>
      <span className="shrink-0 text-muted-foreground text-xs">
        {leadingLabel}
      </span>
      <input
        aria-label={title}
        aria-valuetext={`Column ${position + 1} of ${totalColumns}`}
        className="h-6 w-full cursor-ew-resize appearance-none rounded-full bg-transparent accent-primary focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-primary [&::-moz-range-track]:h-1.5 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-border [&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-border [&::-webkit-slider-thumb]:mt-[-7px] [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-0 [&::-webkit-slider-thumb]:bg-primary"
        max={Math.max(0, totalColumns - 1)}
        min={0}
        onChange={(event) => onPositionChange(Number(event.target.value))}
        step={1}
        type="range"
        value={position}
      />
      <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
        {Math.round((position / Math.max(1, totalColumns - 1)) * 100)}%
      </span>
    </div>
  );
}

function ScaleToggleGroup<TValue extends string>({
  ariaDescribedBy,
  ariaLabel,
  ariaLabelledBy,
  className,
  itemClassName,
  onValueChange,
  options,
  title,
  value,
}: Readonly<{
  ariaDescribedBy?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  className?: string;
  itemClassName?: string;
  onValueChange: (value: TValue) => void;
  options: readonly TValue[];
  title?: string;
  value: TValue;
}>) {
  return (
    <ToggleGroup
      aria-describedby={ariaDescribedBy}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      className={className}
      onValueChange={(next) => {
        if (next) {
          onValueChange(next as TValue);
        }
      }}
      title={title}
      type="single"
      value={value}
      variant="outline"
    >
      {options.map((option) => (
        <ToggleGroupItem
          aria-label={`${option} timeline scale`}
          className={itemClassName}
          key={option}
          value={option}
        >
          {option}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
