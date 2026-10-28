"use client";

import {
  type ArtifactLink,
  type ArtifactLinkPage,
  type ArtifactLinkWithEndpoints,
  ArtifactType,
  type CreateArtifactLinkInput,
  LinkDirection,
  type LinkQueryMode,
  type LinkType,
} from "@repo/api/src/types/artifact";
import { projectTreeKeys } from "@repo/app/projects/hooks/project-tree-keys";
import type { ApiClient } from "@repo/app/shared/api/create-api-client";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import {
  type UseMutationOptions,
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

// Query keys
export const artifactLinkKeys = {
  all: ["artifact-links"] as const,
  lists: () => [...artifactLinkKeys.all, "list"] as const,
  list: (filters: Record<string, unknown>) =>
    [...artifactLinkKeys.lists(), filters] as const,
};

// Queries

/**
 * All links for an artifact with both source and target endpoints resolved.
 *
 * ISS-10102: `/artifact-links/resolved` is now bounded per response, so this
 * hook FOLLOWS THE PAGES INTERNALLY and still resolves the whole set. That is
 * the deliberate half of the repo's adapter rule — an adapter over a paginated
 * endpoint either exposes the continuation in its own contract or follows it —
 * and following is right here because the surfaces behind this hook
 * (`associated-artifacts-section`, `branches-section`) render
 * a document's complete lineage with no paging affordance of their own. Handing
 * them a cursor would make each one decide, separately, what a partial lineage
 * means; handing them the assembled array keeps them rendering exactly what they
 * rendered before. What they no longer do is receive it in one 446 MB response
 * that kills the function serializing it.
 */
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
      const baseParams = new URLSearchParams();
      baseParams.set("artifactId", artifactId);
      baseParams.set("direction", direction);
      if (linkType) {
        baseParams.set("linkType", linkType);
      }
      if (mode) {
        baseParams.set("mode", mode);
      }
      if (maxDepth !== undefined) {
        baseParams.set("maxDepth", String(maxDepth));
      }
      baseParams.set("paginated", "true");
      return fetchAllResolvedLinkPages(apiClient, baseParams);
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
export function useCreateArtifactLink(
  options?: Pick<
    UseMutationOptions<ArtifactLink, Error, CreateArtifactLinkInput>,
    "onError"
  >
) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: CreateArtifactLinkInput) =>
      apiClient.post<ArtifactLink>("/artifact-links", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: artifactLinkKeys.lists() });
      queryClient.invalidateQueries({ queryKey: projectTreeKeys.all });
    },
    ...options,
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

/**
 * Invalidate the resolved artifact-link list queries that show the given
 * artifact: the view fetched FOR it, plus any other view whose cached rows
 * name it as an endpoint.
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
      // The key names its subject, so a view of THIS artifact matches whether
      // or not it has settled. Matching on cached endpoints alone skipped a
      // view still fetching, whose pre-write response then populated the cache
      // after the mutation and served the old lineage (ISS-9578 review).
      if (filters.artifactId === artifactId) {
        return true;
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

/**
 * Invalidate every artifact-link view, for a write whose subject set the
 * caller cannot enumerate — a batch status change unblocks dependents the
 * receipt never names (ISS-9632), and a batch move re-parents links whose
 * endpoints are not in the request.
 */
export function invalidateAllArtifactLinkQueries(
  queryClient: ReturnType<typeof useQueryClient>
) {
  queryClient.invalidateQueries({ queryKey: artifactLinkKeys.all });
  queryClient.invalidateQueries({ queryKey: projectTreeKeys.all });
}

/**
 * Read every page of `/artifact-links/resolved` and concatenate them.
 *
 * Terminates on an ABSENT `nextCursor`, which is the endpoint's one statement
 * that the traversal is exhausted — a cursor is never serialized as `null`, so
 * `undefined` is the whole test.
 *
 * DEPLOY SKEW IS THE FIRST CASE, not an edge case: `apps/app` and `apps/api`
 * ship independently, and an api build from before ISS-10102 ignores
 * `paginated=true` and answers with the bare array it always did. Reading
 * `.items` off that array yields `undefined` and spreading it throws, so the
 * array shape is normalized to a single terminal page instead — the old
 * behavior, unbounded, which is exactly what that build is still doing.
 *
 * The no-progress guard is not belt-and-braces either: a cursor that failed to
 * advance would re-read the same page forever against a live endpoint, and a
 * loop that cannot end is a worse failure than the one this pagination exists
 * to fix.
 */
async function fetchAllResolvedLinkPages(
  apiClient: ApiClient,
  baseParams: URLSearchParams
): Promise<ArtifactLinkWithEndpoints[]> {
  const all: ArtifactLinkWithEndpoints[] = [];
  let cursor: string | undefined;
  let snapshotId: string | undefined;

  for (;;) {
    const params = new URLSearchParams(baseParams);
    if (cursor !== undefined) {
      params.set("cursor", cursor);
      if (snapshotId !== undefined) {
        params.set("snapshotId", snapshotId);
      }
    }
    const response = await apiClient.get<
      ArtifactLinkPage | ArtifactLinkWithEndpoints[]
    >(`/artifact-links/resolved?${params.toString()}`);
    const page: ArtifactLinkPage = Array.isArray(response)
      ? { items: response }
      : response;
    all.push(...page.items);

    const next = page.nextCursor;
    if (next === undefined || next === cursor) {
      return all;
    }
    cursor = next;
    snapshotId = page.snapshotId;
  }
}
