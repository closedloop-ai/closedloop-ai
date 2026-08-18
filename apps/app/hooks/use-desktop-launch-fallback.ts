"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Gates the post-launch fallback notice (ISS-6109). Closed by default per the
 * repo's closed-by-default UI policy; web-only, because the control it explains
 * exists only in `apps/app`.
 */
export const DESKTOP_LAUNCH_FALLBACK_FEATURE_FLAG_KEY =
  "desktop-launch-fallback" as const;

/**
 * How long to wait after firing `closedloop://` before telling the user nothing
 * answered.
 *
 * A custom-scheme navigation has NO success or failure signal — an unregistered
 * scheme no-ops silently in Chrome — so the only thing the browser can observe
 * is whether the desktop subsequently comes online. Long enough to cover a cold
 * Electron launch plus its first compute-target heartbeat, short enough that a
 * button which did nothing does not just sit there looking successful.
 */
export const DESKTOP_LAUNCH_FALLBACK_DELAY_MS = 8000;

/**
 * How often to re-read the user's own targets while a launch is pending.
 *
 * The target list is normally refreshed by an SSE push, which is exactly the
 * signal that can be missing when it matters: the stream backs off up to 30s
 * between reconnects and stops entirely once its attempt budget or the session
 * is exhausted. Waiting on a push during the bounded window would let a desktop
 * that DID launch be reported as never answering, off a cache that was stale
 * before the click. Polling is scoped to the pending window and stops with it.
 */
export const DESKTOP_LAUNCH_REACHABILITY_POLL_MS = 2000;

export type DesktopLaunchFallback = {
  /** The wait has elapsed and the desktop is still unreachable. */
  showFallback: boolean;
  /** The wait is still running; the outcome is genuinely not known yet. */
  isAwaitingLaunch: boolean;
  startLaunchAttempt: () => void;
  reset: () => void;
};

/**
 * Turns the unobservable "did the deep link fire?" into a bounded, honest
 * verdict.
 *
 * Deliberately reports only what it can actually see. Reaching the timeout does
 * not prove the launch failed — it proves the desktop is *still* not reachable —
 * and the copy this drives must say that, not claim a failure it cannot observe.
 * The desktop coming online at any point cancels the pending verdict.
 */
export function useDesktopLaunchFallback(options: {
  isDesktopReachable: boolean;
  /**
   * The feature gate. Off is a true no-op — no timer is armed and no state
   * moves — so the closed-by-default path leaves the surface exactly as it was
   * rather than re-rendering for output nothing reads.
   */
  enabled: boolean;
  /**
   * Re-reads the user's own targets. Supplied, the verdict is only ever taken
   * against a reachability result that SETTLED after the click; omitted, the
   * bound is taken as-is against whatever the caller last observed.
   */
  refreshReachability?: () => unknown;
}): DesktopLaunchFallback {
  const { enabled, isDesktopReachable, refreshReachability } = options;
  const [isAwaitingLaunch, setIsAwaitingLaunch] = useState(false);
  const [showFallback, setShowFallback] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasFreshResultRef = useRef(false);
  const isBoundElapsedRef = useRef(false);
  const refreshRef = useRef(refreshReachability);

  useEffect(() => {
    refreshRef.current = refreshReachability;
  }, [refreshReachability]);

  const clearPendingTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    clearPendingTimer();
    hasFreshResultRef.current = false;
    isBoundElapsedRef.current = false;
    setIsAwaitingLaunch(false);
    setShowFallback(false);
  }, [clearPendingTimer]);

  const settleVerdict = useCallback(() => {
    clearPendingTimer();
    isBoundElapsedRef.current = false;
    setIsAwaitingLaunch(false);
    setShowFallback(true);
  }, [clearPendingTimer]);

  const refreshNow = useCallback(() => {
    const refresh = refreshRef.current;
    if (refresh === undefined) {
      return;
    }
    // A rejected read still counts as settled. It says nothing about the
    // desktop, but holding the verdict on a refresh that keeps failing would
    // restore the very silence this control exists to end.
    Promise.resolve(refresh())
      .catch(() => undefined)
      .then(() => {
        hasFreshResultRef.current = true;
        if (isBoundElapsedRef.current) {
          settleVerdict();
        }
      });
  }, [settleVerdict]);

  const startLaunchAttempt = useCallback(() => {
    if (!enabled) {
      return;
    }
    // Supersede an in-flight wait rather than stacking a second timer, so a
    // double click cannot fire the verdict twice or leave an orphan pending.
    clearPendingTimer();
    hasFreshResultRef.current = false;
    isBoundElapsedRef.current = false;
    setShowFallback(false);
    setIsAwaitingLaunch(true);
    refreshNow();
    pollRef.current = setInterval(
      refreshNow,
      DESKTOP_LAUNCH_REACHABILITY_POLL_MS
    );
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (refreshRef.current !== undefined && !hasFreshResultRef.current) {
        // The bound is up but no read has come back. Deferring to the next one
        // is the honest move: a verdict off a pre-click cache is exactly the
        // false "still no response" the poll exists to prevent.
        isBoundElapsedRef.current = true;
        return;
      }
      settleVerdict();
    }, DESKTOP_LAUNCH_FALLBACK_DELAY_MS);
  }, [clearPendingTimer, enabled, refreshNow, settleVerdict]);

  useEffect(() => {
    if (isDesktopReachable || !enabled) {
      reset();
    }
  }, [enabled, isDesktopReachable, reset]);

  useEffect(() => clearPendingTimer, [clearPendingTimer]);

  return { isAwaitingLaunch, reset, showFallback, startLaunchAttempt };
}
