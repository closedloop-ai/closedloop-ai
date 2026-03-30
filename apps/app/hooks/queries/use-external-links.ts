"use client";

import { EntityType } from "@repo/api/src/types/entity-link";
import {
  type CreateExternalLinkInput,
  type ExternalLink,
  ExternalLinkType,
  type FindExternalLinksOptions,
  type UpdateExternalLinkInput,
} from "@repo/api/src/types/external-link";
import {
  type PreviewDeploymentInfo,
  parsePreviewDeploymentMetadata,
} from "@repo/api/src/types/external-link-utils";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { useApiClient } from "@/hooks/use-api-client";
import { dashboardKeys } from "./use-dashboard-stats";
import { invalidateEntityLinkQueries } from "./use-entity-links";
import { projectTreeKeys } from "./use-project-tree";

// Query keys
export const externalLinkKeys = {
  all: ["external-links"] as const,
  lists: () => [...externalLinkKeys.all, "list"] as const,
  list: (filters: Record<string, unknown>) =>
    [...externalLinkKeys.lists(), filters] as const,
  details: () => [...externalLinkKeys.all, "detail"] as const,
  detail: (id: string) => [...externalLinkKeys.details(), id] as const,
};

// Queries
export function useExternalLinks(
  searchParams: FindExternalLinksOptions,
  options?: Omit<UseQueryOptions<ExternalLink[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: externalLinkKeys.list(searchParams),
    queryFn: () => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(searchParams)) {
        if (value !== undefined) {
          params.set(key, value.toString());
        }
      }
      return apiClient.get<ExternalLink[]>(
        `/external-links?${params.toString()}`
      );
    },
    ...options,
  });
}

export function useExternalLinksByWorkstream(
  workstreamId: string,
  type?: ExternalLinkType,
  options?: Omit<UseQueryOptions<ExternalLink[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: externalLinkKeys.list({ workstreamId, type }),
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("workstreamId", workstreamId);
      if (type) {
        params.set("type", type);
      }
      return apiClient.get<ExternalLink[]>(
        `/external-links?${params.toString()}`
      );
    },
    enabled: !!workstreamId,
    ...options,
  });
}

/**
 * Fetch and parse the preview deployment for a workstream.
 * Returns the first PREVIEW_DEPLOYMENT external link with parsed metadata.
 */
export function useWorkstreamPreviewDeployment(
  workstreamId: string,
  options?: Omit<UseQueryOptions<ExternalLink[]>, "queryKey" | "queryFn">
) {
  const {
    data: previewLinks,
    refetch,
    isRefetching,
  } = useExternalLinksByWorkstream(
    workstreamId,
    ExternalLinkType.PreviewDeployment,
    {
      enabled: !!workstreamId,
      ...options,
    }
  );

  const previewDeployment = useMemo((): PreviewDeploymentInfo | null => {
    const link = previewLinks?.[0];
    if (!link) {
      return null;
    }
    const meta = parsePreviewDeploymentMetadata(link.metadata);
    return {
      state: meta?.state ?? null,
      environment: meta?.environment ?? null,
      ref: meta?.ref ?? null,
      sha: meta?.sha ?? null,
      url: link.externalUrl || null,
    };
  }, [previewLinks]);

  return { previewDeployment, refetch, isRefetching };
}

// Mutations
export function useCreateExternalLink() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: CreateExternalLinkInput) =>
      apiClient.post<ExternalLink>("/external-links", input),
    onSuccess: (_, input) => {
      queryClient.invalidateQueries({ queryKey: externalLinkKeys.lists() });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all });
      queryClient.invalidateQueries({
        queryKey: projectTreeKeys.detail(input.projectId),
      });
    },
  });
}

export function useUpdateExternalLink() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: UpdateExternalLinkInput) => {
      const { id, ...body } = input;
      return apiClient.put<ExternalLink>(`/external-links/${id}`, body);
    },
    onSuccess: (_, input) => {
      queryClient.invalidateQueries({
        queryKey: externalLinkKeys.detail(input.id),
      });
      queryClient.invalidateQueries({ queryKey: externalLinkKeys.lists() });
      invalidateEntityLinkQueries(
        queryClient,
        input.id,
        EntityType.ExternalLink
      );
    },
  });
}

export function useDeleteExternalLink() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<{ deleted: true }>(`/external-links/${id}`),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: externalLinkKeys.all });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all });
      invalidateEntityLinkQueries(queryClient, id, EntityType.ExternalLink);
    },
  });
}
