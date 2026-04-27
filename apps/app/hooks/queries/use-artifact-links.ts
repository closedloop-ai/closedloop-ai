"use client";

import {
  type ArtifactLink,
  type ArtifactLinkWithEndpoints,
  ArtifactType,
  type BatchMoveArtifactsInput,
  type BatchMoveArtifactsResult,
  type CreateArtifactLinkInput,
  LinkDirection,
  LinkQueryMode,
  type LinkType,
} from "@repo/api/src/types/artifact";
import { getRoutePrefixForType } from "@repo/api/src/types/document";
import {
  type UseQueryOptions,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useApiClient } from "@/hooks/use-api-client";
import { dashboardKeys } from "./use-dashboard-stats";
import { documentKeys } from "./use-documents";
import { projectTreeKeys } from "./use-project-tree";
import { projectKeys } from "./use-projects";

// Query keys
export const artifactLinkKeys = {
  all: ["artifact-links"] as const,
  lists: () => [...artifactLinkKeys.all, "list"] as const,
  list: (filters: Record<string, unknown>) =>
    [...artifactLinkKeys.lists(), filters] as const,
};

// Queries

/** All links (both directions) for an artifact. */
export function useArtifactLinks(
  artifactId: string,
  options?: Omit<UseQueryOptions<ArtifactLink[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: artifactLinkKeys.list({ artifactId, direction: "both" }),
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("artifactId", artifactId);
      params.set("direction", "both");
      return apiClient.get<ArtifactLink[]>(
        `/artifact-links?${params.toString()}`
      );
    },
    enabled: !!artifactId,
    ...options,
  });
}

/** All links in the transitive closure (link tree) from an artifact. */
export function useArtifactLinkTree(
  artifactId: string,
  options?: Omit<UseQueryOptions<ArtifactLink[]>, "queryKey" | "queryFn"> & {
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
    queryKey: artifactLinkKeys.list({
      artifactId,
      direction,
      linkType,
      mode: LinkQueryMode.Tree,
      maxDepth,
    }),
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("artifactId", artifactId);
      params.set("direction", direction);
      params.set("mode", LinkQueryMode.Tree);
      if (linkType) {
        params.set("linkType", linkType);
      }
      if (maxDepth !== undefined) {
        params.set("maxDepth", String(maxDepth));
      }
      return apiClient.get<ArtifactLink[]>(
        `/artifact-links?${params.toString()}`
      );
    },
    enabled: !!artifactId,
    staleTime: 5 * 60 * 1000,
    ...queryOptions,
  });
}

/** All links for an artifact with both source and target endpoints resolved. */
export function useResolvedArtifactLinks(
  artifactId: string,
  options?: Omit<
    UseQueryOptions<ArtifactLinkWithEndpoints[]>,
    "queryKey" | "queryFn"
  > & {
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
    queryKey: artifactLinkKeys.list({
      artifactId,
      direction,
      linkType,
      mode,
      maxDepth,
      resolved: true,
    }),
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("artifactId", artifactId);
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
      return apiClient.get<ArtifactLinkWithEndpoints[]>(
        `/artifact-links/resolved?${params.toString()}`
      );
    },
    enabled: !!artifactId,
    staleTime: 5 * 60 * 1000,
    ...queryOptions,
  });
}

/**
 * Resolves the linked implementation plan artifact ID for a feature.
 * Follows the Feature → ArtifactLink(PRODUCES) → Document lookup chain via
 * the resolved endpoint. The resolved link's target endpoint describes the
 * linked artifact (type + slug), which lets callers narrow to a Document.
 */
export function useLinkedPlanId(
  featureId: string,
  options?: Omit<
    UseQueryOptions<ArtifactLinkWithEndpoints[]>,
    "queryKey" | "queryFn"
  >
) {
  const { data: resolvedLinks = [] } = useResolvedArtifactLinks(featureId, {
    direction: LinkDirection.Target,
    ...options,
  });

  const linkedPlanLink =
    resolvedLinks.find(
      (link) =>
        link.sourceId === featureId &&
        link.target.type === ArtifactType.Document
    ) ?? null;

  return {
    resolvedLinks,
    linkedPlanLink,
    linkedPlanId: linkedPlanLink?.targetId ?? null,
  };
}

