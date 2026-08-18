import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import type { AgentSessionQueryFilters } from "@repo/app/agents/data-source/agent-sessions-data-source";
import { agentSessionKeys } from "@repo/app/agents/hooks/use-agent-sessions";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";

/**
 * FEA-3574 review (wongk): read the LOCAL SQLite usage totals directly over IPC,
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
 * ISS-4429 (wongk review): this is a FALLBACK-only read, so it deliberately does
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
  options: { enabled: boolean }
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
  });
}
