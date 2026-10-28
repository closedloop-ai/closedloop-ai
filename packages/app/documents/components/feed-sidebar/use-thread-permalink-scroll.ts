"use client";

import type { RefObject } from "react";
import { useEffect, useRef } from "react";

export const HIGHLIGHT_DURATION_MS = 1600;
const HIGHLIGHT_ATTR = "data-permalink-highlight";
export const RETRY_DELAY_MS = 250;

export const PermalinkResolution = {
  Resolved: "resolved",
  NotFound: "not-found",
} as const;
export type PermalinkResolution =
  (typeof PermalinkResolution)[keyof typeof PermalinkResolution];

export type UseThreadPermalinkScrollOptions = {
  /**
   * The thread ID extracted from the `?thread=<id>` query parameter, or
   * null when no permalink is being resolved. A transition to null is a
   * target change like any other: the active highlight is dropped and the
   * resolved target unpinned, so re-opening the same permalink resolves
   * again. `onResolved` does not fire for it — nothing resolved.
   */
  targetThreadId: string | null;
  /**
   * True once Liveblocks has finished its initial thread load. The hook
   * waits for this to flip before attempting resolution.
   */
  threadsReady: boolean;
  /**
   * Returns true if the target thread is currently in the rendered
   * thread set. Used to decide between "scroll + highlight" and
   * "show missing-thread banner". Computed by the caller because the
   * thread list lives in `useThreads()` which only resolves inside the
   * Feed sidebar tree.
   */
  hasThread: (threadId: string) => boolean;
  /**
   * Ref to the scroll container that holds the comment cards. The hook
   * resolves the target via `containerRef.current.querySelector(...)`.
   */
  containerRef: RefObject<HTMLElement | null>;
  /**
   * Invoked exactly once per `targetThreadId` after resolution settles.
   * The "resolved" path runs after the smooth-scroll is initiated. The
   * "not-found" path runs after the retry tick exhausts.
   */
  onResolved: (resolution: PermalinkResolution) => void;
};

/**
 * Resolves a Comment Permalink URL into a scroll + highlight on the
 * matching Feed-tab card. Idempotent per `targetThreadId` — re-renders
 * do not re-trigger resolution. A single retry tick covers the case
 * where Liveblocks streams the target thread in slightly after
 * `threadsReady` flips true.
 *
 * Visual cue reuses the FEA-1122 highlight pattern (data attribute +
 * keyframe in `comments.css`), but scoped to the card itself instead
 * of the inline mark.
 */
export function useThreadPermalinkScroll({
  targetThreadId,
  threadsReady,
  hasThread,
  containerRef,
  onResolved,
}: UseThreadPermalinkScrollOptions): void {
  const resolvedForRef = useRef<string | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const highlightedElementRef = useRef<HTMLElement | null>(null);

  // Unmount-scoped rather than folded into the resolution effect below: that
  // effect re-runs whenever `hasThread` or `threadsReady` change identity, and
  // a cleanup there would strip a live highlight well before its duration.
  // Only the timer is dropped — `highlightedElementRef` survives so the
  // re-arm below can tell a cancelled fade from a finished one.
  useEffect(
    () => () => {
      if (highlightTimerRef.current !== null) {
        clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = null;
      }
    },
    []
  );

  useEffect(() => {
    if (targetThreadId === null) {
      // Clearing `?thread` must not leave the anchor pinned:
      // `document-editor-scaffold.tsx:212` feeds the param through a provider
      // that stays mounted, so without this reset `th_1 -> cleared -> th_1`
      // re-enters with `resolvedForRef` still holding th_1 and the second
      // permalink visit silently does nothing. `onResolved` stays quiet —
      // nothing resolved, and firing it would raise the not-found banner on a
      // plain dismissal.
      clearPendingHighlight(highlightTimerRef, highlightedElementRef);
      resolvedForRef.current = null;
      return;
    }
    if (!threadsReady) {
      return;
    }
    if (resolvedForRef.current === targetThreadId) {
      // Settled for this target, so nothing may scroll or notify again. A lit
      // card with no timer means StrictMode's simulated unmount cancelled the
      // fade while leaving the card mounted; re-arm it so dev fades exactly
      // as production does.
      if (
        highlightedElementRef.current !== null &&
        highlightTimerRef.current === null
      ) {
        scheduleHighlightFade(highlightTimerRef, highlightedElementRef);
      }
      return;
    }

    // Past the guard above the permalink target genuinely changed, so any
    // highlight still lit belongs to the previous thread. Drop it now instead
    // of leaving a stale card lit until its own timer fires — or, when the new
    // target never resolves, for the rest of the session.
    clearPendingHighlight(highlightTimerRef, highlightedElementRef);

    function attempt(): boolean {
      if (targetThreadId === null) {
        return false;
      }
      if (!hasThread(targetThreadId)) {
        return false;
      }
      const container = containerRef.current;
      if (container === null) {
        return false;
      }
      const selector = `[data-thread-id="${CSS.escape(targetThreadId)}"]`;
      const element = container.querySelector<HTMLElement>(selector);
      if (element === null) {
        return false;
      }
      element.scrollIntoView({ behavior: "smooth", block: "center" });
      element.setAttribute(HIGHLIGHT_ATTR, "true");
      highlightedElementRef.current = element;
      scheduleHighlightFade(highlightTimerRef, highlightedElementRef);
      return true;
    }

    if (attempt()) {
      resolvedForRef.current = targetThreadId;
      onResolved(PermalinkResolution.Resolved);
      return;
    }

    if (retryTimerRef.current !== null) {
      clearTimeout(retryTimerRef.current);
    }
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      if (resolvedForRef.current === targetThreadId) {
        return;
      }
      const success = attempt();
      resolvedForRef.current = targetThreadId;
      onResolved(
        success ? PermalinkResolution.Resolved : PermalinkResolution.NotFound
      );
    }, RETRY_DELAY_MS);

    return () => {
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [targetThreadId, threadsReady, hasThread, containerRef, onResolved]);
}

function scheduleHighlightFade(
  timerRef: RefObject<ReturnType<typeof setTimeout> | null>,
  elementRef: RefObject<HTMLElement | null>
): void {
  const element = elementRef.current;
  if (element === null) {
    return;
  }
  timerRef.current = globalThis.setTimeout(() => {
    timerRef.current = null;
    elementRef.current = null;
    element.removeAttribute(HIGHLIGHT_ATTR);
  }, HIGHLIGHT_DURATION_MS);
}

function clearPendingHighlight(
  timerRef: RefObject<ReturnType<typeof setTimeout> | null>,
  elementRef: RefObject<HTMLElement | null>
): void {
  if (timerRef.current !== null) {
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }
  if (elementRef.current !== null) {
    elementRef.current.removeAttribute(HIGHLIGHT_ATTR);
    elementRef.current = null;
  }
}
