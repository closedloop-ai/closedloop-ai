"use client";

import type {
  ComputePreferenceResponse,
  SetComputePreferenceRequest,
} from "@repo/api/src/types/compute-target";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";

export const computePreferenceKeys = {
  all: ["compute-preference"] as const,
  detail: (userId: string) => [...computePreferenceKeys.all, userId] as const,
};

/**
 * Fetch the current user's compute preference.
 * The `userId` param is used only for cache keying; the API derives identity from auth token.
 */
export function useComputePreference(
  userId: string,
  options?: Omit<
    UseQueryOptions<ComputePreferenceResponse>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: computePreferenceKeys.detail(userId),
    queryFn: () =>
      apiClient.get<ComputePreferenceResponse>("/settings/compute-preference"),
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
    ...options,
  });
}

/**
 * Set the current user's compute preference with optimistic update.
 * The `userId` param is required to locate and update the correct cache entry.
 */
export function useSetComputePreference(userId: string) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (request: SetComputePreferenceRequest) =>
      apiClient.put<ComputePreferenceResponse>(
        "/settings/compute-preference",
        request
      ),
    onMutate: async (request: SetComputePreferenceRequest) => {
      const queryKey = computePreferenceKeys.detail(userId);
      await queryClient.cancelQueries({ queryKey });
      const previous =
        queryClient.getQueryData<ComputePreferenceResponse>(queryKey);
      // Merge with `previous` so a partial update (mode-only or harness-only)
      // never clobbers the field it does not touch. A mode/target switch keeps
      // the persisted Cloud harness; a harness-only change keeps mode + target.
      queryClient.setQueryData<ComputePreferenceResponse>(queryKey, {
        preferredComputeMode: request.mode,
        computeTargetId: request.computeTargetId ?? previous?.computeTargetId,
        selectedHarness: request.selectedHarness ?? previous?.selectedHarness,
        isExplicit: true,
      });
      return { previous };
    },
    onError: (_err, _request, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(
          computePreferenceKeys.detail(userId),
          context.previous
        );
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: computePreferenceKeys.detail(userId),
      });
    },
  });
}
