"use client";

import { traceCommentIncludeThreadIdSchema } from "@repo/api/src/types/comment";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTraceComments } from "./use-trace-comments";

/**
 * FEA-4233: the session-detail comments rail's collapse/reveal state, extracted
 * from `agent-session-detail-view.tsx` so this
 * cohesive unit — the live comments data plus the rail's open/collapsed
 * derivation and its reveal callbacks — lives on its own.
 *
 * Wraps {@link useTraceComments} (the data hook) and layers the rail UI state on
 * top:
 * - the fallback poll runs while the rail is expanded (ISS-12275); a rail merely
 *   showing the empty default relies on the comment event stream, or on the
 *   fallback poll while push is not live, so a comment created on another
 *   surface still lands the rail open (PRD-536 E5). The one-shot discovery read
 *   runs regardless (gated on `target.id` inside `useTraceComments`).
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
  enabled = true,
  selectedThreadId,
  onRevealCommentsRail,
}: UseCommentsRailStateOptions) {
  // View-scoped override that re-opens a collapsed rail without touching the
  // saved preference. Resets per session (the view is keyed by session.id).
  const [commentsRevealed, setCommentsRevealed] = useState(false);

  // The reader's own collapse decision (saved preference vs the transient
  // reveal), independent of the FEA-4233 empty default: a rail the reader
  // explicitly collapsed never polls. `expandedWhenEmpty` tells the hook the
  // empty default is collapsed unless revealed, so only an expanded rail polls
  // while push is live (ISS-12275).
  const commentsRailPollActive =
    commentsRailOpen && !(commentsCollapsed && !commentsRevealed);

  const comments = useTraceComments({
    target: { type: "session", id: sessionId },
    onJumpToRow: jumpToRow,
    active: commentsRailPollActive,
    expandedWhenEmpty: commentsRevealed,
    enabled,
    // Only a well-formed thread id is forwarded: the read rejects any other
    // value, and a hand-edited `?comment=` must not fail the whole rail.
    includeThreadId: traceCommentIncludeThreadIdSchema.safeParse(
      selectedThreadId
    ).success
      ? (selectedThreadId ?? undefined)
      : undefined,
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
  // Set when an addressed link asks the host to re-open its rail, so the edge
  // that request produces stays a transient reveal (ISS-11004, PR #8562).
  const hostRevealForAddressRef = useRef(false);
  useEffect(() => {
    const wasOpen = previousRailOpenRef.current;
    previousRailOpenRef.current = commentsRailOpen;
    // A disabled rail is not rendered: the unified pane owns the header
    // toggle's edge, and an address's reveal must not clear the saved collapse.
    if (!enabled) {
      return;
    }
    if (commentsRailOpen && !wasOpen) {
      if (hostRevealForAddressRef.current) {
        hostRevealForAddressRef.current = false;
        return;
      }
      // Force the full panel open via the reveal override, not just by clearing
      // the saved preference: on an empty session the preference is already
      // `false`, so the empty default (FEA-4233) would otherwise keep the rail
      // collapsed and the authoritative header toggle would appear to no-op.
      setCommentsRevealed(true);
      onCommentsCollapsedChange(false);
    }
  }, [enabled, commentsRailOpen, onCommentsCollapsedChange]);

  // ISS-11004: a `?comment=` link must land on its thread even when the reader
  // left the rail collapsed, so an address reveals it. Transient reveal only —
  // the same treatment the submit path below gets — so following a link never
  // rewrites the reader's saved collapse preference. Keyed on the address so a
  // reader who collapses the rail again is not fought on every later render.
  const revealedAddressRef = useRef<string | null>(null);
  useEffect(() => {
    // A disabled rail is not rendered: the unified pane owns the address.
    if (!(enabled && selectedThreadId)) {
      revealedAddressRef.current = null;
      return;
    }
    if (revealedAddressRef.current === selectedThreadId) {
      return;
    }
    revealedAddressRef.current = selectedThreadId;
    setCommentsRevealed(true);
    // The header toggle hides the rail outright, which a transient reveal
    // cannot undo, so the host re-opens it (tamsinb review, PR #8562).
    if (!commentsRailOpen && onRevealCommentsRail) {
      hostRevealForAddressRef.current = true;
      onRevealCommentsRail();
    }
  }, [enabled, selectedThreadId, commentsRailOpen, onRevealCommentsRail]);

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
  /** False when another surface hosts this Session's comments: nothing is read. */
  enabled?: boolean;
  /**
   * ISS-11004: the comment a `?comment=` link addressed. Reveals a collapsed
   * rail so the link lands on its thread; undefined on every other entry.
   */
  selectedThreadId?: string | null;
  /**
   * Re-open a rail the host's header toggle hid, so an addressed link can land
   * on its thread. Undefined on a host with no such toggle.
   */
  onRevealCommentsRail?: () => void;
};
