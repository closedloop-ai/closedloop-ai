"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import {
  TIMEZONE_MODE_CONTROL_HINT,
  TIMEZONE_MODE_CONTROL_LABEL,
  TIMEZONE_MODE_LABELS,
  TIMEZONE_MODE_SHORT_LABELS,
  TIMEZONE_MODES,
  type TimezoneMode,
} from "../lib/date-window-timezone-mode";
import { DateRangeFilter } from "./date-range-filter";

/**
 * ISS-9619 — the `Local | UTC` day-boundary control on the Sessions and
 * Branches filter bars.
 *
 * It COMPOSES `DateRangeFilter` rather than growing a second segmented control
 * beside it. That component is already generic over its option vocabulary
 * precisely so a surface with its own window words reuses the one control — its
 * own docstring names that as the reason the props exist — so this is the
 * intended reuse, not a stretch of it: same `ToggleGroup`, same outline variant,
 * same pill height, same `radiogroup` semantics and single-select behaviour.
 * Hand-rolling a structurally identical group here is the thing that would need
 * justifying.
 *
 * It carries a tooltip because its neighbour does: `TableDateRangeToggle`
 * surfaces "Filter by date range" on hover, so an identical-looking group beside
 * it with no hover text reads as the one that does not explain itself. The hint
 * also resolves the one word a reader cannot resolve alone — "Local" does not
 * say WHOSE local.
 *
 * It sits BESIDE the preset pills rather than inside them, for the reason
 * `SessionsCustomRangeControl` does: the presets are a single-select group whose
 * every option picks a SPAN, and an option that instead reinterprets what a day
 * means would make the group's selected state say two different things.
 */
export function TimezoneModeFilter({
  value,
  onChange,
  className,
}: {
  value: TimezoneMode;
  onChange: (mode: TimezoneMode) => void;
  className?: string;
}) {
  return (
    <Tooltip>
      {/*
        The trigger must be a DOM element (whitlockk + codex review). `asChild`
        merges the trigger's pointer/focus handlers and its ref into its direct
        child, and `DateRangeFilter` is a plain function component that neither
        forwards a ref nor spreads unknown props onto its `ToggleGroup` — so
        handing it the trigger dropped every one of them and the tooltip could
        never open on hover or focus. The wrapper is `inline-flex` so it sizes
        to the control and changes nothing about the layout of the run.
      */}
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <DateRangeFilter<TimezoneMode>
            ariaLabel={TIMEZONE_MODE_CONTROL_LABEL}
            className={className}
            labels={TIMEZONE_MODE_LABELS}
            onChange={onChange}
            ranges={TIMEZONE_MODES}
            shortLabels={TIMEZONE_MODE_SHORT_LABELS}
            value={value}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent>{TIMEZONE_MODE_CONTROL_HINT}</TooltipContent>
    </Tooltip>
  );
}
