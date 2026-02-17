"use client";

import type {
  CreateEntityLinkInput,
  EntityLink,
  EntityType,
  LinkType,
} from "@repo/api/src/types/entity-link";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";

// Query keys
export const entityLinkKeys = {
  all: ["entity-links"] as const,
  lists: () => [...entityLinkKeys.all, "list"] as const,
  list: (filters: Record<string, unknown>) =>
    [...entityLinkKeys.lists(), filters] as const,
};

// Queries

/** All links (both directions) for an entity. */
export function useEntityLinks(
  entityId: string,
  entityType: EntityType,
  options?: Omit<UseQueryOptions<EntityLink[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: entityLinkKeys.list({ entityId, entityType, direction: "both" }),
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("entityId", entityId);
      params.set("entityType", entityType);
      params.set("direction", "both");
      return apiClient.get<EntityLink[]>(`/entity-links?${params.toString()}`);
    },
    enabled: !!entityId,
    ...options,
  });
}

/** Links where this entity is the target — "what produced this entity?" */
export function useSourceLinks(
  entityId: string,
  entityType: EntityType,
  linkType?: LinkType,
  options?: Omit<UseQueryOptions<EntityLink[]>, "queryKey" | "queryFn">
) {
  return useLinksWithDirection(
    entityId,
    entityType,
    "source",
    linkType,
    options
  );
}

/** Links where this entity is the source — "what did this entity produce?" */
export function useTargetLinks(
  entityId: string,
  entityType: EntityType,
  linkType?: LinkType,
  options?: Omit<UseQueryOptions<EntityLink[]>, "queryKey" | "queryFn">
) {
  return useLinksWithDirection(
    entityId,
    entityType,
    "target",
    linkType,
    options
  );
}

function useLinksWithDirection(
  entityId: string,
  entityType: EntityType,
  direction: "source" | "target",
  linkType?: LinkType,
  options?: Omit<UseQueryOptions<EntityLink[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: entityLinkKeys.list({
      entityId,
      entityType,
      direction,
      linkType,
    }),
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("entityId", entityId);
      params.set("entityType", entityType);
      params.set("direction", direction);
      if (linkType) {
        params.set("linkType", linkType);
      }
      return apiClient.get<EntityLink[]>(`/entity-links?${params.toString()}`);
    },
    enabled: !!entityId,
    ...options,
  });
}

// Mutations
export function useCreateEntityLink() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: CreateEntityLinkInput) =>
      apiClient.post<EntityLink>("/entity-links", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: entityLinkKeys.lists() });
    },
  });
}

export function useDeleteEntityLink() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<{ deleted: true }>(`/entity-links/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: entityLinkKeys.all });
    },
  });
}
