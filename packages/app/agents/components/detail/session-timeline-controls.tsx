"use client";

import {
  TIMELINE_SCALE_OPTIONS,
  type TimelineScale,
} from "@repo/app/agents/lib/session-timeline-scale";
import {
  type TimelineStackGrouping,
  visibleTimelineStackGroupings,
} from "@repo/app/agents/lib/session-timeline-stacks";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";

/**
 * ISS-5819 — the Session Timeline's three controls: the scale toggle, the
 * "Group by" select, and the window scrubber.
 *
 * Their own module rather than more lines inside `agent-session-detail-view.tsx`
 * (grandfathered shrink-only under the file-size ceiling) and rather than inside
 * the strip itself, which is already the largest unit on the page. They are pure
 * presentation over the state `useSessionTimelineScale` holds — no derivation
 * lives here, so the controls and the bars can never disagree about what the
 * window currently is.
 *
 * Composed from the design-system primitives the prototype composes
 * (`ToggleGroup`, `Select`) with the prototype's own `aria-label`s, so the two
 * screens are the same screen.
 */
/** Ties the visible "Group by" text to the select as its accessible name. */
const GROUP_BY_LABEL_ID = "session-timeline-group-by-label";

/**
 * Ties the interpolation note to the scale toggle as its DESCRIPTION, so a
 * screen-reader user hears it on the control that caused it rather than only if
 * they happen to sweep past the text.
 */
const INTERPOLATED_SCALE_NOTE_ID = "session-timeline-interpolated-note";

/**
 * ISS-5819 review (wongk): what the strip says when the chosen scale cuts bars
 * out of the INSIDE of a measured bin.
 *
 * Without it a `5m` view of a strip binned in 18-minute bins reads as
 * five-minute measurement — the reader takes a bar's height for a fact about
 * five minutes when it is a share of a fact about eighteen. The projection
 * already knows (`ProjectedTimeline.subColumnSource`); this is where the reader
 * is told.
 *
 * Wording: "Interpolated" first, because that is the claim being withdrawn, then
 * what is true instead. Not "estimated" — nothing here is a guess about how much
 * was spent; the total is exact and only its placement inside the bin is
 * assumed. Not "approximate", which would read as a caveat on the money.
 */
export const TIMELINE_INTERPOLATED_SCALE_NOTE =
  "Interpolated — finer than the recorded bins";

