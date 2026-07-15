"use client";

import type { Loop, StoredLoopEvent } from "@repo/api/src/types/loop";
import { LoopStatus } from "@repo/api/src/types/loop";
import { loopKeys } from "@repo/app/loops/hooks/loop-keys";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import {
  type UseQueryOptions,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";

const POLL_INTERVAL_MS = 3000;

// Server-side cap on a single keyset delta page (see
// `listLoopEventsSinceQueryValidator` in apps/api). We request this explicitly
// so a full page (`length === EVENTS_PAGE_SIZE`) unambiguously means "more may
// remain", letting us drain every backlog page in one poll.
const EVENTS_PAGE_SIZE = 500;

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
 * The first poll fetches the loop's full event history; subsequent polls send a
 * keyset cursor (the newest event's `storedAt`) and fetch only the delta, so an
 * active loop's poll no longer re-ships its entire, ever-growing event stream
 * every cycle. When the client is more than one page behind, each poll drains
 * every backlog page before returning, so no trailing events are lost when
 * polling stops. Stops polling when the loop reaches a terminal state and
 * invalidates the loop query cache.
 */
export function useLoopPolling(
  loopId: string | null,
  options?: {
    enabled?: boolean;
  } & Omit<
    UseQueryOptions<StoredLoopEvent[]>,
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

  // Poll events while loop is active.
  // Accumulate the full history client-side: seed from a one-time full fetch,
  // then request only events at/after the newest one we hold (keyset cursor).
  const eventsQuery = useQuery<StoredLoopEvent[]>({
    queryKey: loopKeys.events(loopId ?? ""),
    queryFn: async () => {
      const cached =
        queryClient.getQueryData<StoredLoopEvent[]>(
          loopKeys.events(loopId ?? "")
        ) ?? [];

      // The newest event is the composite (storedAt, id) keyset cursor; the
      // accumulated array stays ordered by it.
      let cursor = cached.at(-1);
      if (!cursor) {
        return apiClient.get<StoredLoopEvent[]>(`/loops/${loopId}/events`);
      }

      // Strict keyset: the server returns only events after the cursor and never
      // re-sends a held row, so each delta appends directly. Each request is
      // capped at EVENTS_PAGE_SIZE, so when the client is more than one page
      // behind (hidden tab, SSE fallback, terminal catch-up) a single fetch only
      // drains one page. Keep fetching subsequent pages until a short page is
      // returned so no trailing events — including the terminal event — are
      // dropped once polling stops. Returning the same reference when nothing is
      // new avoids a needless re-render.
      const accumulated = [...cached];
      let appended = false;
      while (cursor) {
        const page: StoredLoopEvent[] = await apiClient.get<StoredLoopEvent[]>(
          `/loops/${loopId}/events?since=${encodeURIComponent(
            cursor.storedAt
          )}&sinceId=${encodeURIComponent(cursor.id)}&limit=${EVENTS_PAGE_SIZE}`
        );
        if (page.length === 0) {
          break;
        }
        accumulated.push(...page);
        appended = true;
        // A short page means the server had no more rows after it — fully drained.
        if (page.length < EVENTS_PAGE_SIZE) {
          break;
        }
        cursor = page.at(-1);
      }
      return appended ? accumulated : cached;
    },
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
    loopTokensInput: loopQuery.data?.tokensInput ?? 0,
    loopTokensOutput: loopQuery.data?.tokensOutput ?? 0,
    isLoading: eventsQuery.isLoading,
    error: eventsQuery.error,
  };
}
