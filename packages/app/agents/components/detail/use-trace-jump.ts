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
import { useCallback, useEffect, useRef } from "react";
import type { SessionTraceHandle } from "./session-trace-contract";

/**
 * ISS-5479: every way the session detail view scrolls its transcript to a row.
 *
 * Extracted from `agent-session-detail-view.tsx` because these four callbacks
 * are one concern — resolve a
 * requested row into a scroll, and say what that attempt actually did. The view
 * keeps the refs and the active-row state; this owns the jump.
 */

export type UseTraceJumpOptions = {
  cancelPendingTraceScroll: () => void;
  /** Set just before a programmatic scroll so the scroll handler ignores it. */
  ignoreNextTraceScrollRef: RefObject<boolean>;
  onActiveRowChange: (row: number) => void;
  scrollRef: RefObject<HTMLElement | null>;
  /**
   * ISS-12276: the windowed trace. A jump asks it to mount the target row
   * before measuring; omitted, every row is assumed to be in the DOM.
   */
  traceRef?: RefObject<SessionTraceHandle | null>;
  traceRowTranslatorsRef: RefObject<TraceRowTranslators>;
};

export type UseTraceJumpResult = {
  jumpToInvocationAnchor: (row: number) => void;
  jumpToRow: (row: number, flash?: boolean) => void;
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
  traceRef,
  traceRowTranslatorsRef,
}: UseTraceJumpOptions): UseTraceJumpResult {
  const landingFrameRef = useRef<number | null>(null);
  const detachUserScrollRef = useRef<(() => void) | null>(null);
  const cancelPendingLanding = useCallback(() => {
    if (landingFrameRef.current !== null) {
      globalThis.cancelAnimationFrame(landingFrameRef.current);
      landingFrameRef.current = null;
    }
    detachUserScrollRef.current?.();
    detachUserScrollRef.current = null;
  }, []);
  useEffect(() => cancelPendingLanding, [cancelPendingLanding]);

  /**
   * Arm the scroll handler's ignore flag only for a scroll that actually
   * happened. An assignment that leaves `scrollTop` where it was fires no
   * `scroll` event, so arming it then would swallow the reader's next scroll.
   */
  const markProgrammaticScroll = useCallback(
    (scroller: HTMLElement, previousScrollTop: number) => {
      if (didTraceScrollMove(scroller, previousScrollTop)) {
        ignoreNextTraceScrollRef.current = true;
      }
    },
    [ignoreNextTraceScrollRef]
  );

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
   * `trace-scroll-target.ts`. Plans against the anchors in the DOM.
   */
  const landOnMountedRow = useCallback(
    (
      scroller: HTMLElement,
      row: number,
      flash: boolean,
      exactInvocationTarget: boolean
    ): TraceScrollOutcome => {
      const plan = planTraceScroll(scroller, row, exactInvocationTarget);
      if (!plan) {
        return TraceScrollOutcome.EmptyTranscript;
      }
      let outcome: TraceScrollOutcome = TraceScrollOutcome.AlreadyInPlace;
      if (isTraceScrollMovement(plan)) {
        scroller.scrollTop = plan.nextScrollTop;
        markProgrammaticScroll(scroller, plan.previousScrollTop);
        if (didTraceScrollMove(scroller, plan.previousScrollTop)) {
          outcome = TraceScrollOutcome.Scrolled;
        }
      }
      if (flash) {
        flashTraceRow(plan.target);
      }
      return outcome;
    },
    [markProgrammaticScroll]
  );

  /**
   * ISS-12276: on a windowed trace the target group may be outside the mounted
   * window, where `planTraceScroll` would land on the nearest mounted anchor
   * instead. `revealRow` scrolls the virtualizer to the group; the landing then
   * runs once per frame, re-revealing until the group is in the DOM, and then
   * correcting `scrollTop` against the measured row until a frame needs no
   * correction. Rows measured on the way in change the offsets above the
   * target, so a single correction leaves it under the sticky header or off
   * screen. Bounded so a row that never mounts, or never settles, cannot keep
   * a frame loop alive.
   *
   * `onSettled` receives the outcome of the landing that actually ran, so a
   * deferred jump is committed and reported on what it did, not on the reveal.
   * A landing that never settles leaves the active row and the toast alone:
   * superseded by a newer jump, cancelled on unmount, abandoned because the
   * reader scrolled, or out of frames with the group still unmounted (landing
   * then would flash a different turn as if it were the target).
   */
  const scrollToTraceRow = useCallback(
    (
      row: number,
      flash: boolean,
      exactInvocationTarget: boolean,
      onSettled: (outcome: TraceScrollOutcome) => void
    ): void => {
      cancelPendingLanding();
      const scroller = scrollRef.current;
      if (!scroller) {
        onSettled(TraceScrollOutcome.EmptyTranscript);
        return;
      }
      const revealedFrom = scroller.scrollTop;
      const mountedNow = traceRef?.current?.revealRow(row) !== false;
      markProgrammaticScroll(scroller, revealedFrom);
      if (mountedNow) {
        onSettled(
          landOnMountedRow(scroller, row, flash, exactInvocationTarget)
        );
        return;
      }
      const abandonOnUserScroll = () => {
        cancelPendingLanding();
        ignoreNextTraceScrollRef.current = false;
      };
      for (const type of USER_SCROLL_EVENTS) {
        scroller.addEventListener(type, abandonOnUserScroll, { passive: true });
      }
      detachUserScrollRef.current = () => {
        for (const type of USER_SCROLL_EVENTS) {
          scroller.removeEventListener(type, abandonOnUserScroll);
        }
      };
      const settle = (liveScroller: HTMLElement) => {
        cancelPendingLanding();
        onSettled(
          deferredLandingOutcome(
            landOnMountedRow(liveScroller, row, flash, exactInvocationTarget)
          )
        );
      };
      /**
       * One frame of the landing: reveal the group while it is unmounted, and
       * once it is mounted, correct against the measured row. A frame whose
       * correction moves nothing is stable, and the landing settles on it.
       */
      const stepDeferredLanding = (
        liveScroller: HTMLElement,
        targetRow: number,
        remainingFrames: number
      ): DeferredLandingStep => {
        const previousScrollTop = liveScroller.scrollTop;
        const mounted = traceRef?.current?.revealRow(targetRow) !== false;
        markProgrammaticScroll(liveScroller, previousScrollTop);
        if (!mounted) {
          return remainingFrames <= 0
            ? DeferredLandingStep.Abandon
            : DeferredLandingStep.Continue;
        }
        const correction = landOnMountedRow(
          liveScroller,
          targetRow,
          false,
          exactInvocationTarget
        );
        if (
          correction !== TraceScrollOutcome.Scrolled ||
          remainingFrames <= 0
        ) {
          return DeferredLandingStep.Settle;
        }
        return DeferredLandingStep.Continue;
      };
      let framesLeft = TRACE_REVEAL_MAX_FRAMES;
      const land = () => {
        landingFrameRef.current = null;
        const liveScroller = scrollRef.current;
        if (!liveScroller) {
          cancelPendingLanding();
          onSettled(TraceScrollOutcome.EmptyTranscript);
          return;
        }
        framesLeft -= 1;
        const step = stepDeferredLanding(liveScroller, row, framesLeft);
        if (step === DeferredLandingStep.Settle) {
          settle(liveScroller);
          return;
        }
        if (step === DeferredLandingStep.Abandon) {
          cancelPendingLanding();
          return;
        }
        landingFrameRef.current = globalThis.requestAnimationFrame(land);
      };
      landingFrameRef.current = globalThis.requestAnimationFrame(land);
    },
    [
      cancelPendingLanding,
      ignoreNextTraceScrollRef,
      landOnMountedRow,
      markProgrammaticScroll,
      scrollRef,
      traceRef,
    ]
  );

  /*
   * ISS-5843: below, the reader's position is committed AFTER the scroll and
   * only when the scroll actually landed.
   *
   * Since ISS-5819 the active row is the single position model behind both the
   * `.tl-here` marker and the scrubber thumb, so committing it up front moved
   * both onto a bucket the transcript never reached whenever the attempt failed.
   * Marisol's rule for this strip: "if there is nowhere to move we can't move
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
   * The decision runs in the callback `scrollToTraceRow` settles with, never on
   * its return: on a windowed trace (ISS-12276) the landing can run frames
   * after the call, and only that landing knows whether the row was reached.
   */
  const jumpAndSettle = useCallback(
    (
      row: number,
      flash: boolean,
      exactInvocationTarget: boolean,
      onSettled?: (outcome: TraceScrollOutcome) => void
    ) => {
      cancelPendingTraceScroll();
      scrollToTraceRow(row, flash, exactInvocationTarget, (outcome) => {
        if (didTraceJumpLand(outcome)) {
          onActiveRowChange(row);
        }
        onSettled?.(outcome);
      });
    },
    [cancelPendingTraceScroll, onActiveRowChange, scrollToTraceRow]
  );

  const jumpToInvocationAnchor = useCallback(
    (row: number) => {
      jumpAndSettle(row, true, true);
    },
    [jumpAndSettle]
  );

  const jumpToRow = useCallback(
    (row: number, flash = true) => {
      jumpAndSettle(row, flash, false);
    },
    [jumpAndSettle]
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
      jumpAndSettle(rendered, flash, false, reportTraceJumpOutcome);
    },
    [jumpAndSettle, reportTraceJumpOutcome, traceRowTranslatorsRef]
  );

  return { jumpToInvocationAnchor, jumpToRow, jumpToTimelineRow };
}

/**
 * ISS-12276: frames a deferred landing may take to mount its row and settle
 * the measured position before it gives up (unmounted) or lands as it stands.
 */
const TRACE_REVEAL_MAX_FRAMES = 60;

/**
 * ISS-12276: input that means the reader is scrolling. A pending landing
 * re-reveals every frame, so it is abandoned on any of these rather than
 * fighting the reader for the scroller.
 */
const USER_SCROLL_EVENTS = ["wheel", "touchstart", "keydown"] as const;

/** ISS-12276: what one frame of a deferred landing decided. */
const DeferredLandingStep = {
  Abandon: "abandon",
  Continue: "continue",
  Settle: "settle",
} as const;
type DeferredLandingStep =
  (typeof DeferredLandingStep)[keyof typeof DeferredLandingStep];

/**
 * ISS-12276: a deferred landing settles on a frame that needed no correction,
 * so its final pass reads `AlreadyInPlace`; the reveal and corrections before
 * it did move the transcript, which is what the jump reports.
 */
function deferredLandingOutcome(
  outcome: TraceScrollOutcome
): TraceScrollOutcome {
  return outcome === TraceScrollOutcome.AlreadyInPlace
    ? TraceScrollOutcome.Scrolled
    : outcome;
}
