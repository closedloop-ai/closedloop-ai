/**
 * ISS-5479: resolve a Session Timeline jump into a concrete transcript scroll,
 * and report WHICH of the four possible outcomes actually happened.
 *
 * The timeline is a fixed grid (up to 48 bars plus a dot rail) drawn over a
 * transcript whose landable anchors are *groups* — `SessionTrace` coalesces a
 * run of consecutive message turns into one `[data-row]` element keyed to the
 * group's FIRST row. On a real session the grid is therefore finer than the
 * anchor space it points at, so several adjacent bars legitimately resolve to
 * the SAME anchor. Measured on SES-72712 (1073 turn items, 40 bars): 30
 * clickable bars resolve to 30 distinct jump rows with the axis-reconciliation
 * flag off and only 21 with it on, where bars 31-38 all carry the same jump row.
 *
 * That much is correct behavior, not a bug: a bar is a time slice, and several
 * time slices really do belong to one rendered turn. What WAS a bug is that a
 * click resolving onto the anchor the reader is already parked on produced no
 * observable response at all — the scroll delta is ~0, so `scrollTop` never
 * moves — and three further paths returned in silence: a bar or dot carrying no
 * jump row at all (an "idle" bucket, the single biggest contributor to "some
 * scroll, others don't"), an unresolvable row, and a transcript with no
 * rendered anchors. All four read to the reader as a dead control, which is
 * what Mike reported: "only some of the columns actually scroll the transcript,
 * others don't — exact same thing w/ the dots."
 *
 * So the resolution is unchanged and the OUTCOME is now explicit: the caller
 * learns whether it scrolled, was already in place, could not resolve the row,
 * or had nothing to scroll to, and surfaces each one honestly.
 */

/** Class the arrival flash is applied under; see `.st-flash` in `styles.css`. */
export const TRACE_FLASH_CLASS = "st-flash";

/** Selector for the transcript's landable anchors (one per rendered group). */
export const TRACE_ROW_SELECTOR = ".st [data-row]";

/** Selector for the URL-owned invocation anchor, when one is on screen. */
export const TRACE_INVOCATION_ANCHOR_SELECTOR =
  '.st [data-invocation-anchor-target="true"]';

/**
 * Largest `scrollTop` delta (px) still treated as "no movement needed". Mirrors
 * the browser's own sub-pixel rounding on a fractional `scrollTop` assignment.
 */
const TRACE_SCROLL_EPSILON_PX = 0.5;

/** Gap left between the sticky transcript header and the row we land on. */
const TRACE_STICKY_CLEARANCE_PX = 14;

/** Selector for the transcript's sticky header, when it is currently pinned. */
const TRACE_STICKY_HEAD_SELECTOR = ".sd3-stickyhead.is-sticky";

/**
 * What a Session Timeline jump actually did. Every member is a state the reader
 * can end up in, and each one has to look different from the others — the whole
 * ISS-5479 defect was four of them rendering identically (as nothing).
 */
export const TraceScrollOutcome = {
  /** Resolved onto the anchor already at the top of the viewport; no movement. */
  AlreadyInPlace: "already-in-place",
  /** The transcript rendered no landable anchor at all. */
  EmptyTranscript: "empty-transcript",
  /**
   * The clicked bar or dot carries no jump row at all (an "idle" bucket, whose
   * time slice caught no transcript turn). ISS-4821 deliberately leaves these
   * un-repaired so they stay non-jumping; ISS-5479 makes that legible instead
   * of letting the control absorb the click in silence.
   */
  NoJumpTarget: "no-jump-target",
  /** Resolved onto a different anchor and the scroller moved to it. */
  Scrolled: "scrolled",
  /** The clicked turn has no counterpart in the rendered transcript. */
  Unresolvable: "unresolvable",
} as const;

export type TraceScrollOutcome =
  (typeof TraceScrollOutcome)[keyof typeof TraceScrollOutcome];

/**
 * The reader-facing explanation for an outcome, or `null` when the reader
 * already has the answer on screen — either because it is self-evident (the
 * transcript visibly moved, or the arrival flash fired in place) or because the
 * control itself carries it (the idle bar's withdrawn affordance plus its own
 * anchored tooltip). `null` means "do not toast", not "say nothing".
 *
 * Exhaustive over {@link TraceScrollOutcome} on purpose: a new outcome fails
 * typecheck here until someone decides what the reader should be told.
 *
 * Voice follows this strip's existing copy contract (see
 * `trace-truncation-copy.ts`): terse fragments, no trailing clause explaining
 * the mechanism, and none of our own machinery named. "Uploaded" in particular
 * is wrong on desktop, where the reader never uploaded anything. The strings
 * stay HERE rather than moving into that module because the exhaustive
 * `Record<TraceScrollOutcome, …>` over the const object above is what makes a
 * new outcome fail typecheck until it is given an answer; splitting the map
 * from the enum it is keyed on would trade that compile-time guard for
 * co-location.
 */
export const TRACE_SCROLL_OUTCOME_MESSAGE: Record<
  TraceScrollOutcome,
  string | null
