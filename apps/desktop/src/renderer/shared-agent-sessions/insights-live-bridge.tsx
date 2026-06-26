import type { AgentSessionsChange } from "@repo/app/agents/data-source/agent-sessions-data-source";
import { useAgentSessionsDataSource } from "@repo/app/agents/data-source/provider";
import { insightsKeys } from "@repo/app/insights/hooks/use-insights";
import { useLiveQueryBridge } from "@repo/app/shared/hooks/use-live-query-bridge";
import { useQueryClient } from "@tanstack/react-query";

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
 * Desktop-only by construction: it consumes the local data source's `subscribe`
 * (undefined on the web HTTP source, where the hook is a no-op), so insights
 * stay one-shot-on-load on web — matching the web Insights page's behavior.
 *
 * Renders nothing.
 */
export function InsightsLiveBridge() {
  const dataSource = useAgentSessionsDataSource();
  const queryClient = useQueryClient();

  useLiveQueryBridge<AgentSessionsChange>({
    subscribe: dataSource.subscribe,
    // Every DB change is broad for aggregates — no per-entity scoping.
    getChangeId: () => undefined,
    flush: () => {
      queryClient.invalidateQueries({ queryKey: insightsKeys.all });
    },
  });

  return null;
}
