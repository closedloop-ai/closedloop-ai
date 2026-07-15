"use client";

import type {
  CreateDistributionRequest,
  DistributionDto,
  UpdateDistributionRequest,
} from "@repo/api/src/types/distribution";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";

/**
 * TanStack Query key factory for the distributions slice (FEA-2923 / T-17).
 */
export const distributionKeys = {
  all: ["distributions"] as const,
  lists: () => [...distributionKeys.all, "list"] as const,
  list: () => [...distributionKeys.lists()] as const,
  details: () => [...distributionKeys.all, "detail"] as const,
  detail: (id: string) => [...distributionKeys.details(), id] as const,
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Fetches the org's distributions.
 * GET /distributions
 */
export function useDistributions(
  options?: Omit<UseQueryOptions<DistributionDto[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: distributionKeys.list(),
    queryFn: () => apiClient.get<DistributionDto[]>("/distributions"),
    ...options,
  });
}

/**
 * Fetches a single distribution by ID.
 * GET /distributions/{id}
 */
export function useDistribution(id: string) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: distributionKeys.detail(id),
    queryFn: () => apiClient.get<DistributionDto>(`/distributions/${id}`),
    enabled: Boolean(id),
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Creates a new Distribution (assigns a CatalogItem to a targeting set).
 * POST /distributions (admin-only)
 */
export function useCreateDistribution() {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateDistributionRequest) =>
      apiClient.post<DistributionDto>("/distributions", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: distributionKeys.lists() });
    },
  });
}

/**
 * Updates an existing Distribution.
 * PATCH /distributions/{id} (admin-only)
 */
export function useUpdateDistribution() {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...data }: UpdateDistributionRequest & { id: string }) =>
      apiClient.patch<DistributionDto>(`/distributions/${id}`, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: distributionKeys.detail(variables.id),
      });
      queryClient.invalidateQueries({ queryKey: distributionKeys.lists() });
    },
  });
}
