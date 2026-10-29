/**
 * The harness-agnostic half of the ISS-7115 scrubber-monotonicity regression
 * walk, used by `e2e/session-timeline-subsession-scroll-monotonic.spec.ts`
 * against the web shell. The shared-only Electron duplicate was removed in
 * ISS-10527.
 *
 * The harness-independent pieces live here — the
 * DOM read a step is judged on, the selectors it reads, the frame budget it
 * settles over, the stop sequence, and the two pure predicates the assertions
 * are phrased in. Session production, launch/navigation and the sub-session's
 * ordinal stay in the calling spec. This module has no branch on its caller, and
 * must not grow one — a shared helper that has to ask would be worse than the
 * duplication it replaced.
 *
 * It deliberately imports no test runner. {@link readTimelineStep} is written to
 * be handed to Playwright's `page.evaluate`, so it is self-contained browser
 * code taking every selector as an argument. The calling spec phrases assertions
 * built on {@link crossedSubSession} against its own `expect`.
 */

import { TRACE_ROW_SELECTOR } from "../trace-scroll-target.ts";

/** The transcript's scroll container. */
export const TIMELINE_SCROLLER_SELECTOR = ".sd3-scroll";
/** The Session Timeline strip the selection line is painted inside. */
export const TIMELINE_STRIP_SELECTOR = ".sd3-bars2-wrap";
/** The "you are here" selection line itself. */
export const TIMELINE_MARKER_SELECTOR = ".tl-here";
/** The selection line, scoped to the strip, for presence/visibility claims. */
export const TIMELINE_HERE_SELECTOR = `${TIMELINE_STRIP_SELECTOR} ${TIMELINE_MARKER_SELECTOR}`;
/** The transcript's landable anchors, from the renderer's own constant. */
export const TIMELINE_ANCHOR_SELECTOR = TRACE_ROW_SELECTOR;
/**
 * The transcript's own statement of which row the reader is on: `SessionTrace`
 * stamps `data-active` on the group whose row equals the resolved `activeRow`.
 * Read rather than re-derived, so the spec does not restate the fold arithmetic
 * `computeActiveTraceRow` owns.
 */
export const TIMELINE_ACTIVE_ROW_SELECTOR = `${TRACE_ROW_SELECTOR}[data-active="true"]`;
/**
 * Accessible name of the scale toggle group. Its presence is what proves the
 * strip is on the CLOCK rather than the ordinal fallback: `SessionTimelineControls`
 * renders only when the projection resolved, which is the exact path
 * `resolveRowColumn` — the function ISS-7115 fixed — runs on.
 */
export const TIMELINE_SCALE_TOGGLE_NAME = "Timeline scale";

/**
 * How far the reader is moved per step of the walk. Deliberately SMALLER than
 * the shortest rendered anchor, so no turn can be stepped over without ever
 * being the row `computeActiveTraceRow` resolves to — which is what would let a
 * walk skip the sub-session and assert nothing. Neither spec assumes that: both
 * read the transcript's own active-row mark and assert the sub-session appears
 * in it.
 */
export const TIMELINE_SCROLL_STEP_PX = 24;

/**
 * Frames {@link readTimelineStep} always waits before it will accept a reading:
 * one for the scroll event to reach `handleTraceScroll`, one for the
 * `requestAnimationFrame` it defers its read to, one for the render React
 * schedules from that to be laid out.
 */
export const TIMELINE_SETTLE_MIN_FRAMES = 3;
/**
 * Frames after which {@link readTimelineStep} stops waiting for the reading to
 * repeat and takes what it has. A ceiling, not a delay — a settled reading
 * returns at {@link TIMELINE_SETTLE_MIN_FRAMES} — so a render that never
 * stabilises degrades to a sample rather than hanging the walk.
 */
export const TIMELINE_SETTLE_MAX_FRAMES = 30;

/**
 * One step of the walk: where the selection line was painted, and which row the
 * transcript itself reports the reader is on. Both are read in the same frame,
 * so the marker's position and the row it claims to be marking can never be
 * sampled from two different renders.
 */
export type TimelineStepReading = {
  activeRow: string;
  offsetPx: number;
};

/** Everything {@link readTimelineStep} needs, since it closes over nothing. */
export type TimelineStepArgs = {
  activeSelector: string;
  markerSelector: string;
  maxFrames: number;
  minFrames: number;
  scrollTop: number;
  scrollerSelector: string;
  stripSelector: string;
};

/**
 * The selector and frame-budget half of {@link TimelineStepArgs}, ready to be
 * spread with the step's own `scrollTop`. Shared so the two specs cannot drift
 * into settling over different budgets or reading different nodes.
 */
export const TIMELINE_STEP_ARGS: Omit<TimelineStepArgs, "scrollTop"> = {
  activeSelector: TIMELINE_ACTIVE_ROW_SELECTOR,
  markerSelector: TIMELINE_MARKER_SELECTOR,
  maxFrames: TIMELINE_SETTLE_MAX_FRAMES,
  minFrames: TIMELINE_SETTLE_MIN_FRAMES,
  scrollerSelector: TIMELINE_SCROLLER_SELECTOR,
  stripSelector: TIMELINE_STRIP_SELECTOR,
};

