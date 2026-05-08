"use client";

import type { WorkstreamWithProject } from "@repo/api/src/types/workstream";
import type { UseQueryOptions } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";
import { workstreamKeys } from "./use-workstreams";

export function useInProgressWorkstreams(
  options?: Omit<
    UseQueryOptions<WorkstreamWithProject[]>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: workstreamKeys.inProgress(),
    queryFn: () =>
      apiClient.get<WorkstreamWithProject[]>("/dashboard/workstreams"),
    staleTime: 30 * 1000,
    ...options,
  });
}
