"use client";

import { CURRENT_DESKTOP_API_NAMESPACE } from "@repo/api/src/desktop-api-namespace";
import type {
  AdditionalRepoRef,
  CreateLoopRequest,
  CreateLoopResponse,
  Loop,
  LoopEvent,
  LoopEventsFilters,
  LoopEventsPaginatedResponse,
  LoopListFilters,
  LoopUsageSummary,
  LoopWithUser,
  ResumeLoopRequest,
} from "@repo/api/src/types/loop";
import { LoopCommand, RunLoopCommand } from "@repo/api/src/types/loop";
import {
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { judgesKeys } from "@/hooks/queries/use-judges";
import { useApiClient } from "@/hooks/use-api-client";
import { resolveDesktopApiNamespaceHint } from "@/lib/engineer/local-gateway-api-namespace";
import { buildSearchParams } from "@/lib/format-utils";

// Query keys
export const loopKeys = {
  all: ["loops"] as const,
  lists: () => [...loopKeys.all, "list"] as const,
  list: (filters: Record<string, unknown>) =>
    [...loopKeys.lists(), filters] as const,
  details: () => [...loopKeys.all, "detail"] as const,
  detail: (id: string) => [...loopKeys.details(), id] as const,
  events: (id: string) => [...loopKeys.detail(id), "events"] as const,
  eventsPaginated: (id: string, filters: Record<string, unknown>) =>
    [...loopKeys.detail(id), "events-paginated", filters] as const,
  usage: (filters: Record<string, unknown>) =>
    [...loopKeys.all, "usage", filters] as const,
};

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
  options?: Omit<UseQueryOptions<LoopWithUser>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: loopKeys.detail(id),
    queryFn: () => apiClient.get<LoopWithUser>(`/loops/${id}`),
    enabled: !!id,
    ...options,
  });
}

export function useLoopEvents(
  loopId: string,
  options?: Omit<UseQueryOptions<LoopEvent[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: loopKeys.events(loopId),
    queryFn: () => apiClient.get<LoopEvent[]>(`/loops/${loopId}/events`),
    enabled: !!loopId,
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

export function useLoopsByArtifact(
  documentId: string,
  options?: Omit<UseQueryOptions<LoopWithUser[]>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();

  return useQuery({
    queryKey: loopKeys.list({ documentId }),
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("documentId", documentId);
      return apiClient.get<LoopWithUser[]>(`/loops?${params.toString()}`);
    },
    enabled: !!documentId,
    ...options,
  });
}

/**
 * Fetches the most recent PLAN loop for a document.
 *
 * Used to hydrate context (e.g., additionalRepos) from the last plan run,
 * ignoring intervening non-PLAN loops (EVALUATE_PLAN, EXECUTE, etc.) that
 * intentionally omit plan-specific state.
 *
 * Server-side ordering is `createdAt desc`, so the first element is the
 * latest PLAN loop.
 */
export function useLatestPlanLoopByDocument(
  documentId: string,
  options?: Omit<UseQueryOptions<LoopWithUser | null>, "queryKey" | "queryFn">
) {
  const apiClient = useApiClient();
  const filters = { documentId, command: LoopCommand.Plan, limit: 1 };

  return useQuery({
    queryKey: loopKeys.list(filters),
    queryFn: async () => {
      const params = buildSearchParams(filters);
      const loops = await apiClient.get<LoopWithUser[]>(
        `/loops?${params.toString()}`
      );
      return loops[0] ?? null;
    },
    enabled: !!documentId,
    ...options,
  });
}

export function useInitialAdditionalRepos(
  documentId: string | null | undefined
) {
  const enabled = Boolean(documentId);
  const { data: loop, isLoading } = useLatestPlanLoopByDocument(
    documentId ?? "",
    { enabled }
  );
  return {
    initialAdditionalRepos: loop?.additionalRepos ?? undefined,
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
export function useCreateLoop() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (input: CreateLoopRequest) =>
      apiClient.post<CreateLoopResponse>("/loops", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: loopKeys.lists() });
    },
  });
}

export function useCancelLoop() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: (id: string) => apiClient.delete<Loop>(`/loops/${id}`),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: loopKeys.detail(id) });
      queryClient.invalidateQueries({ queryKey: loopKeys.lists() });
    },
  });
}

export function useResumeLoop() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: ({ id, ...body }: ResumeLoopRequest & { id: string }) =>
      apiClient.post<CreateLoopResponse>(`/loops/${id}/resume`, body),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: loopKeys.detail(id) });
      queryClient.invalidateQueries({ queryKey: loopKeys.lists() });
    },
  });
}

/**
 * Run a Loop from an artifact action (plan, execute, request_changes).
 * Posts to the artifact-scoped run-loop endpoint which creates a Loop
 * and launches it on ECS.
 */
export function useRunLoop() {
  const queryClient = useQueryClient();
  const apiClient = useApiClient();

  return useMutation({
    mutationFn: async ({
      documentId,
      command,
      prompt,
      computeTargetId,
      backendOverride,
      repo,
      additionalRepos,
    }: {
      documentId: string;
      command: RunLoopCommand;
      prompt?: string;
      computeTargetId?: string | null;
      backendOverride?: boolean;
      repo?: CreateLoopRequest["repo"];
      additionalRepos?: AdditionalRepoRef[];
    }) => {
      const desktopApiNamespace = await resolveDesktopApiNamespaceHint();

      return apiClient.post<CreateLoopResponse>(
        `/documents/${documentId}/run-loop`,
        {
          command,
          prompt,
          ...(computeTargetId !== undefined ? { computeTargetId } : {}),
          ...(backendOverride ? { backendOverride } : {}),
          ...(repo ? { repo } : {}),
          ...(additionalRepos ? { additionalRepos } : {}),
          ...(desktopApiNamespace &&
          desktopApiNamespace !== CURRENT_DESKTOP_API_NAMESPACE
            ? { desktopApiNamespace }
            : {}),
        }
      );
    },
    onSuccess: (_, { documentId, command }) => {
      queryClient.invalidateQueries({ queryKey: loopKeys.lists() });
      queryClient.invalidateQueries({
        queryKey: loopKeys.list({ documentId }),
      });
      // Also invalidate artifact generation status so the UI reflects the pending loop
      queryClient.invalidateQueries({
        queryKey: ["documents", "detail", documentId, "generation-status"],
      });
      if (command === RunLoopCommand.EvaluatePlan) {
        queryClient.invalidateQueries({
          queryKey: judgesKeys.detail(documentId),
        });
      }
      if (command === RunLoopCommand.EvaluateCode) {
        queryClient.invalidateQueries({
          queryKey: judgesKeys.codeDetail(documentId),
        });
      }
    },
  });
}
