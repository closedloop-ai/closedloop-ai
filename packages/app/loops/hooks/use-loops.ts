"use client";

import type {
  CreateLoopResponse,
  InheritedAdditionalRepos,
  LoopCommand,
  LoopDetail,
  LoopEventsFilters,
  LoopEventsPaginatedResponse,
  LoopListFilters,
  LoopUsageSummary,
  LoopWithUser,
  ResumeLoopRequest,
} from "@repo/api/src/types/loop";
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
