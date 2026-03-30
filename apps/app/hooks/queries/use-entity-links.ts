"use client";

import {
  type CreateEntityLinkInput,
  type EntityLink,
  EntityType,
  LinkDirection,
  type LinkedEntity,
  LinkQueryMode,
  LinkType,
} from "@repo/api/src/types/entity-link";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";
import { projectTreeKeys } from "./use-project-tree";

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
    LinkDirection.Source,
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
    LinkDirection.Target,
    linkType,
    options
  );
}

function useLinksWithDirection(
  entityId: string,
  entityType: EntityType,
  direction: LinkDirection,
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

/** All links in the transitive closure (link tree) from an entity. */
export function useEntityLinkTree(
  entityId: string,
  entityType: EntityType,
  options?: Omit<UseQueryOptions<EntityLink[]>, "queryKey" | "queryFn"> & {
    direction?: LinkDirection;
    linkType?: LinkType;
    maxDepth?: number;
  }
) {
  const apiClient = useApiClient();
  const {
    direction = LinkDirection.Both,
    linkType,
    maxDepth,
    ...queryOptions
  } = options ?? {};

  return useQuery({
    queryKey: entityLinkKeys.list({
      entityId,
      entityType,
      direction,
      linkType,
      mode: LinkQueryMode.Tree,
      maxDepth,
    }),
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("entityId", entityId);
      params.set("entityType", entityType);
      params.set("direction", direction);
      params.set("mode", LinkQueryMode.Tree);
      if (linkType) {
        params.set("linkType", linkType);
      }
      if (maxDepth !== undefined) {
        params.set("maxDepth", String(maxDepth));
      }
      return apiClient.get<EntityLink[]>(`/entity-links?${params.toString()}`);
    },
    enabled: !!entityId,
    staleTime: 5 * 60 * 1000,
    ...queryOptions,
  });
}

/** All links for an entity with the "other" entity on each link resolved. */
export function useLinkedEntities(
  entityId: string,
  entityType: EntityType,
  options?: Omit<UseQueryOptions<LinkedEntity[]>, "queryKey" | "queryFn"> & {
    direction?: LinkDirection;
    linkType?: LinkType;
    mode?: LinkQueryMode;
    maxDepth?: number;
  }
) {
  const apiClient = useApiClient();
  const {
    direction = LinkDirection.Both,
    linkType,
    mode,
    maxDepth,
    ...queryOptions
  } = options ?? {};

  return useQuery({
    queryKey: entityLinkKeys.list({
      entityId,
      entityType,
      direction,
      linkType,
      mode,
      maxDepth,
      resolved: true,
    }),
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("entityId", entityId);
      params.set("entityType", entityType);
      params.set("direction", direction);
      if (linkType) {
        params.set("linkType", linkType);
      }
      if (mode) {
        params.set("mode", mode);
      }
      if (maxDepth !== undefined) {
        params.set("maxDepth", String(maxDepth));
      }
      return apiClient.get<LinkedEntity[]>(
        `/entity-links/resolved?${params.toString()}`
      );
    },
    enabled: !!entityId,
    staleTime: 5 * 60 * 1000,
    ...queryOptions,
  });
}

/**
 * Resolves the linked implementation plan artifact ID for a feature.
 * Follows the Feature → EntityLink(PRODUCES) → Artifact lookup chain.
 * Returns an empty string when no plan is linked.
 */
export function useLinkedPlanId(
  featureId: string,
  options?: Omit<UseQueryOptions<EntityLink[]>, "queryKey" | "queryFn">
) {
  const { data: targetLinks = [] } = useTargetLinks(
    featureId,
    EntityType.Feature,
    LinkType.Produces,
    options
  );

  const linkedPlanLink = targetLinks.find(
    (link) => link.targetType === EntityType.Artifact
  );

  return {
    targetLinks,
    linkedPlanLink,
    linkedPlanId: linkedPlanLink?.targetId ?? "",
  };
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
      queryClient.invalidateQueries({ queryKey: projectTreeKeys.all });
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
      queryClient.invalidateQueries({ queryKey: projectTreeKeys.all });
    },
  });
}

/**
 * Invalidate only the entity-link list queries whose cached data references
 * the given entity — either as a link endpoint (sourceId / targetId) or as a
 * resolved entity.
 *
 * Usage:
 *   const queryClient = useQueryClient();
 *   invalidateEntityLinkQueries(queryClient, editedEntityId);
 */
export function invalidateEntityLinkQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  entityId: string,
  entityType: EntityType
) {
  queryClient.invalidateQueries({
    queryKey: entityLinkKeys.lists(),
    predicate: (query) => {
      if (query.queryKey.length !== 3) {
        return false;
      }
      const [, , filters] = query.queryKey as ReturnType<
        typeof entityLinkKeys.list
      >;
      if (!filters.resolved) {
        return false;
      }
      const data = query.state.data as LinkedEntity[];
      if (!Array.isArray(data)) {
        return false;
      }
      return data.some(
        (link) =>
          (link.sourceType === entityType && link.sourceId === entityId) ||
          (link.targetType === entityType && link.targetId === entityId)
      );
    },
  });

  // Entity link changes affect the project tree hierarchy
  queryClient.invalidateQueries({ queryKey: projectTreeKeys.all });
}
