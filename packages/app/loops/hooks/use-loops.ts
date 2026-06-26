"use client";

import type {
  CreateLoopResponse,
  InheritedAdditionalRepos,
  LoopCommand,
  LoopDetail,
  LoopEventsFilters,
  LoopEventsPaginatedResponse,
  LoopListFilters,
  LoopSummariesResponse,
  LoopUsageSummary,
  LoopWithUser,
  ResumeLoopRequest,
} from "@repo/api/src/types/loop";
import { LOOP_SUMMARIES_MAX_DOCUMENT_IDS } from "@repo/api/src/types/loop";
import { documentKeys } from "@repo/app/documents/hooks/document-keys";
import { loopKeys } from "@repo/app/loops/hooks/loop-keys";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { buildSearchParams } from "@repo/app/shared/lib/format-utils";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";

// Queries
export function useLoops(
  filters: LoopListFilters,
  options?: Omit<UseQueryOptions<LoopWithUser[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: loopKeys.list(filters),
    queryFn: () => {
      const params = buildSearchParams(filters);
      return apiClient.get<LoopWithUser[]>(`/loops?${params.toString()}`);
    },
    ...options,
  });
}

export function useLoop(
  id: string,
  options?: Omit<UseQueryOptions<LoopDetail>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: loopKeys.detail(id),
    queryFn: () => apiClient.get<LoopDetail>(`/loops/${id}`),
    enabled: !!id,
    ...options,
  });
}

export function useLoopEventsPaginated(
  loopId: string,
  filters: LoopEventsFilters = {},
  options?: Omit<
    UseQueryOptions<LoopEventsPaginatedResponse>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: loopKeys.eventsPaginated(loopId, filters),
    queryFn: () => {
      const params = buildSearchParams(filters);
      return apiClient.get<LoopEventsPaginatedResponse>(
        `/loops/${loopId}/events?${params.toString()}`
      );
    },
    enabled: !!loopId,
    ...options,
  });
}

/**
 * Resolve the peer-repo set the UI should pre-fill when the user is about
 * to launch `targetCommand` against `documentId`. The precedence chain
 * (which prior loop's `additionalRepos` to inherit from, in order) is
 * dispatched server-side in `loopsService.findInheritedAdditionalRepos`
 * based on the target command.
 *
 * This is the single code path for any UI pre-seeding of additionalRepos.
 * Call it once per modal/editor with the command the user is about to
 * launch and the source document; the response payload is `{ additionalRepos,
 * source }` where `source` is `null` when nothing inheritable was found.
 */
export function useInheritedAdditionalRepos(
  documentId: string | null | undefined,
  targetCommand: LoopCommand,
  options?: Omit<
    UseQueryOptions<InheritedAdditionalRepos>,
    "queryKey" | "queryFn"
  >
) {
  const apiClient = useApiClient();
  return useQuery({
    queryKey: documentKeys.inheritedAdditionalRepos(
      documentId ?? "",
      targetCommand
    ),
    queryFn: () =>
      apiClient.get<InheritedAdditionalRepos>(
        `/documents/${documentId}/inherited-additional-repos?command=${encodeURIComponent(targetCommand)}`
      ),
    enabled: !!documentId,
    ...options,
  });
}

/**
 * Thin wrapper around `useInheritedAdditionalRepos` that returns the
 * `{ initialAdditionalRepos, isLoadingInitialAdditionalRepos }` shape used
 * by the execute-plan modal and plan editor's regenerate flow. Pass the
 * command the user is about to launch (e.g. `LoopCommand.Plan` for
 * regenerate, `LoopCommand.Execute` for execute) so the backend selects
 * the right inheritance chain.
 */
export function useInitialAdditionalRepos(
  documentId: string | null | undefined,
  targetCommand: LoopCommand
) {
  const enabled = Boolean(documentId);
  const { data, isLoading } = useInheritedAdditionalRepos(
    documentId,
    targetCommand,
    { enabled }
  );
  return {
    initialAdditionalRepos: data?.additionalRepos,
    isLoadingInitialAdditionalRepos: enabled && isLoading,
  };
}

export type LoopUsageFilters = {
  startDate?: string;
  endDate?: string;
  command?: string;
};

export function useLoopUsage(
  filters: LoopUsageFilters = {},
  options?: Omit<UseQueryOptions<LoopUsageSummary>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: loopKeys.usage(filters),
    queryFn: () => {
      const qs = buildSearchParams(filters).toString();
      return apiClient.get<LoopUsageSummary>(
        `/loops/usage${qs ? `?${qs}` : ""}`
      );
    },
    ...options,
  });
}

export function useLoopsByProject(
  projectId: string,
  options?: Omit<UseQueryOptions<LoopWithUser[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: loopKeys.list({ projectId }),
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("projectId", projectId);
      params.set("limit", "200");
      return apiClient.get<LoopWithUser[]>(`/loops?${params.toString()}`);
    },
    enabled: !!projectId,
    ...options,
  });
}

// Mutations
export function useResumeLoop() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    meta: { suppressDefaultErrorToast: true },
    mutationFn: ({ id, ...body }: ResumeLoopRequest & { id: string }) =>
      apiClient.post<CreateLoopResponse>(`/loops/${id}/resume`, body),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: loopKeys.detail(id) });
      queryClient.invalidateQueries({ queryKey: loopKeys.lists() });
    },
  });
}

/**
 * Fetch loop summaries for a set of documents. Returns one summary per requested
 * documentId, aggregating loop activity across the document's PRODUCES descendants.
 * Powers the LoopCell variants in My Tasks and Team View.
 *
 * Chunks requests above the server-side limit so callers passing unbounded
 * document lists (e.g., entire project tables) don't get a blank Loop column.
 *
 * Polls every 10s when any cell currently shows an active loop; otherwise
 * idles to ~60s to avoid thrashing the DB on tabs with no in-flight work.
 */
const ACTIVE_POLL_MS = 10_000;
const IDLE_POLL_MS = 60_000;

function chunkIds<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

function summariesHaveActiveLoop(response: LoopSummariesResponse): boolean {
  for (const summary of Object.values(response)) {
    if (summary.activeLoop) {
      return true;
    }
  }
  return false;
}

export function useLoopSummaries(
  documentIds: string[],
  options?: Omit<UseQueryOptions<LoopSummariesResponse>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();
  // Sort once so two parents that pass the same set in different orders
  // share a cache entry. React Query handles structural equality on the array.
  const sortedIds = useMemo(() => [...documentIds].sort(), [documentIds]);
  return useQuery({
    ...options,
    queryKey: loopKeys.summaries(sortedIds),
    queryFn: async () => {
      const batches = chunkIds(sortedIds, LOOP_SUMMARIES_MAX_DOCUMENT_IDS);
      const responses = await Promise.all(
        batches.map((ids) =>
          apiClient.post<LoopSummariesResponse>("/loops/summaries", {
            documentIds: ids,
          })
        )
      );
      return Object.assign({}, ...responses) as LoopSummariesResponse;
    },
    enabled: sortedIds.length > 0 && options?.enabled !== false,
    refetchInterval: (query) => {
      const explicit = options?.refetchInterval;
      if (explicit !== undefined) {
        return typeof explicit === "function" ? explicit(query) : explicit;
      }
      const data = query.state.data;
      return data && summariesHaveActiveLoop(data)
        ? ACTIVE_POLL_MS
        : IDLE_POLL_MS;
    },
    staleTime: options?.staleTime ?? 5000,
  });
}
