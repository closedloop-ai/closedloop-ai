"use client";

import type {
  DisconnectGitHubResponse,
  GetRepositoriesResponse,
  GitHubIntegrationStatus,
} from "@repo/api/src/types/github";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

// Query keys
export const githubKeys = {
  all: ["github"] as const,
  status: () => [...githubKeys.all, "status"] as const,
  repositories: () => [...githubKeys.all, "repositories"] as const,
};

// Queries
export function useGitHubIntegrationStatus(
  options?: Omit<
    UseQueryOptions<GitHubIntegrationStatus>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: githubKeys.status(),
    queryFn: () =>
      apiClient.get<GitHubIntegrationStatus>("/integrations/github"),
    ...options,
  });
}

export function useGitHubRepositories(
  options?: Omit<
    UseQueryOptions<GetRepositoriesResponse>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: githubKeys.repositories(),
    queryFn: () =>
      apiClient.get<GetRepositoriesResponse>(
        "/integrations/github/repositories"
      ),
    ...options,
  });
}

// Mutations
export function useDisconnectGitHub() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: () =>
      apiClient.delete<DisconnectGitHubResponse>("/integrations/github"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: githubKeys.status() });
      queryClient.invalidateQueries({ queryKey: githubKeys.repositories() });
    },
  });
}

/**
 * Get the GitHub OAuth URL for connecting.
 * Returns the app's OAuth route which initiates the OAuth flow with CSRF state,
 * then redirects to the GitHub App installation page.
 */
export function useGetGitHubConnectUrl(): string {
  return "/api/integrations/github";
}