export function SessionTimelineControls({
  activityPhasesEnabled,
  grouping,
  onGroupingChange,
  onScaleChange,
  scale,
  subColumnSource,
}: Readonly<{
  /**
   * ISS-5841. Taken as a prop rather than read here: this module is pure
   * presentation over the state `useSessionTimelineScale` holds, and a flag read
   * inside it would put a derivation in the one place that documents itself as
   * having none. The detail view already reads the key.
   */
  activityPhasesEnabled: boolean;
  grouping: TimelineStackGrouping;
  onGroupingChange: (grouping: TimelineStackGrouping) => void;
  onScaleChange: (scale: TimelineScale) => void;
  scale: TimelineScale;
  /**
   * ISS-5819 review (wongk): whether the current scale draws columns narrower
   * than the bins they were cut from. Resolved by `useSessionTimelineScale` and
   * taken as a prop for the same reason `activityPhasesEnabled` is — this module
   * documents itself as holding no derivation.
   */
  subColumnSource: boolean;
}>) {
  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <ToggleGroup
        aria-describedby={
          subColumnSource ? INTERPOLATED_SCALE_NOTE_ID : undefined
        }
        aria-label="Timeline scale"
        onValueChange={(next) => {
          /*
           * Radix hands back `""` when the pressed item is the active one, which
           * a single-select toggle treats as "deselect". There is no unscaled
           * state for this chart, so an empty value is dropped rather than
           * blanking the strip.
           */
          if (next) {
            onScaleChange(next as TimelineScale);
          }
        }}
        type="single"
        value={scale}
        variant="outline"
      >
        {TIMELINE_SCALE_OPTIONS.map((option) => (
          <ToggleGroupItem
            aria-label={`${option} timeline scale`}
            className="px-2.5 data-[variant=outline]:h-[26px]"
            key={option}
            value={option}
          >
            {option}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {/*
        Beside the scale toggle, not under the strip: this is a fact about the
        CONTROL's current setting, it appears and disappears as the reader moves
        that control, and the caption rail under the strip is held outside the
        pinned header on a height budget (FEA-4025). Plain muted text, the same
        treatment as the "Group by" label opposite — a badge would announce a
        status where a sentence states a limitation.
      */}
      {subColumnSource ? (
        <span
          className="text-muted-foreground text-xs"
          id={INTERPOLATED_SCALE_NOTE_ID}
        >
          {TIMELINE_INTERPOLATED_SCALE_NOTE}
        </span>
      ) : null}
      <div className="flex items-center gap-2">
        {/*
          WCAG 2.5.3 Label in Name: the accessible name must CONTAIN the visible
          label, or a speech-input user saying "click Group by" cannot reach the
          control. The visible text is the name here (via `aria-labelledby`)
          rather than a separate `aria-label` reading "Group stacked bars by",
          which contains no substring "Group by". The fuller phrasing survives as
          the trigger's title for a sighted reader who needs it.
        */}
        <span
          className="whitespace-nowrap text-muted-foreground text-xs"
          id={GROUP_BY_LABEL_ID}
        >
          Group by
        </span>
        <Select
          onValueChange={(value) =>
            onGroupingChange(value as TimelineStackGrouping)
          }
          value={grouping}
        >
          <SelectTrigger
            aria-labelledby={GROUP_BY_LABEL_ID}
            className="h-[26px] w-[156px]"
            size="sm"
            title="Group stacked bars by"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {visibleTimelineStackGroupings(activityPhasesEnabled).map(
              (option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              )
            )}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

/**
 * The timeline position scrubber, rendered ONLY when the session is longer than
 * the visible window — the prototype's `maxWindowStart > 0` condition, resolved
 * by `useSessionTimelineScale`. A session whose whole run already fits has
 * nothing to scrub to, and a range input spanning one screenful is a control
 * that cannot tell you anything the bars do not.
 *
 * The thumb IS the `.tl-here` marker (ISS-5819, ahead of ISS-5843). `position`
 * is the absolute column the marker sits on, not a window offset — dragging the
 * thumb moves the marker and brings the window along, and a jump from anywhere
 * else moves the thumb, because both read the one position the hook holds.
 *
 * A native `<input type="range">` rather than a styled slider: it is
 * keyboard-operable for free (arrows, Home/End, PageUp/PageDown), and this
 * control's whole job is moving one number within a bounded span.
 */
export function SessionTimelineScrubber({
  onPositionChange,
  position,
  totalColumns,
}: Readonly<{
  onPositionChange: (column: number) => void;
  position: number;
  totalColumns: number;
}>) {
  return (
    <div className="mt-3 flex items-center gap-3">
      <span className="shrink-0 text-muted-foreground text-xs">Session</span>
      <input
        aria-label="Session time position"
        /*
         * The spoken value is the position IN the session, not a bare column
         * index — "column 25 of 96" places the reader, while "25" does not say
         * what it is 25 of.
         */
        aria-valuetext={`Column ${position + 1} of ${totalColumns}`}
        /*
          WCAG 2.5.8 Target Size (Minimum): the control is 24px tall so the thumb
          has a real hit area, while the TRACK stays the 6px hairline the design
          calls for. Sizing the input itself to 6px, as this first did, bounds
          the pointer target to 6px and forfeits the user-agent exception,
          because the author is the one who shrank it.
        */
        className="h-6 w-full cursor-ew-resize appearance-none bg-transparent accent-primary [&::-moz-range-track]:h-1.5 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-border [&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-border"
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
