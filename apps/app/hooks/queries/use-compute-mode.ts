"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

type ComputeMode = "GITHUB_ACTIONS" | "LOOPS";

type ComputeModeResponse = { computeMode: ComputeMode };

export const computeModeKeys = {
  all: ["compute-mode"] as const,
};

/**
 * Fetch the organization's current compute mode.
 */
export function useComputeMode() {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: computeModeKeys.all,
    queryFn: () => apiClient.get<ComputeModeResponse>("/settings/compute-mode"),
    staleTime: 5 * 60 * 1000, // 5 minutes — rarely changes
  });
}

/**
 * Convenience hook: returns whether the org uses Loops compute,
 * along with loading state to prevent wrong-backend routing during initial fetch.
 */
export function useIsLoopsEnabled(): {
  isLoopsEnabled: boolean;
  isLoading: boolean;
} {
  const { data, isLoading } = useComputeMode();
  return { isLoopsEnabled: data?.computeMode === "LOOPS", isLoading };
}

/**
 * Set the organization's compute mode.
 */
export function useSetComputeMode() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (mode: ComputeMode) =>
      apiClient.put<ComputeModeResponse>("/settings/compute-mode", {
        computeMode: mode,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: computeModeKeys.all });
    },
  });
}
