"use client";

import {
  TIMELINE_SCALE_OPTIONS,
  type TimelineScale,
} from "@repo/app/agents/lib/session-timeline-scale";
import {
  TIMELINE_STACK_GROUPINGS,
  type TimelineStackGrouping,
} from "@repo/app/agents/lib/session-timeline-stacks";
import { TimelineGroupByControl } from "@repo/app/shared/components/timeline-group-by-control";
import {
  TimelinePositionScrubber,
  TimelineScaleControl,
} from "@repo/app/shared/components/timeline-scale-control";

/**
 * ISS-5819 — the Session Timeline's three controls: the scale toggle, the
 * "Group by" select, and the window scrubber.
 *
 * Their own module rather than more lines inside `agent-session-detail-view.tsx`
 * and rather than inside the strip itself, which is already the largest unit on
 * the page. They are pure presentation over the state `useSessionTimelineScale`
 * holds — no derivation lives here, so the controls and the bars can never
 * disagree about what the window currently is.
 *
 * Composed from the design-system primitives the prototype composes
 * (`ToggleGroup`, `Select`) with the prototype's own `aria-label`s.
 *
 * ISS-10599 PUT ONE DELIBERATE GAP IN THAT PARITY, behind the closed-by-default
 * `timeline-scale-visible-label` key. The prototypes render the scale toggle
 * bare: `packages/app/agents/components/sessions/web-master-legacy-preview/components/session-timeline.tsx:704`
 * and its generic-artifact twin both give the `ToggleGroup` an `aria-label` and
 * nothing a sighted reader can see — which is the defect that ticket exists to
 * fix, so with the flag ON this screen carries a visible label the prototype
 * does not. Flag OFF, the two screens are still the same screen. Whether the
 * prototypes should follow is not settled here and is not this module's call.
 */
/**
 * Ties the interpolation note to the scale toggle as its DESCRIPTION, so a
 * screen-reader user hears it on the control that caused it rather than only if
 * they happen to sweep past the text.
 */
const INTERPOLATED_SCALE_NOTE_ID = "session-timeline-interpolated-note";

/**
 * ISS-5819 review (whitlockk): what the strip says when the chosen scale cuts bars
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
  grouping,
  onGroupingChange,
  onScaleChange,
  scale,
  subColumnSource,
}: Readonly<{
  grouping: TimelineStackGrouping;
  onGroupingChange: (grouping: TimelineStackGrouping) => void;
  onScaleChange: (scale: TimelineScale) => void;
  scale: TimelineScale;
  /**
   * ISS-5819 review (whitlockk): whether the current scale draws columns narrower
   * than the bins they were cut from. Resolved by `useSessionTimelineScale` and
   * taken as a prop rather than derived here — this module documents itself as
   * holding no derivation.
   */
  subColumnSource: boolean;
}>) {
  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <TimelineScaleControl
        ariaDescribedBy={
          subColumnSource ? INTERPOLATED_SCALE_NOTE_ID : undefined
        }
        itemClassName="px-2.5 data-[variant=outline]:h-[26px]"
        onValueChange={onScaleChange}
        options={TIMELINE_SCALE_OPTIONS}
        title="Timeline scale"
        value={scale}
      />
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
      <TimelineGroupByControl
        onValueChange={onGroupingChange}
        options={TIMELINE_STACK_GROUPINGS}
        title="Group stacked bars by"
        value={grouping}
      />
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
    <TimelinePositionScrubber
      leadingLabel="Session"
      onPositionChange={onPositionChange}
      position={position}
      title="Session time position"
      totalColumns={totalColumns}
    />
  );
}
