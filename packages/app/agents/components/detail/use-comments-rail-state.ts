"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTraceComments } from "./use-trace-comments";

/**
 * FEA-4233: the session-detail comments rail's collapse/reveal state, extracted
 * from `agent-session-detail-view.tsx` (a grandfathered over-size file) so this
 * cohesive unit — the live comments data plus the rail's open/collapsed
 * derivation and its reveal callbacks — lives on its own.
 *
 * Wraps {@link useTraceComments} (the data hook) and layers the rail UI state on
 * top:
 * - the 2s poll is gated on the reader's OWN collapse decision (saved preference
 *   vs a transient reveal), not the empty default — a rail merely showing the
 *   empty default keeps its live read so a comment created on another surface
 *   still lands the rail open (PRD-536 E5). The one-shot discovery read runs
 *   regardless (gated on `target.id` inside `useTraceComments`).
 * - the rail defaults to its slim re-open handle until the discovery read
 *   CONFIRMS comments exist, so a zero-comment session never flashes a 360px
 *   panel open only to snap it shut once an empty read settles.
 * - the `commentsRevealed` override (anchor-reveal, the collapsed handle, the
 *   header toggle) always forces the full panel open ahead of that default.
 */
export function useCommentsRailState({
  sessionId,
  jumpToRow,
  commentsRailOpen,
  commentsCollapsed,
  onCommentsCollapsedChange,
}: UseCommentsRailStateOptions) {
  // View-scoped override that re-opens a collapsed rail without touching the
  // saved preference. Resets per session (the view is keyed by session.id).
  const [commentsRevealed, setCommentsRevealed] = useState(false);

  // The reader's own collapse decision (saved preference vs the transient
  // reveal), independent of the FEA-4233 empty default. Gates the recurring 2s
  // poll: a rail the reader explicitly collapsed stops polling, while a rail
  // merely showing the empty default keeps its live read.
  const commentsRailPollActive =
    commentsRailOpen && !(commentsCollapsed && !commentsRevealed);

  const comments = useTraceComments({
    target: { type: "session", id: sessionId },
    onJumpToRow: jumpToRow,
    active: commentsRailPollActive,
  });
  const { hasLoadedComments, submitTraceComment } = comments;
  const traceComments = comments.comments;

  // FEA-4233: default the rail to its slim re-open handle until the discovery
  // read confirms this session actually has trace comments. Holding the handle
  // while the count is unknown (and on a settled-empty session — the common
  // case) means a zero-comment session never flashes a 360px "No trace comments
  // yet" panel open only to snap it shut a beat later, reflowing the Session
  // Trace under the reader. When comments are confirmed present the rail widens
  // into view, which reads as content arriving rather than the page breaking. A
  // comments-present session opens the moment its comments land and thereafter
  // obeys the reader's saved preference exactly as before.
  const commentsConfirmedPresent =
    hasLoadedComments && traceComments.length > 0;

  // The full comments rail is on screen when the header toggle is open AND the
  // rail is not collapsed (a collapsed rail renders only the slim re-open handle
  // — no comment stream). The collapse is the saved preference OR the
  // comments-not-yet-confirmed default (FEA-4233), unless the reader (or a
  // reveal) has forced it open.
  const commentsRailCollapsed =
    (commentsCollapsed || !commentsConfirmedPresent) && !commentsRevealed;

  const collapseCommentsRail = useCallback(() => {
    setCommentsRevealed(false);
    onCommentsCollapsedChange(true);
  }, [onCommentsCollapsedChange]);

  // Expanding from the slim handle forces the full panel open for this session
  // via the transient reveal override — necessary because on an empty session
  // the saved preference is already `false`, so clearing it alone would leave the
  // empty default (FEA-4233) re-collapsing the rail. Also clears any saved
  // collapse so a later non-empty visit stays open.
  const expandCommentsRail = useCallback(() => {
    setCommentsRevealed(true);
    onCommentsCollapsedChange(false);
  }, [onCommentsCollapsedChange]);

  // FEA-2479: the page header's "Show comments rail" toggle is authoritative.
  // When the caller flips commentsRailOpen false→true, drop any stale persisted
  // collapse preference so the header toggle always yields the full panel rather
  // than being silently overridden by a rail the reader collapsed on a previous
  // visit. Guarded by a ref so we only react to the false→true edge — not to the
  // inline collapse control toggling the pref while the rail stays open.
  const previousRailOpenRef = useRef(commentsRailOpen);
  useEffect(() => {
    const wasOpen = previousRailOpenRef.current;
    previousRailOpenRef.current = commentsRailOpen;
    if (commentsRailOpen && !wasOpen) {
      // Force the full panel open via the reveal override, not just by clearing
      // the saved preference: on an empty session the preference is already
      // `false`, so the empty default (FEA-4233) would otherwise keep the rail
      // collapsed and the authoritative header toggle would appear to no-op.
      setCommentsRevealed(true);
      onCommentsCollapsedChange(false);
    }
  }, [commentsRailOpen, onCommentsCollapsedChange]);

  // FEA-2479/FEA-2480: anchoring a new comment must re-open a collapsed rail so
  // the reader sees where their note lands. Wrap submit rather than the inline
  // composer so an in-progress draft is never lost to the collapse. Reveal only
  // once the comment actually persists (mutation onSuccess) — a failed submit
  // must not pop open a rail the reader chose to collapse. The reveal is
  // transient; it never overwrites the reader's saved collapse preference.
  const submitTraceCommentAndReveal = useCallback(
    (draft: Parameters<typeof submitTraceComment>[0]) => {
      submitTraceComment(draft, {
        onSuccess: () => setCommentsRevealed(true),
      });
    },
    [submitTraceComment]
  );

  return {
    ...comments,
    commentsRailCollapsed,
    collapseCommentsRail,
    expandCommentsRail,
    submitTraceCommentAndReveal,
  };
}

export type UseCommentsRailStateOptions = {
  /** Stable session identity; scopes the comments query and the reveal state. */
  sessionId: string;
  /** Jump the trace to a rendered row (for anchor jumps from a comment). */
  jumpToRow: (row: number, flash?: boolean) => void;
  /** The page header's authoritative "Show comments rail" toggle. */
  commentsRailOpen: boolean;
  /** The reader's saved collapse preference for the rail. */
  commentsCollapsed: boolean;
  /** Persist a change to the saved collapse preference. */
  onCommentsCollapsedChange: (collapsed: boolean) => void;
};
