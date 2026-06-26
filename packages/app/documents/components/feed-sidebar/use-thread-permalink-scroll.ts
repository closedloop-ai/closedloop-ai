"use client";

import type { RefObject } from "react";
import { useEffect, useRef } from "react";

const HIGHLIGHT_DURATION_MS = 1600;
const HIGHLIGHT_ATTR = "data-permalink-highlight";
const RETRY_DELAY_MS = 250;

export const PermalinkResolution = {
  Resolved: "resolved",
  NotFound: "not-found",
} as const;
export type PermalinkResolution =
  (typeof PermalinkResolution)[keyof typeof PermalinkResolution];

export type UseThreadPermalinkScrollOptions = {
  /**
   * The thread ID extracted from the `?thread=<id>` query parameter, or
   * null when no permalink is being resolved. When this transitions from
   * a value to null, the hook does nothing (resolution only fires on the
   * initial mount value).
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

  useEffect(() => {
    if (targetThreadId === null || !threadsReady) {
      return;
    }
    if (resolvedForRef.current === targetThreadId) {
      return;
    }

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
      globalThis.setTimeout(() => {
        element.removeAttribute(HIGHLIGHT_ATTR);
      }, HIGHLIGHT_DURATION_MS);
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
