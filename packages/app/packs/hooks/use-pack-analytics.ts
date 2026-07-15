"use client";

import type { AgentComponentDetail } from "@repo/api/src/types/agent-component";
import { useQuery } from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";

/**
 * Fetches the canonical org-wide analytics for a pack's linked agent component
 * (`GET /agent-components/{slug}`) — the SSOT for per-pack KLOC/$, usage, and
 * adoption. Disabled when the pack has no `agentSlug` linkage.
 *
 * Calls the HTTP endpoint directly via `useApiClient` (mirroring
 * `useAgentComponentRanking`) rather than the data-source-scoped
 * `useAgentComponentDetail`, so the web-admin Plugin Catalog page needs no
 * AgentComponents data-source provider.
 */
export function usePackAnalytics(agentSlug: string | null | undefined) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: ["pack-analytics", agentSlug ?? "none"],
    queryFn: () =>
      apiClient.get<AgentComponentDetail>(
        `/agent-components/${encodeURIComponent(agentSlug as string)}`
      ),
    enabled: Boolean(agentSlug),
  });
}
