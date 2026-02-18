"use client";

import type { Loop, LoopEvent } from "@repo/api/src/types/loop";
import { LoopStatus } from "@repo/api/src/types/loop";
import {
  type UseQueryOptions,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useApiClient } from "@/hooks/use-api-client";
import { loopKeys } from "./use-loops";

const POLL_INTERVAL_MS = 3000;

const TERMINAL_STATUSES = new Set<LoopStatus>([
  LoopStatus.Completed,
  LoopStatus.Failed,
  LoopStatus.Cancelled,
  LoopStatus.TimedOut,
]);

/**
 * Fallback polling hook for loop events when SSE is unavailable.
 *
 * Polls GET /api/loops/[id]/events every 3 seconds while the loop is active.
 * Stops polling when the loop reaches a terminal state and invalidates
 * the loop query cache.
 */
export function useLoopPolling(
  loopId: string | null,
  options?: {
    enabled?: boolean;
  } & Omit<
    UseQueryOptions<LoopEvent[]>,
    "queryKey" | "queryFn" | "enabled" | "refetchInterval"
  >
) {
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  const { enabled: enabledOption, ...queryOptions } = options ?? {};
  const enabled = enabledOption !== false && !!loopId;

  // Track whether we've already invalidated for this loop to avoid repeated invalidations
  const hasInvalidatedRef = useRef(false);

  // Poll the loop detail to check status for stopping condition.
  // Once terminal, stop polling — the final state is immutable.
  const loopQuery = useQuery({
    queryKey: loopKeys.detail(loopId ?? ""),
    queryFn: () => apiClient.get<Loop>(`/loops/${loopId}`),
    enabled,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status && TERMINAL_STATUSES.has(status)) {
        return false;
      }
      return POLL_INTERVAL_MS;
    },
  });

  const isTerminal = loopQuery.data
    ? TERMINAL_STATUSES.has(loopQuery.data.status)
    : false;

  // Invalidate caches once when loop reaches terminal state
  useEffect(() => {
    if (isTerminal && loopId && !hasInvalidatedRef.current) {
      hasInvalidatedRef.current = true;
      queryClient.invalidateQueries({ queryKey: loopKeys.detail(loopId) });
      queryClient.invalidateQueries({ queryKey: loopKeys.events(loopId) });
      queryClient.invalidateQueries({ queryKey: loopKeys.lists() });
    }
  }, [isTerminal, loopId, queryClient]);

  // Reset invalidation tracking when loopId changes
  const prevLoopIdRef = useRef(loopId);
  if (prevLoopIdRef.current !== loopId) {
    prevLoopIdRef.current = loopId;
    hasInvalidatedRef.current = false;
  }

  // Poll events while loop is active
  const eventsQuery = useQuery({
    queryKey: loopKeys.events(loopId ?? ""),
    queryFn: () => apiClient.get<LoopEvent[]>(`/loops/${loopId}/events`),
    enabled,
    refetchInterval: isTerminal ? false : POLL_INTERVAL_MS,
    ...queryOptions,
  });

  const events = eventsQuery.data ?? [];
  const lastEvent = events.length > 0 ? (events.at(-1) ?? null) : null;

  return {
    events,
    lastEvent,
    isComplete: isTerminal,
    loopStatus: loopQuery.data?.status ?? null,
    isLoading: eventsQuery.isLoading,
    error: eventsQuery.error,
  };
}
