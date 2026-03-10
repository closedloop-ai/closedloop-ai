"use client";

import { EntityType } from "@repo/api/src/types/entity-link";
import type {
  CreateIssueInput,
  FindIssuesOptions,
  IssueWithWorkstream,
  UpdateIssueInput,
} from "@repo/api/src/types/issue";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";
import { dashboardKeys } from "./use-dashboard-stats";
import { invalidateEntityLinkQueries } from "./use-entity-links";
import { projectKeys } from "./use-projects";

// Query keys
export const issueKeys = {
  all: ["issues"] as const,
  lists: () => [...issueKeys.all, "list"] as const,
  list: (filters: Record<string, unknown>) =>
    [...issueKeys.lists(), filters] as const,
  details: () => [...issueKeys.all, "detail"] as const,
  detail: (id: string) => [...issueKeys.details(), id] as const,
  bySlug: (slug: string) => [...issueKeys.all, "by-slug", slug] as const,
};

// Queries
export function useIssues(
  searchParams: FindIssuesOptions,
  options?: Omit<UseQueryOptions<IssueWithWorkstream[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: issueKeys.list(searchParams),
    queryFn: () => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(searchParams)) {
        if (value !== undefined) {
          params.set(key, value.toString());
        }
      }
      return apiClient.get<IssueWithWorkstream[]>(
        `/issues?${params.toString()}`
      );
    },
    ...options,
  });
}

export function useIssue(
  id: string,
  options?: Omit<UseQueryOptions<IssueWithWorkstream>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: issueKeys.detail(id),
    queryFn: () => apiClient.get<IssueWithWorkstream>(`/issues/${id}`),
    enabled: !!id,
    ...options,
  });
}

export function useIssueBySlug(
  slug: string,
  options?: Omit<UseQueryOptions<IssueWithWorkstream>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: issueKeys.bySlug(slug),
    queryFn: () =>
      apiClient.get<IssueWithWorkstream>(`/issues/by-slug/${slug}`),
    enabled: !!slug,
    ...options,
  });
}

// Mutations
export function useCreateIssue() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: CreateIssueInput) =>
      apiClient.post<IssueWithWorkstream>("/issues", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: issueKeys.lists() });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all });
    },
  });
}

export function useUpdateIssue() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: UpdateIssueInput) => {
      const { id, ...body } = input;
      return apiClient.put<IssueWithWorkstream>(`/issues/${id}`, body);
    },
    onSuccess: (data, input) => {
      queryClient.invalidateQueries({
        queryKey: issueKeys.detail(input.id),
      });
      queryClient.invalidateQueries({
        queryKey: issueKeys.bySlug(data.slug),
      });
      queryClient.invalidateQueries({ queryKey: issueKeys.lists() });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all });
      if (input.projectId) {
        queryClient.invalidateQueries({ queryKey: projectKeys.all });
      }
      invalidateEntityLinkQueries(queryClient, input.id, EntityType.Issue);
    },
  });
}

export function useDeleteIssue() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<{ deleted: true }>(`/issues/${id}`),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: issueKeys.all });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all });
      invalidateEntityLinkQueries(queryClient, id, EntityType.Issue);
    },
  });
}
