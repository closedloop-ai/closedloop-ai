"use client";

import type { MergedTraceItem } from "@repo/api/src/types/branch";
import {
  SessionTrace,
  type SessionTraceHandle,
} from "@repo/app/agents/components/detail/session-trace";
import type {
  TraceCommentDraft,
  TraceTextAnchor,
} from "@repo/app/agents/components/detail/trace-comments";
import { computeActiveTraceRow } from "@repo/app/shared/lib/active-trace-row";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { MessageSquareIcon } from "lucide-react";
import { memo, type RefObject, useEffect, useMemo, useRef } from "react";
import type { BranchActorColorDomain } from "../lib/branch-actor-domain";
import { mergedTraceToSessionTraceItems } from "../lib/branch-merged-trace-adapter";

/**
 * Combined cross-session merged-trace (D2, deferred from Epic D) — REUSES the
 * shared, design-matching agents `SessionTrace` rather than a bespoke renderer.
 * The contract's lean `MergedTraceItem[]` is adapted to `SessionTrace`'s
 * `TurnItem` shape (`branch-merged-trace-adapter`), so the branch trace gets the
 * same quiet bubbles / tool + subagent rows / gutter timings as the Session
 * detail page. Shares the `activeRow` / `onJump` contract with `SessionTrace`, so
 * the composition wires it to the shared E2 playhead controller; the actor color
 * domain (shared with E1/E4) tints the avatars so a given actor is one color
 * across the whole page.
 */
export type BranchMergedTraceProps = {
  traceItems: readonly MergedTraceItem[];
  /** Shared actor domain so trace-avatar colors match E1/E4; else derived. */
  actorDomain?: BranchActorColorDomain;
  activeRow?: number | null;
  onJump?: (row: number) => void;
  /** Optional selected-passage highlight shared with local trace comments. */
  highlightAnchor?: TraceTextAnchor | null;
  /** Optional local trace comment callback; omitted consumers stay read-only. */
  onSubmitTraceComment?: (draft: TraceCommentDraft) => void;
  /**
   * Subscribe to timeline-driven scrubs (the E2 controller's `registerTraceScroll`)
   * so a bar/playhead scrub scrolls the trace to the matching row. Trace-internal
   * clicks don't fire this, so the trace never yanks itself on its own clicks.
   */
  registerScroll?: (onActive: (row: number) => void) => () => void;
  /**
   * Report the current row as the user manually scrolls the page container, so
   * the timeline's read-only "you are here" line follows the reader. Wired to the
   * controller's `scrubToRow` (which never scrolls back), so there is no loop.
   */
  onScrolledToRow?: (row: number) => void;
  /**
   * Report that the user reached the trace scroller's bottom edge. Terminal
   * branch trace rows do not always carry timestamps, so the detail page treats
   * this boundary as the timeline end instead of deriving time from the nearest
   * timestamped row above it.
   */
  onScrolledToTraceEnd?: () => void;
  /**
   * The Branch timeline scroller (`.sd3-scroll.bq-page-scroll`). The trace
   * virtualizes against it while the comments rail stays outside that scroller
   * as the `.sd3` sibling. Optional only so standalone renders (tests/stories)
   * work; the detail page always provides it.
   */
  scrollElementRef?: RefObject<HTMLDivElement | null>;
  className?: string;
};

/** Sticky timeline rows pinned above the trace; their measured heights set the fold. */
const BRANCH_STICKY_SELECTORS = [".bq-timeline-sticky"];
// After a timeline-driven (programmatic) smooth scroll, ignore the scroll events
// it emits for this long so the spy doesn't overwrite the just-clicked row with
// the fold row mid-animation. Covers a typical smooth scrollToIndex.
const PROGRAMMATIC_SCROLL_MS = 900;
const SCROLL_END_EPSILON_PX = 2;

export const BranchMergedTrace = memo(function BranchMergedTrace({
  traceItems,
  actorDomain,
  activeRow,
  highlightAnchor,
  onJump,
  onSubmitTraceComment,
  registerScroll,
  onScrolledToRow,
  onScrolledToTraceEnd,
  scrollElementRef,
  className,
}: BranchMergedTraceProps) {
  const items = useMemo(
    () => mergedTraceToSessionTraceItems(traceItems, actorDomain),
    [traceItems, actorDomain]
  );
  const traceRef = useRef<SessionTraceHandle>(null);
  // Timestamp until which the manual-scroll spy is suppressed because a
  // timeline-driven (programmatic) smooth scroll is animating — otherwise its
  // own scroll events would overwrite the just-clicked row with the fold row.
  const programmaticUntilRef = useRef(0);

  useEffect(() => {
    if (!registerScroll) {
      return;
    }
    // A timeline/playhead scrub asks the trace to scroll to the matching row.
    // SessionTrace owns the scroll (it has the virtualizer): `scrollToIndex`
    // when windowed, the bounded-viewport `[data-row]` scroll when every row is
    // mounted — never the whole page (PLN-1148 Phase 4). Suppress the manual
    // scroll spy while that smooth scroll animates so it doesn't clobber the
    // active row the click just set.
    return registerScroll((row) => {
      programmaticUntilRef.current =
        globalThis.performance.now() + PROGRAMMATIC_SCROLL_MS;
      traceRef.current?.scrollToRow(row);
    });
  }, [registerScroll]);

  // Track manual scrolling of the page container so the timeline "you are here"
  // line follows the reader (mirrors the Session detail page's scroll spy).
  useEffect(() => {
    const scroller = scrollElementRef?.current;
    if (!(onScrolledToRow && scroller)) {
      return;
    }
    let frame: number | null = null;
    const onScroll = () => {
      // Skip events emitted by an in-flight programmatic (timeline) scroll.
      if (
        frame !== null ||
        globalThis.performance.now() < programmaticUntilRef.current
      ) {
        return;
      }
      frame = globalThis.requestAnimationFrame(() => {
        frame = null;
        if (isScrolledToTraceEnd(scroller)) {
          onScrolledToTraceEnd?.();
          return;
        }
        const row = computeActiveTraceRow({
          root: scroller,
          rowSelector: ".st [data-row]",
          scroller,
          stickySelectors: BRANCH_STICKY_SELECTORS,
        });
        if (row != null) {
          onScrolledToRow(row);
        }
      });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (frame !== null) {
        globalThis.cancelAnimationFrame(frame);
      }
    };
  }, [onScrolledToRow, onScrolledToTraceEnd, scrollElementRef]);

  if (traceItems.length === 0) {
    return (
      <EmptyState
        className={className}
        description="No trace captured for this branch yet."
        icon={MessageSquareIcon}
        title="No merged trace"
      />
    );
  }

  return (
    // No bounded inner viewport: the trace is plain in-flow content and
    // virtualizes against the single page scroll container, so the page keeps one
    // scrollbar while long traces stay windowed. A timeline scrub scrolls that
    // page container to the matching row (via the SessionTrace handle).
    <SessionTrace
      activeRow={activeRow}
      className={className}
      highlightAnchor={highlightAnchor}
      items={items}
      onJump={onJump}
      onSubmitTraceComment={onSubmitTraceComment}
      ref={traceRef}
      scrollElementRef={scrollElementRef}
      virtualize
    />
  );
});

function isScrolledToTraceEnd(scroller: HTMLElement): boolean {
  return (
    scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <=
    SCROLL_END_EPSILON_PX
  );
}
