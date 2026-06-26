"use client";

import type {
  ConfirmDifferentAccountResetResponse,
  CreatePublicRepositoryInput,
  DeletePublicRepositoryResponse,
  DisconnectGitHubResponse,
  GetBranchesResponse,
  GetContributorsResponse,
  GetPullRequestsResponse,
  GetRepositoriesResponse,
  GitHubIntegrationStatus,
  GitHubPullRequestSummary,
  PublicRepositoryResponse,
} from "@repo/api/src/types/github";
import {
  type UseQueryOptions,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "../../shared/api/use-api-client";

// Query keys
export const githubKeys = {
  all: ["github"] as const,
  status: () => [...githubKeys.all, "status"] as const,
  repositories: () => [...githubKeys.all, "repositories"] as const,
  branches: (repoId: string, limit?: number) =>
    [...githubKeys.all, "branches", repoId, ...(limit ? [limit] : [])] as const,
  pullRequests: (repoId: string, projectId?: string) =>
    [...githubKeys.all, "pull-requests", repoId, projectId] as const,
  contributors: () => [...githubKeys.all, "contributors"] as const,
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

export type TaggedPullRequest = GitHubPullRequestSummary & {
  repoFullName?: string;
};

type RepoRef = {
  id: string;
  fullName?: string;
};

type PullRequestQueryResult = {
  data: GetPullRequestsResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  isSuccess: boolean;
};

export type UseGitHubPullRequestsAcrossReposResult = {
  pullRequests: TaggedPullRequest[];
  trackedUrls: Set<string>;
  trackedBranchKeys: Set<string>;
  isLoading: boolean;
  failedRepoCount: number;
  totalRepoCount: number;
  allFailed: boolean;
};

export function useGitHubPullRequestsAcrossRepos(
  repos: RepoRef[],
  projectId: string,
  options?: { enabled?: boolean }
): UseGitHubPullRequestsAcrossReposResult {
  const apiClient = useApiClient();
  const enabled = (options?.enabled ?? true) && repos.length > 0;
  const params = projectId ? `?projectId=${projectId}` : "";

  return useQueries({
    queries: repos.map((repo) => ({
      queryKey: githubKeys.pullRequests(repo.id, projectId),
      queryFn: () =>
        apiClient.get<GetPullRequestsResponse>(
          `/integrations/github/repositories/${repo.id}/pull-requests${params}`
        ),
      enabled,
    })),
    combine: (results) => ({
      pullRequests: tagPullRequestsByRepo(results, repos),
      trackedUrls: new Set<string>(
        results.flatMap((r) => r.data?.trackedPrUrls ?? [])
      ),
      trackedBranchKeys: new Set<string>(
        results.flatMap((r) => r.data?.trackedBranchKeys ?? [])
      ),
      ...computeRepoQueryStatus(results),
    }),
  });
}

function tagPullRequestsByRepo(
  results: PullRequestQueryResult[],
  repos: RepoRef[]
): TaggedPullRequest[] {
  return results.flatMap((result, i) =>
    (result.data?.pullRequests ?? []).map((pr) => ({
      ...pr,
      repoFullName: repos[i]?.fullName,
    }))
  );
}

function computeRepoQueryStatus(results: PullRequestQueryResult[]) {
  const isLoading = results.some((r) => r.isLoading);
  let failedCount = 0;
  let succeededCount = 0;
  for (const r of results) {
    if (r.isError) {
      failedCount++;
    } else if (r.isSuccess) {
      succeededCount++;
    }
  }
  const allSettled = results.length > 0 && !isLoading;
  return {
    isLoading,
    failedRepoCount: failedCount > 0 && succeededCount > 0 ? failedCount : 0,
    totalRepoCount: results.length,
    allFailed: allSettled && failedCount > 0 && succeededCount === 0,
  };
}

export function useGitHubContributors(
  options?: Omit<
    UseQueryOptions<GetContributorsResponse>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: githubKeys.contributors(),
    queryFn: () =>
      apiClient.get<GetContributorsResponse>(
        "/integrations/github/contributors"
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
      queryClient.invalidateQueries({ queryKey: githubKeys.all });
    },
  });
}

/**
 * PLN-634: confirm and execute the admin-approved different-account reset.
 * Wipes team repositories and project repository settings before claiming a
 * GitHub installation from a different account than was previously linked.
 * The installation to claim is read server-side from the prior UNINSTALLED
 * row, so no body is sent — query params on the redirect URL only drive the
 * confirmation dialog's display fields.
 */
export function useConfirmDifferentAccountReset() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: () =>
      apiClient.post<ConfirmDifferentAccountResetResponse>(
        "/integrations/github/connect/confirm-reset",
        {}
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: githubKeys.all });
    },
  });
}

export function useAddPublicRepository() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: CreatePublicRepositoryInput) =>
      apiClient.post<PublicRepositoryResponse>(
        "/integrations/github/public-repositories",
        input
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: githubKeys.repositories() });
    },
  });
}

export function useRemovePublicRepository() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<DeletePublicRepositoryResponse>(
        `/integrations/github/public-repositories?id=${id}`
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: githubKeys.repositories() });
    },
  });
}
