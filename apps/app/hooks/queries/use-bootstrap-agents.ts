"use client";

import type { Loop } from "@repo/api/src/types/loop";
import { LoopStatus } from "@repo/api/src/types/loop";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { useApiClient } from "@/hooks/use-api-client";
import { agentKeys } from "./use-agents";
import { loopKeys } from "./use-loops";

// --- Public types ---

export const BootstrapStatus = {
  Idle: "idle",
  Creating: "creating",
  Dispatched: "dispatched",
  Running: "running",
  Completed: "completed",
  Error: "error",
} as const;
export type BootstrapStatus =
  (typeof BootstrapStatus)[keyof typeof BootstrapStatus];

export type BootstrapState =
  | { status: typeof BootstrapStatus.Idle }
  | { status: typeof BootstrapStatus.Creating }
  | { status: typeof BootstrapStatus.Dispatched; loopId: string }
  | { status: typeof BootstrapStatus.Running; loopId: string }
  | { status: typeof BootstrapStatus.Completed; loopId: string }
  | { status: typeof BootstrapStatus.Error; error: string; loopId?: string };

// --- Constants ---

const POLL_INTERVAL_MS = 3000;

const TERMINAL_STATUSES = new Set<LoopStatus>([
  LoopStatus.Completed,
  LoopStatus.Failed,
  LoopStatus.Cancelled,
  LoopStatus.TimedOut,
]);

// --- Hook ---

export function useBootstrapAgents() {
  const [state, setState] = useState<BootstrapState>({
    status: BootstrapStatus.Idle,
  });
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  const loopId = "loopId" in state ? state.loopId : null;
  const isPollingActive =
    state.status === BootstrapStatus.Dispatched ||
    state.status === BootstrapStatus.Running;

  const loopQuery = useQuery({
    queryKey: loopKeys.detail(loopId ?? ""),
    queryFn: () => apiClient.get<Loop>(`/loops/${loopId}`),
    enabled: !!loopId && isPollingActive,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status && TERMINAL_STATUSES.has(status)) {
        return false;
      }
      return POLL_INTERVAL_MS;
    },
  });

  const loopData = loopQuery.data;
  useEffect(() => {
    if (!(loopData && loopId)) {
      return;
    }

    if (
      loopData.status === LoopStatus.Running &&
      state.status === BootstrapStatus.Dispatched
    ) {
      setState({ status: BootstrapStatus.Running, loopId });
    }

    if (
      (loopData.status === LoopStatus.Failed ||
        loopData.status === LoopStatus.Cancelled ||
        loopData.status === LoopStatus.TimedOut) &&
      state.status !== BootstrapStatus.Error
    ) {
      const message =
        loopData.error?.message ?? `Bootstrap ${loopData.status.toLowerCase()}`;
      setState({ status: BootstrapStatus.Error, error: message, loopId });
    }

    if (
      loopData.status === LoopStatus.Completed &&
      state.status !== BootstrapStatus.Completed
    ) {
      queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
      setState({ status: BootstrapStatus.Completed, loopId });
    }
  }, [loopData, loopId, state.status, queryClient]);

  const dispatch = useCallback(
    (repos: Array<{ fullName: string }>) => {
      setState({ status: BootstrapStatus.Creating });

      apiClient
        .post<{ loopId: string }>("/agents/bootstrap/start", {
          repos,
        })
        .then((data) => {
          setState({
            status: BootstrapStatus.Dispatched,
            loopId: data.loopId,
          });
        })
        .catch((err) => {
          setState({
            status: BootstrapStatus.Error,
            error:
              err instanceof Error ? err.message : "Failed to start bootstrap",
          });
        });
    },
    [apiClient]
  );

  const reset = useCallback(() => {
    setState({ status: BootstrapStatus.Idle });
  }, []);

  return { state, dispatch, reset };
}
