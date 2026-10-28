import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import type { AgentSessionQueryFilters } from "@repo/app/agents/data-source/agent-sessions-data-source";
import { agentSessionKeys } from "@repo/app/agents/hooks/agent-session-keys";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";

/**
 * FEA-3574 review (whitlockk): read the LOCAL SQLite usage totals directly over IPC,
 * independent of the mode-swapped Sessions data source.
 *
 * In Cloud mode the shared `useAgentSessionUsage` resolves to the cloud HTTP
 * source (via the swapped `AgentSessionsDataSourceProvider`), so it cannot back
 * the "always-available" Sessions/Tokens/Cost cards with their true local
 * values — a cloud read failure would dash a metric SQLite can still compute.
 * This hook reads `window.desktopApi.agentSessionsApi.usage` directly so those
 * cards stay SQLite-backed regardless of the delivery source. The caller gates
 * it to Cloud mode (in Local mode the delivery `usage` IS the local source).
 *
 * Keyed under the `local` scope (matching `createLocalAgentSessionsDataSource`'s
 * scope) so it shares the local-source cache and never collides with the cloud
 * HTTP usage entry for the same filters. Extracted from `SessionsView` so the
 * view's tests can mock this read without standing up a `QueryClientProvider`.
 *
 * ISS-4429 (whitlockk review): this is a FALLBACK-only read, so it deliberately does
 * NOT `keepPreviousData`. Retaining the previous filter key's totals means a
 * search/date/facet change followed by a cloud failure could pin OLD-scope local
 * numbers beside the NEW list — the cards would silently describe a different
 * population than the rows. Without the placeholder, a scope change resets the
 * data to `undefined` while the new-scope read warms, so the always-available
 * cards skeleton (import/pending) rather than showing a stale-scope number; the
 * caller's `alwaysAvailableLoading` gate already covers that window.
 */
export function useLocalAgentSessionUsage(
  filters: AgentSessionQueryFilters,
  options: { enabled: boolean; refetchInterval?: number | false }
): UseQueryResult<AgentSessionUsageSummary> {
  return useQuery({
    queryKey: agentSessionKeys.usage("local", filters),
    queryFn: () => {
      const usage = window.desktopApi?.agentSessionsApi?.usage;
      if (!usage) {
        return Promise.reject(new Error("Local sessions usage unavailable."));
      }
      return usage(filters);
    },
    enabled: options.enabled,
    // ISS-10584: a caller watching a RUNNING boot import needs this read to be
    // re-taken, because the store gains session rows throughout it. Omitted, the
    // query keeps react-query's default of no polling, which is what every
    // existing caller expects.
    refetchInterval: options.refetchInterval ?? false,
    // Without this a backgrounded or unfocused window stops polling and the
    // caller's count freezes mid-import — the same freeze this option exists to
    // end, arriving by a different route.
    refetchIntervalInBackground: options.refetchInterval !== undefined,
  });
}
