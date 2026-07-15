"use client";

import type {
  PromoteCandidate,
  PromoteRequest,
  PromoteResponse,
} from "@repo/api/src/types/distribution";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";
import { catalogKeys } from "./use-catalog";
import { distributionKeys } from "./use-distributions";

/**
 * TanStack Query key factory for the analytics slice (FEA-2923 / T-17.5).
 */
export const analyticsKeys = {
  all: ["agent-component-analytics"] as const,
  ranking: () => [...analyticsKeys.all, "ranking"] as const,
  compliance: () => [...analyticsKeys.all, "compliance"] as const,
  tokenTrend: (slug: string) =>
    [...analyticsKeys.all, "token-trend", slug] as const,
};

// ---------------------------------------------------------------------------
// Ranking query (GET /agent-components/ranking)
// ---------------------------------------------------------------------------

/**
 * Fetches the org-wide component ranking leaderboard.
 * Coaching items are excluded server-side (T-22.5).
 */
export function useAgentComponentRanking() {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: analyticsKeys.ranking(),
    queryFn: () =>
      apiClient.get<PromoteCandidate[]>("/agent-components/ranking"),
  });
}

// ---------------------------------------------------------------------------
// Promote mutation (POST /agent-components/promote)
// ---------------------------------------------------------------------------

/**
 * Promotes a discovered AgentComponent to a CatalogItem + Distribution targeting all.
 * POST /agent-components/promote (admin-only, AC-016 / T-17.4)
 */
export function usePromoteAgentComponent() {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: PromoteRequest) =>
      apiClient.post<PromoteResponse>("/agent-components/promote", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: catalogKeys.lists() });
      queryClient.invalidateQueries({ queryKey: distributionKeys.lists() });
      queryClient.invalidateQueries({ queryKey: analyticsKeys.ranking() });
    },
  });
}
