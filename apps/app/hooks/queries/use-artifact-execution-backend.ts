"use client";

import type { ExecutionBackendResponse } from "@repo/api/src/types/settings";
import { useQuery } from "@tanstack/react-query";
import { useIsLoopsEnabled } from "@/hooks/queries/use-compute-mode";
import { useApiClient } from "@/hooks/use-api-client";

export const executionBackendKeys = {
  all: ["execution-backend"] as const,
  detail: (artifactId: string) =>
    [...executionBackendKeys.all, artifactId] as const,
};

/**
 * Fetch the execution backend for a specific artifact.
 * Returns which backend (LOOPS or GITHUB_ACTIONS) should be used
 * for subsequent operations on this artifact, based on its execution history.
 */
export function useArtifactExecutionBackend(artifactId: string) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: executionBackendKeys.detail(artifactId),
    queryFn: () =>
      apiClient.get<ExecutionBackendResponse>(
        `/artifacts/${artifactId}/execution-backend`
      ),
    enabled: !!artifactId,
    staleTime: 30 * 1000, // 30 seconds — may change after a loop/action completes
  });
}

/**
 * Convenience hook: returns whether to use loops for a specific artifact,
 * along with loading state.
 *
 * Uses the per-artifact execution backend if available, falling back to
 * the org-level compute mode while loading.
 */
export function useIsLoopsEnabledForArtifact(artifactId: string): {
  isLoopsEnabled: boolean;
  isLoading: boolean;
} {
  const { data, isLoading: isBackendLoading } =
    useArtifactExecutionBackend(artifactId);
  const { isLoopsEnabled: orgDefault, isLoading: isOrgLoading } =
    useIsLoopsEnabled();

  if (isBackendLoading) {
    return { isLoopsEnabled: orgDefault, isLoading: isOrgLoading };
  }

  return {
    isLoopsEnabled: data?.backend === "LOOPS",
    isLoading: false,
  };
}
