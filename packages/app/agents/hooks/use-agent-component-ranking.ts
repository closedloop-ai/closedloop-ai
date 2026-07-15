"use client";

import type { RankingResponse } from "@repo/api/src/types/analytics";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";

/**
 * Query key factory for the ranking analytics slice.
 *
 * Root `["agent-component-ranking"]` is distinct from the inventory
 * `["agent-components"]` slice to prevent cross-cache collisions.
 */
export const agentComponentRankingKeys = {
  all: ["agent-component-ranking"] as const,
  list: (kind?: string) =>
    [...agentComponentRankingKeys.all, kind ?? "all"] as const,
};

/**
 * TanStack Query hook for the org-wide component ranking/leaderboard.
 *
 * Calls GET /agent-components/ranking (org-visible, withAnyAuth).
 * Returns a paginated list of stack-ranked components sorted by invocations
 * descending, annotated with rank, sessions, adoptionBreadth, and errorRate.
 *
 * @param kind   Optional kind filter (AgentComponentKind value).
 * @param options Standard TanStack Query options (staleTime, enabled, etc.).
 *
 * @example
 *   const { data, isLoading, isError } = useAgentComponentRanking();
 *   const { data } = useAgentComponentRanking("plugin");
 */
export function useAgentComponentRanking(
  kind?: string,
  options?: Omit<UseQueryOptions<RankingResponse>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery<RankingResponse>({
    queryKey: agentComponentRankingKeys.list(kind),
    queryFn: () => {
      const params = new URLSearchParams();
      if (kind) {
        params.set("kind", kind);
      }
      const qs = params.toString();
      return apiClient.get<RankingResponse>(
        `/agent-components/ranking${qs ? `?${qs}` : ""}`
      );
    },
    ...options,
  });
}
