"use client";

import { EntityType } from "@repo/api/src/types/entity-link";
import type {
  CreateFeatureInput,
  FeatureWithWorkstream,
  FindFeaturesOptions,
  UpdateFeatureInput,
} from "@repo/api/src/types/feature";
import {
  type UseQueryOptions,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";
import { dashboardKeys } from "./use-dashboard-stats";
import { invalidateEntityLinkQueries } from "./use-entity-links";
import { projectTreeKeys } from "./use-project-tree";
import { projectKeys, useProjectsByTeam } from "./use-projects";

// Query keys
export const featureKeys = {
  all: ["features"] as const,
  lists: () => [...featureKeys.all, "list"] as const,
  list: (filters: Record<string, unknown>) =>
    [...featureKeys.lists(), filters] as const,
  details: () => [...featureKeys.all, "detail"] as const,
  detail: (id: string) => [...featureKeys.details(), id] as const,
  bySlug: (slug: string) => [...featureKeys.all, "by-slug", slug] as const,
};

// Queries
export function useFeatures(
  searchParams: FindFeaturesOptions,
  options?: Omit<
    UseQueryOptions<FeatureWithWorkstream[]>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: featureKeys.list(searchParams),
    queryFn: () => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(searchParams)) {
        if (value !== undefined) {
          params.set(key, value.toString());
        }
      }
      return apiClient.get<FeatureWithWorkstream[]>(
        `/features?${params.toString()}`
      );
    },
    ...options,
  });
}

export function useFeature(
  id: string,
  options?: Omit<UseQueryOptions<FeatureWithWorkstream>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: featureKeys.detail(id),
    queryFn: () => apiClient.get<FeatureWithWorkstream>(`/features/${id}`),
    enabled: !!id,
    ...options,
  });
}

export function useFeatureBySlug(
  slug: string,
  options?: Omit<UseQueryOptions<FeatureWithWorkstream>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: featureKeys.bySlug(slug),
    queryFn: () =>
      apiClient.get<FeatureWithWorkstream>(`/features/by-slug/${slug}`),
    enabled: !!slug,
    ...options,
  });
}

/**
 * Fetch all features across every project in a team.
 * Fans out one query per project using useQueries and flattens the results.
 */
export function useFeaturesByTeam(
  teamId: string,
  options?: { enabled?: boolean }
) {
  const apiClient = useApiClient();
  const enabled = (options?.enabled ?? true) && !!teamId;
  const { data: projects = [], isLoading: loadingProjects } = useProjectsByTeam(
    teamId,
    { enabled }
  );

  const featureQueries = useQueries({
    queries: projects.map((project) => ({
      queryKey: featureKeys.list({ projectId: project.id }),
      queryFn: () =>
        apiClient.get<FeatureWithWorkstream[]>(
          `/features?projectId=${project.id}`
        ),
      enabled,
    })),
  });

  return {
    data: featureQueries.flatMap((q) => q.data ?? []),
    isLoading: loadingProjects || featureQueries.some((q) => q.isLoading),
  };
}

// Mutations
export function useCreateFeature() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: CreateFeatureInput) =>
      apiClient.post<FeatureWithWorkstream>("/features", input),
    onSuccess: (_, input) => {
      queryClient.invalidateQueries({ queryKey: featureKeys.lists() });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all });
      queryClient.invalidateQueries({
        queryKey: projectTreeKeys.detail(input.projectId),
      });
    },
  });
}

export function useUpdateFeature() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: UpdateFeatureInput) => {
      const { id, ...body } = input;
      return apiClient.put<FeatureWithWorkstream>(`/features/${id}`, body);
    },
    onSuccess: (data, input) => {
      queryClient.invalidateQueries({
        queryKey: featureKeys.detail(input.id),
      });
      queryClient.invalidateQueries({
        queryKey: featureKeys.bySlug(data.slug),
      });
      queryClient.invalidateQueries({ queryKey: featureKeys.lists() });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all });
      if (input.projectId) {
        queryClient.invalidateQueries({ queryKey: projectKeys.all });
      }
      invalidateEntityLinkQueries(queryClient, input.id, EntityType.Feature);
    },
  });
}

export function useDeleteFeature() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<{ deleted: true }>(`/features/${id}`),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: featureKeys.all });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all });
      invalidateEntityLinkQueries(queryClient, id, EntityType.Feature);
    },
  });
}
