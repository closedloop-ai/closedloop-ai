"use client";

import { useEffect, useRef } from "react";

/**
 * Minimum gap between query invalidations driven by live DB-change events. A
 * burst within the window collapses into a single trailing flush. Exported so
 * each domain bridge (and its tests) reference one source of truth.
 */
export const LIVE_BRIDGE_INVALIDATION_THROTTLE_MS = 5000;

/** The coalesced change set flushed at a throttle-window boundary. */
export type LiveBridgeFlush = {
  /** A broad change touched every entity — refresh all open details. */
  broad: boolean;
  /** Specific entity ids that changed (when not broad). */
  ids: readonly string[];
};

/**
 * Shared engine for the per-domain "live bridge" components (Sessions, Branches,
 * …): subscribe to a data source's change stream and drive throttled,
 * visibility-gated React Query invalidations. The domain-specific parts are
 * injected, so the throttle/visibility/cleanup machinery lives in exactly one
 * place instead of being copied per feature slice:
 *
 * - `subscribe` — the source's change stream. `undefined` on poll-only sources
 *   (the HTTP source), in which case this hook is a no-op, so the eventual
 *   authenticated path mounts the bridge harmlessly.
 * - `getChangeId` — pulls the per-entity id from a change (e.g. `c.sessionId` /
 *   `c.branchId`); returning `undefined` marks the change BROAD.
 * - `flush` — performs the actual invalidation for the coalesced window.
 *
 * Behavior (identical across domains):
 * - **Throttled** to one flush per {@link LIVE_BRIDGE_INVALIDATION_THROTTLE_MS}:
 *   the first change after a quiet period flushes promptly; a burst collapses
 *   into a single trailing flush at the window boundary.
 * - **Visibility-gated** — defers while the tab is hidden, flushes the backlog
 *   on re-show.
 * - **Stable subscription** — `flush`/`getChangeId` are read through refs, so the
 *   effect (and the subscription) re-runs only when `subscribe` changes, never on
 *   an unrelated re-render.
 * - **Stale-on-error safe** — an errored refetch keeps its last data and recovers
 *   on the next change-driven invalidation.
 */
export function useLiveQueryBridge<TChange>(params: {
  subscribe: ((onChange: (change: TChange) => void) => () => void) | undefined;
  getChangeId: (change: TChange) => string | undefined;
  flush: (coalesced: LiveBridgeFlush) => void;
}): void {
  const { subscribe } = params;
  const flushRef = useRef(params.flush);
  const getChangeIdRef = useRef(params.getChangeId);
  flushRef.current = params.flush;
  getChangeIdRef.current = params.getChangeId;

  useEffect(() => {
    if (!subscribe) {
      return;
    }

    const hidden = () =>
      typeof document !== "undefined" && document.hidden === true;

    let pendingBroad = false;
    const pendingIds = new Set<string>();
    let lastInvalidatedAt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const hasPending = () => pendingBroad || pendingIds.size > 0;

    const invalidate = () => {
      timer = null;
      // Re-check visibility: the tab may have hidden after the flush was
      // scheduled. Keep the backlog and let `visibilitychange` flush it.
      if (hidden()) {
        return;
      }
      const broad = pendingBroad;
      const ids = [...pendingIds];
      pendingBroad = false;
      pendingIds.clear();
      lastInvalidatedAt = Date.now();
      flushRef.current({ broad, ids });
    };

    const scheduleFlush = () => {
      if (hidden() || timer !== null) {
        // Hidden: wait for re-show. Timer set: collapse into the pending flush.
        return;
      }
      const wait = Math.max(
        0,
        LIVE_BRIDGE_INVALIDATION_THROTTLE_MS - (Date.now() - lastInvalidatedAt)
      );
      timer = setTimeout(invalidate, wait);
    };

    const handleChange = (change: TChange) => {
      const id = getChangeIdRef.current(change);
      if (id) {
        pendingIds.add(id);
      } else {
        pendingBroad = true;
      }
      scheduleFlush();
    };

    const handleVisibility = () => {
      if (!hidden() && hasPending()) {
        scheduleFlush();
      }
    };

    const unsubscribe = subscribe(handleChange);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibility);
    }

    return () => {
      unsubscribe();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibility);
      }
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [subscribe]);
}