> = {
  [TraceScrollOutcome.AlreadyInPlace]: null,
  /*
   * "Transcript not loaded yet", not "No transcript to open". Two reasons.
   *
   * "…to open" implies a thing that opens, and the transcript is already on
   * screen beside the strip; there is no open action to take.
   *
   * More importantly this outcome is a claim about the DOM at click time — the
   * scroller held no `.st [data-row]` — not about whether the session HAS a
   * transcript, and there is a reachable desktop path where the two disagree.
   * `session-transcript-panel.tsx` opens the timeline's `hasRenderedRows` gate
   * off `renderedItems` (which the projected-fallback branch fills), while
   * `renderTranscriptContent`'s oversized branch pre-empts the projection and
   * paints "Large transcript / Load full transcript" with no `SessionTrace` at
   * all. The gate reads what the panel RESOLVED; this reads what it PAINTED. On
   * that screen "no transcript" would be a flat lie with a "Load full
   * transcript" button sitting next to it — "not loaded yet" is true of both
   * that state and the genuinely-empty one.
   */
  [TraceScrollOutcome.EmptyTranscript]: "Transcript not loaded yet",
  /*
   * `null` — answered AT the control, not from the corner.
   *
   * This is the frequent outcome (most bars on a real session carry no jump
   * row), the reader's eye is on the bar, and the bar already withdraws its
   * cursor and hover outline. `ActivityBucketTooltip` is
   * anchored to that same bar and open at click time, so it carries the answer
   * ("nothing to open here" — see `getBucketJumpHint`) where the reader is
   * looking. A toast at the screen edge only repeated what the bar had said, in
   * a place the reader was not watching.
   *
   * `Unresolvable` and `EmptyTranscript` keep their toasts: those two are not
   * predictable from the control's appearance, so the reader could not have seen
   * them coming.
   */
  [TraceScrollOutcome.NoJumpTarget]: null,
  [TraceScrollOutcome.Scrolled]: null,
  [TraceScrollOutcome.Unresolvable]: "Not in the read transcript",
};

/** A resolved jump: the anchor to land on and the scroll it implies. */
export type TraceScrollPlan = {
  readonly nextScrollTop: number;
  readonly previousScrollTop: number;
  readonly target: HTMLElement;
};

/**
 * The transcript anchor a jump to `row` lands on: the element with the GREATEST
 * `data-row` that is ≤ `row`, falling back to the first anchor when the jump
 * lands before any of them.
 *
 * ISS-5479 asked whether this should become nearest-in-either-direction. It
 * must not, for two reasons.
 *
 * First, "greatest `data-row` ≤ row" is not an approximation of nearest — in a
 * group-keyed space it is exact CONTAINMENT. `SessionTrace` stamps each group
 * with its first row (`data-row={group.row}`), so every row between one anchor
 * and the next belongs to the earlier group. Picking the numerically closer
 * FOLLOWING anchor for a turn in the back half of a group would scroll PAST the
 * turn the reader pointed at — a regression, not a fix.
 *
 * Second, the rule is load-bearing across three sites that must agree:
 * `alignBucketRowsToTranscript`'s forward-fill in `session-timeline-geometry.ts`
 * (whose comment names this contract explicitly), plus BOTH branches of
 * `scrollToRow` in `session-trace.tsx` — `groupIndexForRow` on the windowed
 * path and `scrollTraceToRow` on the all-rows-mounted fallback below it. Those
 * two are mutually exclusive, so a change has to be made in both or the trace
 * lands differently depending on whether it happens to be virtualized.
 * Flipping any of them silently desynchronizes the jump target from the bar the
 * reader clicked.
 *
 * And it would not have helped: the number of distinct anchors is bounded by the
 * number of rendered groups, not by the tie-break, so nearest-either only moves
 * the boundaries between collapsed runs. It cannot remove them. The collapse is
 * addressed by making the "already in place" arrival observable instead.
 *
 * Returns `null` only when the scroller holds no anchors at all.
 */
export function findTraceScrollTarget(
  scroller: HTMLElement,
  row: number,
  exactInvocationTarget: boolean
): HTMLElement | null {
  if (exactInvocationTarget) {
    const exact = scroller.querySelector<HTMLElement>(
      TRACE_INVOCATION_ANCHOR_SELECTOR
    );
    if (exact) {
      return exact;
    }
  }
  const nodes = Array.from(
    scroller.querySelectorAll<HTMLElement>(TRACE_ROW_SELECTOR)
  );
  let target: HTMLElement | null = null;
  let bestRow = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    const dataRow = Number(node.dataset.row);
    if (Number.isFinite(dataRow) && dataRow <= row && dataRow > bestRow) {
      bestRow = dataRow;
      target = node;
    }
  }
  return target ?? nodes[0] ?? null;
}

/**
 * Resolve `row` into the anchor to land on plus the `scrollTop` that puts it
 * just under the sticky header. `null` when the transcript has no anchor to
 * land on at all — which the caller must report rather than swallow.
 */
