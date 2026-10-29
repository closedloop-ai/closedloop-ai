import type { AgentSessionsChange } from "@repo/app/agents/data-source/agent-sessions-data-source";
import { useAgentSessionsDataSource } from "@repo/app/agents/data-source/provider";
import { insightsKeys } from "@repo/app/insights/hooks/use-insights";
import {
  LIVE_BRIDGE_INSIGHTS_INVALIDATION_THROTTLE_MS,
  useLiveQueryBridge,
} from "@repo/app/shared/hooks/use-live-query-bridge";
import { useQueryClient } from "@tanstack/react-query";
import {
  isImportSettled,
  useSessionsImportProgress,
} from "../components/sessions/sessions-summary-cards-state";

/**
 * Desktop-only bridge that refreshes the local Insights aggregates off the same
 * `desktop:db:changed` push stream the Sessions views use.
 *
 * The dashboard's KPI cards, heatmap, and charts read through the
 * `@repo/app/insights` hooks with `staleTime: Infinity` (push model — no
 * polling). `AgentSessionsLiveBridge` only moves the `agentSessionKeys`
 * families, so without this bridge the insights queries would fetch one
 * snapshot on mount (an early or empty one during first-launch backfill) and
 * never update until reload. Any DB change can shift an aggregate, so every
 * change is treated as broad and invalidates `insightsKeys.all`; the shared
 * {@link useLiveQueryBridge} engine throttles and visibility-gates the flushes.
 *
 * ISS-11611 — two bounds on that stream, because an aggregate rollup is not a
 * page of rows and the local DB changes continuously while the boot import (or
 * any live agent session) writes:
 *
 * - **Held for the duration of the boot import.** A change arriving while the
 *   import is in progress coalesces into the backlog instead of flushing, and
 *   the backlog flushes ONCE when the import settles. The aggregates still load
 *   immediately on mount — only their re-reads wait, so the dashboard is not
 *   re-running whole-table rollups against the backfill writer every 5s.
 * - **One rollup a minute afterwards**
 *   ({@link LIVE_BRIDGE_INSIGHTS_INVALIDATION_THROTTLE_MS}) rather than the
 *   session lists' 5s, which under continuous writes is a continuous refetch.
 *
 * Desktop-only by construction: it consumes the local data source's `subscribe`
 * (undefined on the web HTTP source, where the hook is a no-op), so insights
 * stay one-shot-on-load on web — matching the web Insights page's behavior.
 *
 * Renders nothing.
 */
export function InsightsLiveBridge() {
  const dataSource = useAgentSessionsDataSource();
  const queryClient = useQueryClient();
  // The same import-progress signal the Sessions surfaces read. Its poll is the
  // shared runtime-status one (a single interval across every subscriber) and it
  // latches off on the main process's own terminal signal, so this costs one
  // listener while an import is running and nothing afterwards.
  const ingestProgress = useSessionsImportProgress(true);
  // ISS-11611 (whitlockk review): the hold runs until the import SETTLES, not until
  // `isLocalImportInProgress` goes false. That predicate is `processed < total`,
  // and `processed === total` with `complete: false` is reachable between the
  // staggered per-harness passes and while a source is being retried — so it
  // released the held rollups back onto the live backfill writer mid-import.
  // `isImportSettled` is the main process's own terminal answer (`complete`, or
  // either degraded terminal), which is the same signal
  // `useSessionsImportProgress` latches its poll off on, so the hold is bounded
  // by exactly what bounds that poll. A `null` snapshot (runtime not up, or not
  // yet polled) is NOT a hold: there is no import to wait for.
  const importUnsettled =
    ingestProgress !== null && !isImportSettled(ingestProgress);

  useLiveQueryBridge<AgentSessionsChange>({
    subscribe: dataSource.subscribe,
    // Every DB change is broad for aggregates — no per-entity scoping.
    getChangeId: () => undefined,
    paused: importUnsettled,
    throttleMs: LIVE_BRIDGE_INSIGHTS_INVALIDATION_THROTTLE_MS,
    flush: () => {
      // `flush` is synchronous, so the refresh is fire-and-forget; a failed
      // refetch surfaces through the insights queries' own error state.
      queryClient
        .invalidateQueries({ queryKey: insightsKeys.all })
        .catch(() => undefined);
    },
  });

  return null;
}
