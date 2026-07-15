"use client";

import type { TokenTrendResponse } from "@repo/api/src/types/agent-component-analytics";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";

/**
 * Query key factory for the per-component token-trend analytics slice.
 *
 * Root `["agent-component-token-trend"]` is distinct from the inventory
 * `["agent-components"]` and ranking `["agent-component-ranking"]` slices to
 * prevent cross-cache collisions.
 */
export const agentComponentTokenTrendKeys = {
  all: ["agent-component-token-trend"] as const,
  detail: (slug: string, userId?: string) =>
    [...agentComponentTokenTrendKeys.all, slug, userId ?? "all"] as const,
};

/**
 * TanStack Query hook for the per-(component, model) token-trend time series.
 *
 * Calls GET /agent-components/{slug}/token-trend (org-visible, withAnyAuth).
 * The slug is the org-level identity slug `${kind}::${normalizedKey}` and is
 * URL-encoded on the wire. Returns token/cost/latency/truncation points ordered
 * ascending by session start, plus a deduped model legend.
 *
 * Disabled when `slug` is empty so the query never fires with a bad path.
 *
 * @param slug    Org-level identity slug of the component.
 * @param userId  Optional user scope for the personal optimization view.
 * @param options Standard TanStack Query options (staleTime, enabled, etc.).
 *
 * @example
 *   const { data, isLoading, isError } = useAgentComponentTokenTrend(slug);
 */
export function useAgentComponentTokenTrend(
  slug: string,
  userId?: string,
  options?: Omit<UseQueryOptions<TokenTrendResponse>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery<TokenTrendResponse>({
    queryKey: agentComponentTokenTrendKeys.detail(slug, userId),
    queryFn: () => {
      const params = new URLSearchParams();
      if (userId) {
        params.set("userId", userId);
      }
      const qs = params.toString();
      return apiClient.get<TokenTrendResponse>(
        `/agent-components/${encodeURIComponent(slug)}/token-trend${
          qs ? `?${qs}` : ""
        }`
      );
    },
    enabled: Boolean(slug),
    ...options,
  });
}
