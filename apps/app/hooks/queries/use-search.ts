"use client";

import type { GlobalSearchResponse } from "@repo/api/src/types/search";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

export const searchKeys = {
  all: ["search"] as const,
  query: (q: string) => [...searchKeys.all, q] as const,
};

export function useGlobalSearch(
  query: string,
  options?: Omit<UseQueryOptions<GlobalSearchResponse>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();
  const trimmed = query.trim();

  return useQuery({
    queryKey: searchKeys.query(trimmed),
    queryFn: () =>
      apiClient.get<GlobalSearchResponse>(
        `/search?q=${encodeURIComponent(trimmed)}`
      ),
    enabled: !!trimmed,
    staleTime: 30_000,
    ...options,
  });
}
