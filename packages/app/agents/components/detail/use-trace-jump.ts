"use client";

import type { TraceRowTranslators } from "@repo/app/agents/lib/timeline-row-space";
import {
  didTraceJumpLand,
  didTraceScrollMove,
  flashTraceRow,
  isTraceScrollMovement,
  planTraceScroll,
  TRACE_SCROLL_OUTCOME_MESSAGE,
  TraceScrollOutcome,
} from "@repo/app/agents/lib/trace-scroll-target";
import { toast } from "@repo/design-system/components/ui/sonner";
import type { RefObject } from "react";
import { useCallback } from "react";

/**
 * ISS-5479: every way the session detail view scrolls its transcript to a row.
 *
 * Extracted from `agent-session-detail-view.tsx` (a grandfathered over-size
 * file, shrink-only) because these four callbacks are one concern — resolve a
 * requested row into a scroll, and say what that attempt actually did. The view
 * keeps the refs and the active-row state; this owns the jump.
 */

export type UseTraceJumpOptions = {
  cancelPendingTraceScroll: () => void;
  /** Set just before a programmatic scroll so the scroll handler ignores it. */
  ignoreNextTraceScrollRef: RefObject<boolean>;
  onActiveRowChange: (row: number) => void;
  scrollRef: RefObject<HTMLElement | null>;
  traceRowTranslatorsRef: RefObject<TraceRowTranslators>;
};

export type UseTraceJumpResult = {
  jumpToInvocationAnchor: (row: number) => void;
  jumpToRow: (row: number, flash?: boolean) => TraceScrollOutcome;
  jumpToTimelineRow: (
    row: number | null,
    flash?: boolean,
    missingRowOutcome?: TraceScrollOutcome
  ) => void;
};