export function planTraceScroll(
  scroller: HTMLElement,
  row: number,
  exactInvocationTarget: boolean
): TraceScrollPlan | null {
  const target = findTraceScrollTarget(scroller, row, exactInvocationTarget);
  if (!target) {
    return null;
  }
  const sticky = scroller.querySelector<HTMLElement>(
    TRACE_STICKY_HEAD_SELECTOR
  );
  const offset = (sticky?.offsetHeight ?? 0) + TRACE_STICKY_CLEARANCE_PX;
  const previousScrollTop = scroller.scrollTop;
  return {
    nextScrollTop:
      previousScrollTop +
      target.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top -
      offset,
    previousScrollTop,
    target,
  };
}

/** Whether a plan asks the scroller to move somewhere it is not already. */
export function isTraceScrollMovement(plan: TraceScrollPlan): boolean {
  return (
    Math.abs(plan.nextScrollTop - plan.previousScrollTop) >
    TRACE_SCROLL_EPSILON_PX
  );
}

/** Whether `scrollTop` actually landed somewhere new (it can clamp at an end). */
export function didTraceScrollMove(
  scroller: HTMLElement,
  previousScrollTop: number
): boolean {
  return (
    Math.abs(scroller.scrollTop - previousScrollTop) > TRACE_SCROLL_EPSILON_PX
  );
}

/**
 * Restart the arrival flash on `target`, and only on `target`.
 *
 * Two things are load-bearing here.
 *
 * The forced reflow between remove and add is what lets the SAME element flash
 * twice in a row — without it the browser coalesces the two class mutations and
 * the animation never restarts, which is exactly the case that matters here: a
 * second click on a collapsed run of bars resolves to the anchor already on
 * screen, so the flash is the only thing the reader can perceive.
 *
 * Clearing the class from whatever held it BEFORE is what keeps "you landed
 * here" singular. The class is never removed on its own — under the animated
 * path the keyframes end at transparent so a stale one is merely invisible, but
 * under `prefers-reduced-motion` the arrival is a steady tint with no animation
 * to end, so every previously-jumped-to row would stay lit and the reader would
 * accumulate a trail of "here" markers. Exactly one row may carry it.
 */
export function flashTraceRow(target: HTMLElement): void {
  const root = target.ownerDocument;
  for (const lit of root.querySelectorAll(`.${TRACE_FLASH_CLASS}`)) {
    lit.classList.remove(TRACE_FLASH_CLASS);
  }
  target.getBoundingClientRect();
  target.classList.add(TRACE_FLASH_CLASS);
}

/**
 * Whether an outcome means the transcript ACTUALLY reached the requested row —
 * the predicate the reader's POSITION is committed on.
 *
 * ISS-5843. Since ISS-5819 the Session Timeline has ONE position model: the
 * active row resolves to an absolute column that both the `.tl-here` marker and
 * the scrubber thumb read (`useSessionTimelineScale`), so whatever moves the row
 * moves both. `useTraceJump` used to commit that row BEFORE it knew whether the
 * scroll could land, which meant a click resolving to `EmptyTranscript` still
 * slid the marker onto a bucket the transcript never went to — the UI stating a
 * location the reader had not been taken to.
 *
 * That case is reachable, not theoretical, and the divergence is documented a
 * few lines up on {@link TRACE_SCROLL_OUTCOME_MESSAGE}: the strip's own
 * `hasRenderedRows` gate reads what `session-transcript-panel.tsx` RESOLVED,
 * while {@link planTraceScroll} reads what it PAINTED. On the oversized-desktop
 * branch those disagree — the bars stay live and clickable next to a "Large
 * transcript / Load full transcript" panel holding no anchors at all — so the
 * marker announced an arrival beside a transcript that had not moved.
 *
 * `AlreadyInPlace` LANDS. The anchor space is coarser than the bar grid, so
 * resolving onto the anchor already under the sticky header is a real arrival at
 * the requested row rather than a failure (see {@link findTraceScrollTarget});
 * treating it as a non-landing would freeze the marker across every collapsed
 * run of bars, which is most of a real strip.
 *
 * Exhaustive over {@link TraceScrollOutcome} for the same reason
 * {@link TRACE_SCROLL_OUTCOME_MESSAGE} is: a new outcome fails typecheck here
 * until someone decides whether the reader's position moved with it.
 */
export const TRACE_SCROLL_LANDED: Record<TraceScrollOutcome, boolean> = {
  [TraceScrollOutcome.AlreadyInPlace]: true,
  [TraceScrollOutcome.EmptyTranscript]: false,
  [TraceScrollOutcome.NoJumpTarget]: false,
  [TraceScrollOutcome.Scrolled]: true,
  [TraceScrollOutcome.Unresolvable]: false,
};

/** Whether {@link TRACE_SCROLL_LANDED} says the reader's position may move. */
export function didTraceJumpLand(outcome: TraceScrollOutcome): boolean {
  return TRACE_SCROLL_LANDED[outcome];
}
