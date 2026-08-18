"use client";

import type {
  CreateDistributionRequest,
  DistributionDto,
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
 * Withdraws a Distribution — stops offering the pack to the organization
 * (ISS-5123).
 * DELETE /distributions/{id} (admin-only)
 *
 * The cache work here exists to stop the UI briefly asserting a roll-out that
 * no longer exists, so it deliberately does NOT mirror `useCreateDistribution`:
 *
 *  - The detail entry is REMOVED, not invalidated. `getDetailForOrg` still
 *    returns a withdrawn record by id (the row survives, only the live reads
 *    filter it), and consumers prefer the detail read over the list row — so
 *    re-fetching it would re-render the dead distribution as though it were
 *    live. Nothing in the render path inspects `withdrawnAt`, so there is
 *    nothing to gain by keeping it and a false "still distributed" to lose.
 *  - The list entry is dropped from the cache immediately rather than only
 *    invalidated, so the surface flips to "not distributed" on the spot instead
 *    of showing a live roll-out until a round trip completes. The invalidate
 *    still follows, to reconcile with the server.
 */
export function useWithdrawDistribution() {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (distributionId: string) =>
      apiClient.delete<DistributionDto>(`/distributions/${distributionId}`),
    onSuccess: (_data, distributionId) => {
      queryClient.removeQueries({
        queryKey: distributionKeys.detail(distributionId),
      });
      queryClient.setQueryData<DistributionDto[]>(
        distributionKeys.list(),
        (previous) => previous?.filter((entry) => entry.id !== distributionId)
      );
      queryClient.invalidateQueries({ queryKey: distributionKeys.lists() });
    },
  });
}