export function useTraceJump({
  cancelPendingTraceScroll,
  ignoreNextTraceScrollRef,
  onActiveRowChange,
  scrollRef,
  traceRowTranslatorsRef,
}: UseTraceJumpOptions): UseTraceJumpResult {
  /**
   * Tell the reader when a click could not land anywhere. `Scrolled` and
   * `AlreadyInPlace` map to `null` — the transcript moving, or the arrival flash
   * firing on the row already on screen, IS the response. The three outcomes
   * that previously returned in silence now say what happened.
   */
  const reportTraceJumpOutcome = useCallback((outcome: TraceScrollOutcome) => {
    const message = TRACE_SCROLL_OUTCOME_MESSAGE[outcome];
    if (message) {
      // One `id` per outcome so a reader sweeping a run of idle bars collapses
      // onto a single card instead of stacking an identical one per poke.
      toast.info(message, { id: `trace-jump-${outcome}` });
    }
  }, []);

  /**
   * Reports WHICH outcome the scroll produced instead of returning in silence.
   * "Already in place" is a legitimate, frequent result — the timeline grid is
   * finer than the transcript's group-keyed anchor space, so adjacent bars share
   * an anchor — and it has to be distinguishable from "nothing happened". See
   * `trace-scroll-target.ts`.
   */
  const scrollToTraceRow = useCallback(
    (
      row: number,
      flash: boolean,
      exactInvocationTarget = false
    ): TraceScrollOutcome => {
      const scroller = scrollRef.current;
      if (!scroller) {
        return TraceScrollOutcome.EmptyTranscript;
      }
      const plan = planTraceScroll(scroller, row, exactInvocationTarget);
      if (!plan) {
        return TraceScrollOutcome.EmptyTranscript;
      }
      let outcome: TraceScrollOutcome = TraceScrollOutcome.AlreadyInPlace;
      if (isTraceScrollMovement(plan)) {
        ignoreNextTraceScrollRef.current = true;
        scroller.scrollTop = plan.nextScrollTop;
        if (didTraceScrollMove(scroller, plan.previousScrollTop)) {
          outcome = TraceScrollOutcome.Scrolled;
        } else {
          ignoreNextTraceScrollRef.current = false;
        }
      }
      if (flash) {
        flashTraceRow(plan.target);
      }
      return outcome;
    },
    [ignoreNextTraceScrollRef, scrollRef]
  );

  /*
   * ISS-5843: below, the reader's position is committed AFTER the scroll and
   * only when the scroll actually landed.
   *
   * Since ISS-5819 the active row is the single position model behind both the
   * `.tl-here` marker and the scrubber thumb, so committing it up front moved
   * both onto a bucket the transcript never reached whenever the attempt failed.
   * Mike's rule for this strip: "if there is nowhere to move we can't move
   * things" — so when nothing moved, nothing moves.
   *
   * Why the reorder is safe, stated precisely, because the obvious reason is
   * wrong (#4753-era review): the active row is NOT render-inert. It pans the
   * timeline window (`useSessionTimelineScale` → `followTimelineWindowStart`),
   * which changes which bars render — and that strip sits inside the very
   * `.sd3-scroll` element `planTraceScroll` measures, sticky header included.
   *
   * What actually makes the order safe is that `onActiveRowChange` is a
   * `useState` setter, so React BATCHES it: the DOM cannot be re-rendered
   * between the commit and `scrollToTraceRow`'s synchronous measurement in
   * either ordering. Committing afterwards additionally puts every DOM read
   * ahead of every state write, so the measurement can never observe a layout
   * the jump itself caused.
   *
   * The two steps are sequenced through an explicit local rather than passed as
   * an argument to a helper: "scroll, then decide" must not be encoded solely in
   * JS argument-evaluation order, where a later refactor to a deferred or
   * memoized helper would silently restore the bug.
   */
  const jumpToInvocationAnchor = useCallback(
    (row: number) => {
      cancelPendingTraceScroll();
      const outcome = scrollToTraceRow(row, true, true);
      if (didTraceJumpLand(outcome)) {
        onActiveRowChange(row);
      }
    },
    [cancelPendingTraceScroll, onActiveRowChange, scrollToTraceRow]
  );

  const jumpToRow = useCallback(
    (row: number, flash = true): TraceScrollOutcome => {
      cancelPendingTraceScroll();
      const outcome = scrollToTraceRow(row, flash);
      if (didTraceJumpLand(outcome)) {
        onActiveRowChange(row);
      }
      return outcome;
    },
    [cancelPendingTraceScroll, onActiveRowChange, scrollToTraceRow]
  );

  // FEA-4252: the Session Timeline (cost bars, event dots, limit dots) emits a
  // jump row in the DB `session.turnItems` space, but the trace it scrolls may
  // render in a DIFFERENT `_row` space (the parsed cloud transcript on the web).
  // Translate the timeline row into the rendered space before jumping so a click
  // lands on the turn the reader pointed at rather than the same number in a
  // divergent projection. Comment/message-link jumps already originate in
  // rendered space and keep using the untranslated `jumpToRow`.
  const jumpToTimelineRow = useCallback(
    (
      row: number | null,
      flash = true,
      // ISS-5479: WHY the row is missing is the caller's knowledge, not ours, and
      // the two callers on this strip mean different things by it. A bar's
      // `tl0 == null` is an idle bucket — its time slice genuinely caught no
      // turn, so `NoJumpTarget` ("Nothing recorded here") is true. A dot only
      // renders when its lane holds events, so a missing `tl` there is an
      // unknown ROW for a known event, and answering "nothing recorded" would
      // contradict both the dot and the tooltip the reader just read. Keying the
      // outcome to "the caller handed me null" alone cannot tell those apart, so
      // the caller names it and the default stays the bar's meaning.
      missingRowOutcome: TraceScrollOutcome = TraceScrollOutcome.NoJumpTarget
    ) => {
      // ISS-4821 deliberately leaves an idle bucket non-jumping. The bar and the
      // dot still render as live controls, though, so the click used to be
      // swallowed by a `!= null` guard at the call site — the single biggest
      // source of "some columns scroll, others don't". Reporting it here keeps
      // every no-jump outcome on one path.
      if (row == null) {
        reportTraceJumpOutcome(missingRowOutcome);
        return;
      }
      const rendered = traceRowTranslatorsRef.current.toRendered(row);
      // A miss means the clicked turn is absent from the rendered trace (a
      // partial cloud upload). Never scroll+flash a foreign row — but ISS-5479:
      // say so, because returning here silently is indistinguishable from a dead
      // control.
      if (rendered == null) {
        reportTraceJumpOutcome(TraceScrollOutcome.Unresolvable);
        return;
      }
      reportTraceJumpOutcome(jumpToRow(rendered, flash));
    },
    [jumpToRow, reportTraceJumpOutcome, traceRowTranslatorsRef]
  );

  return { jumpToInvocationAnchor, jumpToRow, jumpToTimelineRow };
}
