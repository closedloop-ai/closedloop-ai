"use client";

import {
  type MoveArtifactRequest,
  type MoveArtifactResponse,
  MovePosition,
} from "@repo/api/src/types/project-artifact-move";
import {
  PROJECT_TREE_CATEGORY_PARAM,
  PROJECT_TREE_CHILD_CURSOR_PARAM,
  PROJECT_TREE_CHILD_LIMIT_PARAM,
  PROJECT_TREE_CONTRIBUTOR_USER_ID_PARAM,
  PROJECT_TREE_HIERARCHY_PARAM,
  PROJECT_TREE_HIERARCHY_REVISION_PARAM,
  PROJECT_TREE_INCLUDE_PARAM,
  PROJECT_TREE_LIMIT_PARAM,
  PROJECT_TREE_PARENT_ARTIFACT_ID_PARAM,
  PROJECT_TREE_ROOT_CURSOR_PARAM,
  type ProjectTreeDetailsResponse,
  ProjectTreeInclude,
  type ProjectTreeQueryFilters,
  type ProjectTreeResponse,
  parseProjectTreeDetailsResponse,
  parseProjectTreeResponse,
  TreeTruncationReason,
} from "@repo/api/src/types/project-tree";
import {
  type QueryKey,
  type UseQueryOptions,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useApiClient } from "../../shared/api/use-api-client";
import { currentQueryCacheScope } from "../../shared/query/query-client";

import { projectTreeKeys } from "./project-tree-keys";

const PROJECT_TREE_EXPANSION_MAX_PAGES = 50;

type ProjectTreeHookOptions = Omit<
  UseQueryOptions<ProjectTreeResponse>,
  "queryKey" | "queryFn"
> & {
  filters?: ProjectTreeQueryFilters;
};

export function useProjectTree(
  projectId: string,
  options?: ProjectTreeHookOptions
) {
  const apiClient = useApiClient();
  const { filters, ...queryOptions } = options ?? {};

  return useQuery({
    queryKey: projectTreeKeys.detail(projectId, filters),
    queryFn: async () =>
      parseProjectTreeResponse(
        await apiClient.get<unknown>(projectTreePath(projectId, filters))
      ),
    enabled: !!projectId,
    ...queryOptions,
  });
}

/**
 * Mutation hook backing the project page's stack-rank reorder UI (PRD-421).
 * Calls `POST /projects/:id/artifacts/move`, the single-item primitive used
 * by drag-drop, keyboard reorder, and the row-menu Move-to-top / Move-to-
 * bottom actions.
 *
 * Optimistic update: applies the new root ordering to the cached
 * `ProjectTreeResponse.nodes` array immediately, rolls back if the server
 * rejects the move, and re-fetches `projectTreeKeys.detail(projectId)` on
 * settle so the canonical sortOrder values from the server win. The update
 * targets every cache entry under the project's detail-key prefix, so both
 * the plain tree and the with-details variant reorder together.
 *
 * Children are untouched — stack rank is a root-only concept per PRD-421.
 */
export function useMoveArtifact(projectId: string) {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  return useMutation<
    MoveArtifactResponse,
    Error,
    MoveArtifactRequest,
    {
      previous: [QueryKey, ProjectTreeResponse | undefined][];
      optimistic: [QueryKey, ProjectTreeResponse | undefined][];
      updateCounts: (number | undefined)[];
      scopeAtCall: string;
    }
  >({
    mutationFn: (body) =>
      apiClient.post<MoveArtifactResponse>(
        `/projects/${projectId}/artifacts/move`,
        body
      ),
    onMutate: async (input) => {
      const scopeAtCall = currentQueryCacheScope(queryClient);
      await queryClient.cancelQueries({
        queryKey: projectTreeKeys.detail(projectId),
      });
      if (currentQueryCacheScope(queryClient) !== scopeAtCall) {
        return { previous: [], optimistic: [], updateCounts: [], scopeAtCall };
      }
      const previous = queryClient.getQueriesData<ProjectTreeResponse>({
        queryKey: projectTreeKeys.detail(projectId),
      });
      const optimistic = queryClient.setQueriesData<ProjectTreeResponse>(
        { queryKey: projectTreeKeys.detail(projectId) },
        (old) =>
          old ? { ...old, nodes: applyMoveToTree(old.nodes, input) } : old
      );
      const updateCounts = optimistic.map(
        ([queryKey]) => queryClient.getQueryState(queryKey)?.dataUpdateCount
      );
      return { previous, optimistic, updateCounts, scopeAtCall };
    },
    onError: (_err, _input, context) => {
      if (
        !context ||
        currentQueryCacheScope(queryClient) !== context.scopeAtCall
      ) {
        return;
      }
      for (const [index, [queryKey, data]] of context.previous.entries()) {
        // A newer optimistic update or refetch owns its value; an older
        // rejection must not replace it with this move's earlier snapshot.
        // The count also catches a newer write with structurally shared data.
        if (
          queryClient.getQueryData(queryKey) ===
            context.optimistic[index]?.[1] &&
          queryClient.getQueryState(queryKey)?.dataUpdateCount ===
            context.updateCounts[index]
        ) {
          queryClient.setQueryData(queryKey, data);
        }
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: projectTreeKeys.detail(projectId),
      });
    },
  });
}

