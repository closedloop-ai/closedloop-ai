"use client";

import type {
  DisconnectGitHubResponse,
  GetBranchesResponse,
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
  branches: (repoId: string, limit?: number) =>
    [...githubKeys.all, "branches", repoId, ...(limit ? [limit] : [])] as const,
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

export function useGitHubBranches(
  repositoryId: string,
  options?: Omit<
    UseQueryOptions<GetBranchesResponse>,
    "queryKey" | "queryFn"
  > & {
    limit?: number;
  }
) {
  const apiClient = useApiClient();
  const searchParams = options?.limit ? `?limit=${options.limit}` : "";

  return useQuery({
    ...options,
    queryKey: githubKeys.branches(repositoryId, options?.limit),
    queryFn: () =>
      apiClient.get<GetBranchesResponse>(
        `/integrations/github/repositories/${repositoryId}/branches${searchParams}`
      ),
    enabled: !!repositoryId && options?.enabled !== false,
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
      queryClient.invalidateQueries({ queryKey: githubKeys.all });
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
