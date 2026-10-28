"use client";

import type {
  ApplyTagInput,
  BatchApplyTagInput,
  CreateTagInput,
  Tag,
  UpdateTagInput,
} from "@repo/api/src/types/tag";
import {
  type QueryClient,
  QueryClientContext,
  queryOptions,
  skipToken,
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useContext } from "react";
// Generic Artifact tag mutations refresh Branch and Session list/detail data
// because those shared records project the same tag associations. The registry
// is owned by the documents slice (ISS-9578) so every bar refreshes one set.
import { invalidateTagWriteViewFamilies } from "../../documents/hooks/bulk-artifact-invalidation";
import type { ApiClient } from "../../shared/api/create-api-client";
import { useApiClient } from "../../shared/api/use-api-client";
import {
  type MutationToastOptions,
  mutationToastMeta,
} from "../../shared/query/query-client";

export const tagKeys = {
  all: ["tags"] as const,
  lists: () => [...tagKeys.all, "list"] as const,
  list: (filters: Record<string, unknown>) =>
    [...tagKeys.lists(), filters] as const,
  details: () => [...tagKeys.all, "detail"] as const,
  detail: (id: string) => [...tagKeys.details(), id] as const,
};

/**
 * ISS-12452: the row the picker is bound to can be cached in a surface-owned
 * client distinct from the ambient one, as Branches' is on desktop
 * (`useBranchesQueryContext`, `packages/app/branches/data-source/provider.tsx`).
 * Passing it here does NOT move the refresh off the ambient client — see
 * {@link useTagWriteQueryClients}.
 */
type TagMutationQueryClientOption = { queryClient?: QueryClient };

export function useTags(
  options?: Omit<
    UseQueryOptions<Tag[], Error, Tag[], ReturnType<typeof tagKeys.list>>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    ...tagsListQuery(apiClient),
    ...options,
  });
}

export function useCreateTag(options?: Readonly<MutationToastOptions>) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    meta: mutationToastMeta(options),
    mutationFn: (input: CreateTagInput) => apiClient.post<Tag>("/tags", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tagKeys.lists() });
    },
  });
}

export function useUpdateTag(
  options?: Readonly<MutationToastOptions & TagMutationQueryClientOption>
) {
  const { mutationQueryClient, invalidationTargets } = useTagWriteQueryClients(
    options?.queryClient
  );
  const apiClient = useApiClient();

  return useMutation(
    {
      meta: mutationToastMeta(options),
      mutationFn: ({ id, ...input }: UpdateTagInput & { id: string }) =>
        apiClient.patch<Tag>(`/tags/${id}`, input),
      onSuccess: () => {
        invalidateTagLists(invalidationTargets);
        invalidateTagWriteFamilies(invalidationTargets);
      },
    },
    mutationQueryClient
  );
}

export function useDeleteTag(options?: Readonly<MutationToastOptions>) {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    meta: mutationToastMeta(options),
    mutationFn: (id: string) => apiClient.delete(`/tags/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tagKeys.lists() });
      invalidateTagWriteViewFamilies(queryClient);
    },
  });
}

export function useApplyTag(options?: Readonly<TagMutationQueryClientOption>) {
  const { mutationQueryClient, invalidationTargets } = useTagWriteQueryClients(
    options?.queryClient
  );
  const apiClient = useApiClient();

  return useMutation(
    {
      mutationFn: (input: ApplyTagInput) =>
        apiClient.post<{ applied: boolean }>("/entity-tags", input),
      onSuccess: () => {
        invalidateTagWriteFamilies(invalidationTargets);
      },
    },
    mutationQueryClient
  );
}

export function useRemoveTag(options?: Readonly<TagMutationQueryClientOption>) {
  const { mutationQueryClient, invalidationTargets } = useTagWriteQueryClients(
    options?.queryClient
  );
  const apiClient = useApiClient();

  return useMutation(
    {
      mutationFn: (input: ApplyTagInput) => {
        const params = new URLSearchParams({
          tagId: input.tagId,
          entityType: input.entityType,
          entityId: input.entityId,
        });
        if (input.surface !== undefined) {
          params.set("surface", input.surface);
        }
        return apiClient.delete(`/entity-tags?${params.toString()}`);
      },
      onSuccess: () => {
        invalidateTagWriteFamilies(invalidationTargets);
      },
    },
    mutationQueryClient
  );
}

export function useBatchApplyTag() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({ tagId, entityType, entityIds }: BatchApplyTagInput) =>
      apiClient.post<{ appliedCount: number }>("/entity-tags/batch", {
        tagId,
        entityType,
        entityIds,
      }),
    // Ungated, unlike the documents batches: `createManyAndReturn` with
    // `skipDuplicates` reports zero rows written when a concurrent request
    // inserted the tag after this cache was read, so a zero says the server
    // already agrees — never that the screen does (ISS-9578 review). The v1
    // receipt names no ids either, so there is nothing to narrow link views by.
    onSuccess: () => {
      invalidateTagWriteViewFamilies(queryClient);
    },
  });
}

/**
 * The clients a tag write has to refresh (ISS-12452, marisolashgrove review).
 *
 * A tag write moves query families that are NOT all cached in one client: the
 * tag list `useTags` reads, and the Document, Project and Session
 * families in `invalidateTagWriteViewFamilies`, are ambient on every shell,
 * while a Branch row can be cached in a surface-owned client — desktop injects
 * one. So routing the refresh to a single client leaves one side stale either
 * way: the ambient client, and the injected one when it is a distinct
 * instance, are both invalidated. `useArtifactPriorityMutation` can route to
 * one client because it only touches branch keys.
 *
 * `invalidateQueries` is a no-op against a client holding no matching query,
 * so the whole set goes to every target rather than a hand-split per client.
 * The ambient client is read through {@link QueryClientContext} because a
 * caller passing its own must keep working where no provider is mounted.
 */
function useTagWriteQueryClients(injected?: QueryClient): {
  mutationQueryClient: QueryClient;
  invalidationTargets: readonly QueryClient[];
} {
  const ambientQueryClient = useContext(QueryClientContext);
  const mutationQueryClient = useQueryClient(injected);
  const invalidationTargets =
    ambientQueryClient && ambientQueryClient !== mutationQueryClient
      ? [ambientQueryClient, mutationQueryClient]
      : [mutationQueryClient];
  return { mutationQueryClient, invalidationTargets };
}

function invalidateTagLists(clients: readonly QueryClient[]): void {
  for (const client of clients) {
    client.invalidateQueries({ queryKey: tagKeys.lists() });
  }
}

function invalidateTagWriteFamilies(clients: readonly QueryClient[]): void {
  for (const client of clients) {
    invalidateTagWriteViewFamilies(client);
  }
}

/**
 * The organization tag catalog read, for {@link useTags} and for shared
 * machinery that resolves its client through `useApiClientOptional`: with no
 * client the query is skipped rather than failing.
 */
export function tagsListQuery(apiClient: ApiClient | null) {
  return queryOptions({
    queryKey: tagKeys.list({}),
    queryFn: apiClient ? () => apiClient.get<Tag[]>("/tags") : skipToken,
  });
}