// Mutations
export function useCreateArtifactLink() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: CreateArtifactLinkInput) =>
      apiClient.post<ArtifactLink>("/artifact-links", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: artifactLinkKeys.lists() });
      queryClient.invalidateQueries({ queryKey: projectTreeKeys.all });
    },
  });
}

export function useDeleteArtifactLink() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<{ deleted: true }>(`/artifact-links/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: artifactLinkKeys.all });
      queryClient.invalidateQueries({ queryKey: projectTreeKeys.all });
    },
  });
}

export function useBatchMoveArtifacts() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: BatchMoveArtifactsInput) =>
      apiClient.post<BatchMoveArtifactsResult>(
        "/artifact-links/batch-move",
        input
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: documentKeys.all });
      queryClient.invalidateQueries({ queryKey: artifactLinkKeys.all });
      queryClient.invalidateQueries({ queryKey: projectKeys.all });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.all });
      queryClient.invalidateQueries({ queryKey: projectTreeKeys.all });
    },
  });
}

/**
 * Invalidate only the resolved artifact-link list queries whose cached data
 * references the given artifact as either source or target endpoint.
 *
 * Usage:
 *   const queryClient = useQueryClient();
 *   invalidateArtifactLinkQueries(queryClient, editedArtifactId);
 */
export function invalidateArtifactLinkQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  artifactId: string
) {
  queryClient.invalidateQueries({
    queryKey: artifactLinkKeys.lists(),
    predicate: (query) => {
      if (query.queryKey.length !== 3) {
        return false;
      }
      const [, , filters] = query.queryKey as ReturnType<
        typeof artifactLinkKeys.list
      >;
      if (!filters.resolved) {
        return false;
      }
      const data = query.state.data as ArtifactLinkWithEndpoints[];
      if (!Array.isArray(data)) {
        return false;
      }
      return data.some(
        (link) => link.sourceId === artifactId || link.targetId === artifactId
      );
    },
  });

  // Artifact link changes affect the project tree hierarchy
  queryClient.invalidateQueries({ queryKey: projectTreeKeys.all });
}

type ParentFallbackItem = {
  id: string;
};

/**
 * For items missing a parent in the tree, queries resolved artifact-links to
 * find the nearest parent (document or feature) and returns a map of child ID
 * → parent info.
 */
export function useParentFallbackMap(items: ParentFallbackItem[]) {
  const apiClient = useApiClient();

  return useQueries({
    queries: items.map((item) => ({
      queryKey: artifactLinkKeys.list({
        artifactId: item.id,
        direction: LinkDirection.Source,
        mode: LinkQueryMode.Direct,
        resolved: true,
        parentFallback: true,
      }),
      queryFn: () => {
        const params = new URLSearchParams();
        params.set("artifactId", item.id);
        params.set("direction", LinkDirection.Source);
        params.set("mode", LinkQueryMode.Direct);
        return apiClient.get<ArtifactLinkWithEndpoints[]>(
          `/artifact-links/resolved?${params.toString()}`
        );
      },
    })),
    combine: (results) => {
      const map = new Map<string, { title: string; href: string | null }>();
      for (const [index, query] of results.entries()) {
        const item = items[index];
        if (!(item && query.data?.length)) {
          continue;
        }
        const parentLink = query.data.find(
          (link) =>
            link.targetId === item.id &&
            link.source.type === ArtifactType.Document
        );
        if (!parentLink) {
          continue;
        }
        map.set(item.id, {
          title: parentLink.source.name,
          href: resolveParentHref(parentLink),
        });
      }
      return map;
    },
  });
}

function resolveParentHref(link: ArtifactLinkWithEndpoints): string | null {
  const parent = link.source;
  if (parent.type !== ArtifactType.Document || !parent.subtype) {
    return null;
  }
  const routePrefix = getRoutePrefixForType(parent.subtype);
  if (!(routePrefix && parent.slug)) {
    return null;
  }
  return `/${routePrefix}/${parent.slug}`;
}