/**
 * Pure helper for the optimistic cache update: returns a new nodes array with
 * the moved artifact spliced into the requested slot. Exported for unit tests
 * so the cache logic can be verified without spinning up a QueryClient.
 */
export function applyMoveToTree(
  nodes: ProjectTreeResponse["nodes"],
  input: MoveArtifactRequest
): ProjectTreeResponse["nodes"] {
  const targetIndex = nodes.findIndex((n) => n.root.id === input.artifactId);
  if (targetIndex < 0) {
    return nodes;
  }
  const target = nodes[targetIndex];
  if (!target) {
    return nodes;
  }
  const withoutTarget = nodes.filter((_, i) => i !== targetIndex);

  if (input.position === MovePosition.Top) {
    return [target, ...withoutTarget];
  }
  if (input.position === MovePosition.Bottom) {
    return [...withoutTarget, target];
  }
  if (!input.referenceArtifactId) {
    return nodes;
  }
  const refIndex = withoutTarget.findIndex(
    (n) => n.root.id === input.referenceArtifactId
  );
  if (refIndex < 0) {
    return nodes;
  }
  const insertIndex =
    input.position === MovePosition.Before ? refIndex : refIndex + 1;
  return [
    ...withoutTarget.slice(0, insertIndex),
    target,
    ...withoutTarget.slice(insertIndex),
  ];
}

/**
 * Project tree with artifact-level view details (tags and document versions)
 * enriched onto every node (PLN-874). The project page's documents table
 * renders from this one query instead of pairing `useProjectTree` with a
 * separate `/documents?projectId=` fetch.
 */
export function useProjectTreeWithDetails(
  projectId: string,
  options?: Omit<
    UseQueryOptions<ProjectTreeDetailsResponse>,
    "queryKey" | "queryFn"
  > & {
    filters?: ProjectTreeQueryFilters;
  }
) {
  const apiClient = useApiClient();
  const { filters, ...queryOptions } = options ?? {};

  return useQuery({
    queryKey: projectTreeKeys.withDetails(projectId, filters),
    queryFn: async () =>
      parseProjectTreeDetailsResponse(
        await apiClient.get<unknown>(
          projectTreePath(projectId, filters, ProjectTreeInclude.Details)
        )
      ),
    enabled: !!projectId,
    ...queryOptions,
  });
}

