"use client";

import type { GlobalSearchResponse } from "@repo/api/src/types/search";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";

export const searchKeys = {
  all: ["search"] as const,
  query: (q: string) => [...searchKeys.all, "q", q] as const,
  tag: (tagId: string) => [...searchKeys.all, "tag", tagId] as const,
};

type UseGlobalSearchParams = {
  query?: string;
  tagId?: string;
};

export function useGlobalSearch(
  params: UseGlobalSearchParams,
  options?: Omit<UseQueryOptions<GlobalSearchResponse>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();
  const trimmed = (params.query ?? "").trim();
  const tagId = params.tagId?.trim();

  const isTagSearch = !!tagId;
  const isTextSearch = !!trimmed;

  const queryKey = isTagSearch
    ? searchKeys.tag(tagId)
    : searchKeys.query(trimmed);

  const queryFn = isTagSearch
    ? () =>
        apiClient.get<GlobalSearchResponse>(
          `/search?tagId=${encodeURIComponent(tagId)}`
        )
    : () =>
        apiClient.get<GlobalSearchResponse>(
          `/search?q=${encodeURIComponent(trimmed)}`
        );

  return useQuery({
    queryKey,
    queryFn,
    enabled: isTagSearch || isTextSearch,
    staleTime: 30_000,
    ...options,
  });
}