/**
 * Every scroll position a walk visits. Starts at the FIRST step, not at 0:
 * until the reader has actually moved, `activeRow` is null and the strip
 * correctly states no position at all.
 *
 * The stops end EXACTLY at the bottom rather than at the last whole step, so the
 * walk always reaches the final turn — the row whose lower ordinal, arriving
 * after the sub-session's higher one, is what the defect turned into a backward
 * jump.
 */
export function timelineScrollStops(maxScroll: number): number[] {
  const stops: number[] = [];
  for (
    let top = TIMELINE_SCROLL_STEP_PX;
    top < maxScroll;
    top += TIMELINE_SCROLL_STEP_PX
  ) {
    stops.push(top);
  }
  stops.push(maxScroll);
  return stops;
}

/**
 * Park the scroller at `scrollTop` and read back, in ONE round trip, the two
 * things a step is judged on. Written for `page.evaluate`, so it runs in the
 * page and closes over nothing.
 *
 * The wait is frame-driven, never wall-clock. `handleTraceScroll` defers its
 * read to `requestAnimationFrame` and React flushes the resulting state change
 * before the next one, so `minFrames` frames elapse unconditionally and then the
 * reading must repeat before it is accepted. The repeat is what makes the frame
 * count a floor rather than a guess: a slow render simply takes more frames, up
 * to `maxFrames`.
 *
 * A reading taken too early is not a source of false PASSES either way: it can
 * only report an EARLIER step's value, and a walk scrolls forward through a
 * sequence that is supposed to be non-decreasing, so a stale sample is always
 * <= the samples around it. It could hide a step, which is why both specs assert
 * the sub-session row appears in the walk's `activeRows` rather than assuming it.
 *
 * The offset is the selection line's REAL painted distance from the strip's left
 * edge, not its inline `left` percentage: an element that is present but not
 * painted has no such offset, which is exactly what a presence-only assertion
 * misses. `-1` when the strip states no position at all.
 */
export async function readTimelineStep({
  activeSelector,
  markerSelector,
  maxFrames,
  minFrames,
  scrollTop,
  scrollerSelector,
  stripSelector,
}: TimelineStepArgs): Promise<TimelineStepReading> {
  const doc = globalThis.document;
  const scroller = doc.querySelector<HTMLElement>(scrollerSelector);
  if (!scroller) {
    throw new Error("Expected the transcript scroll container");
  }
  scroller.scrollTop = scrollTop;
  const read = (): TimelineStepReading => {
    const strip = doc.querySelector<HTMLElement>(stripSelector);
    const marker = strip?.querySelector<HTMLElement>(markerSelector);
    const activeRow =
      doc
        .querySelector<HTMLElement>(activeSelector)
        ?.getAttribute("data-row") ?? "";
    const rect = marker?.getBoundingClientRect();
    if (!(strip && rect) || (rect.width === 0 && rect.height === 0)) {
      return { activeRow, offsetPx: -1 };
    }
    return {
      activeRow,
      offsetPx: rect.left - strip.getBoundingClientRect().left,
    };
  };
  const nextFrame = () =>
    new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  let previous = read();
  for (let frame = 0; frame < maxFrames; frame += 1) {
    await nextFrame();
    const current = read();
    const repeated =
      current.activeRow === previous.activeRow &&
      current.offsetPx === previous.offsetPx;
    previous = current;
    if (frame >= minFrames && repeated) {
      return current;
    }
  }
  return previous;
}

/**
 * Whether a walk went forward THROUGH the sub-session: it reported that row as
 * the reader's (`stoodOn`), and afterwards reported a row with a smaller ordinal
 * (`sawLowerLater`). That pair is the defect's whole precondition, and both
 * halves are load-bearing — the defect needs the ordinal to go DOWN while
 * reading order goes forward, so a walk that merely touched the sub-session and
 * stopped there would be monotonic under the broken code and prove nothing.
 *
 * Reported rather than asserted so each spec raises it through its own `expect`
 * and this module stays free of a test runner. `stoodOn` is `-1` when the walk
 * never stood on the sub-session at all.
 */
export function crossedSubSession(
  activeRows: readonly string[],
  subSessionRow: number
): { sawLowerLater: boolean; stoodOn: number } {
  const stoodOn = activeRows.indexOf(String(subSessionRow));
  const later = activeRows
    .slice(stoodOn + 1)
    .filter((row) => row !== "")
    .map(Number);
  return {
    sawLowerLater: stoodOn >= 0 && later.some((row) => row < subSessionRow),
    stoodOn,
  };
}

/** Whether `values` never decreases. */
export function isAscendingNumeric(values: readonly number[]): boolean {
  return values.every(
    (value, index) => index === 0 || value >= (values[index - 1] ?? value)
  );
}

/** Ascending numeric comparator, for sorting a copy of a walk's offsets. */
export function byAscending(left: number, right: number): number {
  return left - right;
}
