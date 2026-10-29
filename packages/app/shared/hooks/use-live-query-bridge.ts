"use client";

import { useEffect, useRef } from "react";

/**
 * Minimum gap between query invalidations driven by live DB-change events. A
 * burst within the window collapses into a single trailing flush. Exported so
 * each domain bridge (and its tests) reference one source of truth.
 */
export const LIVE_BRIDGE_INVALIDATION_THROTTLE_MS = 5000;

/**
 * ISS-11611: the same gap for the Dashboard's INSIGHTS aggregates, which are
 * whole-table rollups rather than a page of rows. Measured on a first-run
 * benchmark (2026-09-29, fresh profile, 210 sessions), the 5s gap above kept
 * `desktop:db:get-insights` running indefinitely under the continuous local
 * writes of an import or a live agent session: 439 calls in ~45 minutes for
 * ~2,344s of cumulative wall time, still firing 6-24 times a minute long after
 * the import had finished. One rollup a minute is the cadence those aggregates
 * are refreshed at instead.
 */
export const LIVE_BRIDGE_INSIGHTS_INVALIDATION_THROTTLE_MS = 60_000;

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
 * - `paused` — hold the backlog instead of flushing it (ISS-11611), for a domain
 *   whose refresh must not compete with a bulk write such as the desktop boot
 *   import. Treated exactly like a hidden tab: changes keep coalescing and the
 *   backlog flushes once when it clears.
 * - `throttleMs` — the per-domain gap, defaulting to
 *   {@link LIVE_BRIDGE_INVALIDATION_THROTTLE_MS}.
 *
 * Behavior (identical across domains):
 * - **Throttled** to one flush per {@link LIVE_BRIDGE_INVALIDATION_THROTTLE_MS}:
 *   the first change after a quiet period flushes promptly; a burst collapses
 *   into a single trailing flush at the window boundary.
 * - **Visibility-gated** — defers while the tab is hidden, flushes the backlog
 *   on re-show. `paused` defers on the same machinery.
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
  paused?: boolean;
  throttleMs?: number;
}): void {
  const { subscribe } = params;
  const paused = params.paused === true;
  const throttleMs = params.throttleMs ?? LIVE_BRIDGE_INVALIDATION_THROTTLE_MS;
  const flushRef = useRef(params.flush);
  const getChangeIdRef = useRef(params.getChangeId);
  const pausedRef = useRef(paused);
  const throttleMsRef = useRef(throttleMs);
  // Assigned by the subscription effect so the resume effect below can drain a
  // held backlog without re-subscribing when `paused` clears.
  const resumeRef = useRef<(() => void) | null>(null);
  flushRef.current = params.flush;
  getChangeIdRef.current = params.getChangeId;
  pausedRef.current = paused;
  throttleMsRef.current = throttleMs;

  useEffect(() => {
    if (!subscribe) {
      return;
    }

    const blocked = () =>
      pausedRef.current ||
      (globalThis.document !== undefined &&
        globalThis.document.hidden === true);

    let pendingBroad = false;
    const pendingIds = new Set<string>();
    let lastInvalidatedAt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const hasPending = () => pendingBroad || pendingIds.size > 0;

    const invalidate = () => {
      timer = null;
      // Re-check: the tab may have hidden, or a bulk write may have started,
      // after the flush was scheduled. Keep the backlog for the resume path.
      if (blocked()) {
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
      if (blocked() || timer !== null) {
        // Blocked: wait for re-show or unpause. Timer set: collapse into the
        // pending flush.
        return;
      }
      const wait = Math.max(
        0,
        throttleMsRef.current - (Date.now() - lastInvalidatedAt)
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

    const handleResume = () => {
      if (!blocked() && hasPending()) {
        scheduleFlush();
      }
    };
    resumeRef.current = handleResume;

    const unsubscribe = subscribe(handleChange);
    if (globalThis.document !== undefined) {
      globalThis.document.addEventListener("visibilitychange", handleResume);
    }

    return () => {
      resumeRef.current = null;
      unsubscribe();
      if (globalThis.document !== undefined) {
        globalThis.document.removeEventListener(
          "visibilitychange",
          handleResume
        );
      }
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [subscribe]);

  // A cleared `paused` drains what the pause held, on the same path a re-shown
  // tab takes. Separate from the subscription effect so unpausing never tears
  // down and rebuilds the change subscription.
  useEffect(() => {
    if (!paused) {
      resumeRef.current?.();
    }
  }, [paused]);
}
