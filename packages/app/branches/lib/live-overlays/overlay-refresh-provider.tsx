"use client";

import { createContext, type ReactNode, useCallback, useContext } from "react";
import { useLiveQueryBridge } from "../../../shared/hooks/use-live-query-bridge";
import {
  type UseOverlayRefreshResult,
  useOverlayRefresh,
} from "./use-overlay-refresh";

/**
 * Injected port for a sibling capture-side enrichment queue (FEA-1899-adjacent):
 * when an app-focus enrichment pass finishes, it can signal the overlays to
 * re-read. F5 only CONSUMES this — it does not build the queue. Absent the
 * provider/signal, window focus + manual refresh still drive overlay refresh.
 */
export type OverlayRefreshSignal = {
  subscribe(onSignal: () => void): () => void;
};

export type OverlayRefreshContextValue = UseOverlayRefreshResult;

const OverlayRefreshContext = createContext<OverlayRefreshContextValue | null>(
  null
);

function isHidden(): boolean {
  return typeof document !== "undefined" && document.hidden === true;
}

/**
 * Mounts the app-focus / tab-visible / injected-signal refresh triggers for the
 * Branches live overlays, reusing the shared `useLiveQueryBridge` throttle +
 * visibility discipline (one flush per `LIVE_BRIDGE_INVALIDATION_THROTTLE_MS`,
 * deferred while hidden) so rapid focus toggles collapse into a single refresh.
 * Provides `{ refresh, isChecking }` to descendants (the refresh button/status).
 */
export function BranchesOverlayRefreshProvider({
  signal,
  children,
}: {
  signal?: OverlayRefreshSignal;
  children: ReactNode;
}) {
  const { refresh, isChecking } = useOverlayRefresh();

  // Model focus / visibility / signal as a change stream so the throttle +
  // visibility gating live in exactly one place (the shared bridge).
  const subscribe = useCallback(
    (onChange: (change: unknown) => void) => {
      const trigger = () => {
        if (!isHidden()) {
          onChange({});
        }
      };
      // 'use client' hook — `globalThis` (not `window`) per the package
      // convention; the SSR guard is unnecessary here.
      const unsubscribers: Array<() => void> = [];
      globalThis.addEventListener("focus", trigger);
      unsubscribers.push(() =>
        globalThis.removeEventListener("focus", trigger)
      );
      document.addEventListener("visibilitychange", trigger);
      unsubscribers.push(() =>
        document.removeEventListener("visibilitychange", trigger)
      );
      if (signal) {
        unsubscribers.push(signal.subscribe(() => onChange({})));
      }
      return () => {
        for (const unsubscribe of unsubscribers) {
          unsubscribe();
        }
      };
    },
    [signal]
  );

  useLiveQueryBridge<unknown>({
    subscribe,
    getChangeId: () => undefined,
    flush: refresh,
  });

  return (
    <OverlayRefreshContext.Provider value={{ refresh, isChecking }}>
      {children}
    </OverlayRefreshContext.Provider>
  );
}

/**
 * Read the overlay refresh surface. Falls back to a standalone
 * `useOverlayRefresh()` when no provider is mounted, so the button/status work
 * (manual refresh only, no focus trigger) outside the provider too.
 */
export function useOverlayRefreshContext(): OverlayRefreshContextValue {
  const context = useContext(OverlayRefreshContext);
  const fallback = useOverlayRefresh();
  return context ?? fallback;
}