/** Read hierarchy root pages on demand and retain each root-subtree unit. */
export function useProjectTreeRootPages(
  projectId: string,
  options?: {
    enabled?: boolean;
    filters?: ProjectTreeQueryFilters;
  }
) {
  const apiClient = useApiClient();
  const filters = options?.filters;
  const query = useInfiniteQuery({
    queryKey: [
      ...projectTreeKeys.withDetails(projectId, filters),
      "root-pages",
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      parseProjectTreeDetailsResponse(
        await apiClient.get<unknown>(
          projectTreePath(
            projectId,
            {
              ...filters,
              hierarchy: true,
              ...(pageParam && { rootCursor: pageParam }),
            },
            ProjectTreeInclude.Details
          )
        )
      ),
    getNextPageParam: (lastPage) => lastPage.hierarchy?.rootNextCursor,
    enabled: Boolean(projectId) && options?.enabled !== false,
  });
  const data = useMemo(
    () => mergeProjectTreeRootPages(query.data?.pages),
    [query.data?.pages]
  );
  const refetchMerged = useCallback(async () => {
    const result = await query.refetch();
    return mergeProjectTreeRootPages(result.data?.pages);
  }, [query.refetch]);
  const loadMore = useCallback(() => {
    if (query.hasNextPage && !(query.isFetching || query.isError)) {
      query.fetchNextPage({ cancelRefetch: false });
    }
  }, [query.fetchNextPage, query.hasNextPage, query.isError, query.isFetching]);
  return { ...query, data, loadMore, refetchMerged };
}

/** Fetch every cursor page for each expanded parent with incomplete children. */
export function useProjectTreeExpansionBatch(
  projectId: string,
  parentArtifactIds: readonly string[]
) {
  const apiClient = useApiClient();
  return useQueries({
    queries: projectTreeExpansionParentIds(parentArtifactIds).map(
      (parentArtifactId) => ({
        enabled: Boolean(projectId),
        queryFn: () =>
          readAllProjectTreeChildPages(apiClient, projectId, parentArtifactId),
        queryKey: [
          ...projectTreeKeys.withDetails(projectId, {
            hierarchy: true,
            parentArtifactId,
          }),
          "all-child-pages",
        ],
      })
    ),
  });
}

function projectTreePath(
  projectId: string,
  filters?: ProjectTreeQueryFilters,
  include?: ProjectTreeInclude
): string {
  const params = new URLSearchParams();
  if (include) {
    params.set(PROJECT_TREE_INCLUDE_PARAM, include);
  }
  if (filters?.includeHierarchyRevision) {
    params.set(PROJECT_TREE_HIERARCHY_REVISION_PARAM, "true");
  }
  if (filters?.contributorUserId) {
    params.set(
      PROJECT_TREE_CONTRIBUTOR_USER_ID_PARAM,
      filters.contributorUserId
    );
  }
  if (filters?.limit !== undefined) {
    params.set(PROJECT_TREE_LIMIT_PARAM, String(filters.limit));
  }
  if (filters?.category !== undefined) {
    params.set(PROJECT_TREE_CATEGORY_PARAM, filters.category);
  }
  if (filters?.hierarchy === true) {
    params.set(PROJECT_TREE_HIERARCHY_PARAM, "true");
  }
  if (filters?.parentArtifactId !== undefined) {
    params.set(PROJECT_TREE_PARENT_ARTIFACT_ID_PARAM, filters.parentArtifactId);
  }
  if (filters?.childCursor !== undefined) {
    params.set(PROJECT_TREE_CHILD_CURSOR_PARAM, filters.childCursor);
  }
  if (filters?.childLimit !== undefined) {
    params.set(PROJECT_TREE_CHILD_LIMIT_PARAM, String(filters.childLimit));
  }
  if (filters?.rootCursor !== undefined) {
    params.set(PROJECT_TREE_ROOT_CURSOR_PARAM, filters.rootCursor);
  }
  const query = params.toString();
  return query
    ? `/projects/${projectId}/tree?${query}`
    : `/projects/${projectId}/tree`;
}

async function readAllProjectTreeChildPages(
  apiClient: ReturnType<typeof useApiClient>,
  projectId: string,
  parentArtifactId: string
): Promise<ProjectTreeDetailsResponse[]> {
  const pages: ProjectTreeDetailsResponse[] = [];
  const seenCursors = new Set<string>();
  let childCursor: string | undefined;
  for (
    let pageCount = 0;
    pageCount < PROJECT_TREE_EXPANSION_MAX_PAGES;
    pageCount += 1
  ) {
    const page = parseProjectTreeDetailsResponse(
      await apiClient.get<unknown>(
        projectTreePath(
          projectId,
          {
            childCursor,
            hierarchy: true,
            parentArtifactId,
          },
          ProjectTreeInclude.Details
        )
      )
    );
    pages.push(page);
    const nextCursor = page.hierarchy?.nextCursor;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      break;
    }
    seenCursors.add(nextCursor);
    childCursor = nextCursor;
  }
  return pages;
}

function mergeProjectTreeRootPages(
  pages: readonly ProjectTreeDetailsResponse[] | undefined
): ProjectTreeDetailsResponse | undefined {
  const first = pages?.[0];
  const last = pages?.at(-1);
  if (!(first && last)) {
    return undefined;
  }
  const nodes = pages.flatMap((page) => page.nodes);
  const nextCursor = last.hierarchy?.rootNextCursor;
  const reasons = new Set(
    pages.flatMap((page) => page.truncation?.reasons ?? [])
  );
  if (!nextCursor) {
    reasons.delete(TreeTruncationReason.AnchorCap);
  }
  const hierarchy = mergeRootPageHierarchy(pages, nextCursor);
  return {
    ...first,
    nodes,
    externalParents: pages.flatMap((page) => page.externalParents),
    ...(pages.some((page) => page.flatParents)
      ? { flatParents: pages.flatMap((page) => page.flatParents ?? []) }
      : {}),
    ...(hierarchy && { hierarchy }),
    ...(reasons.size > 0
      ? {
          truncation: {
            anchorsIncluded: nodes.length,
            anchorsMatchedAtLeast: nodes.length + (nextCursor ? 1 : 0),
            reasons: [...reasons],
          },
        }
      : { truncation: undefined }),
  };
}

function mergeRootPageHierarchy(
  pages: readonly ProjectTreeDetailsResponse[],
  nextCursor: string | undefined
): ProjectTreeDetailsResponse["hierarchy"] {
  const first = pages[0]?.hierarchy;
  const last = pages.at(-1)?.hierarchy;
  if (!(first && last)) {
    return undefined;
  }
  const { rootNextCursor: _firstCursor, ...firstWithoutCursor } = first;
  const { rootNextCursor: _lastCursor, ...lastWithoutCursor } = last;
  return {
    ...firstWithoutCursor,
    ...lastWithoutCursor,
    diagnostics: pages.flatMap((page) => page.hierarchy?.diagnostics ?? []),
    diagnosticsComplete: pages.every(
      (page) => page.hierarchy?.diagnosticsComplete === true
    ),
    ...(nextCursor && { rootNextCursor: nextCursor }),
  };
}

/** The order {@link useProjectTreeExpansionBatch} returns its queries in. */
export function projectTreeExpansionParentIds(
  parentArtifactIds: readonly string[]
): string[] {
  return [...new Set(parentArtifactIds)].sort();
}
