"use client";

import type { Loop } from "@repo/api/src/types/loop";
import { LoopStatus } from "@repo/api/src/types/loop";
// Cross-slice: a bootstrap run is tracked as a loop, so reuse the loops slice's
// query-key factory rather than duplicating it.
import { loopKeys } from "@repo/app/loops/hooks/loop-keys";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApiClient } from "../../shared/api/use-api-client";
import { useAuthSnapshot } from "../../shared/auth/use-auth-snapshot";
import { useLocalStorageState } from "../../shared/hooks/use-local-storage-state";
import { agentKeys } from "./use-agents";

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
const BOOTSTRAP_LOOP_KEY_PREFIX = "agents:bootstrap:activeLoopId";
const MAX_POLL_ERRORS = 3;

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
  const { orgId } = useAuthSnapshot();
  const storageKey = orgId
    ? `${BOOTSTRAP_LOOP_KEY_PREFIX}:${orgId}`
    : BOOTSTRAP_LOOP_KEY_PREFIX;
  const [storedLoopId, setStoredLoopId] = useLocalStorageState<string | null>(
    storageKey,
    null
  );
  const recoveryAttempted = useRef(false);
  const prevStorageKey = useRef(storageKey);
  const pollErrorCount = useRef(0);

  if (prevStorageKey.current !== storageKey) {
    prevStorageKey.current = storageKey;
    recoveryAttempted.current = false;
    pollErrorCount.current = 0;
    setState({ status: BootstrapStatus.Idle });
  }

  useEffect(() => {
    if (
      recoveryAttempted.current ||
      state.status !== BootstrapStatus.Idle ||
      !storedLoopId
    ) {
      return;
    }
    recoveryAttempted.current = true;
    setState({ status: BootstrapStatus.Running, loopId: storedLoopId });
  }, [storedLoopId, state.status]);

  const loopId = "loopId" in state ? state.loopId : null;
  const isPollingActive =
    state.status === BootstrapStatus.Dispatched ||
    state.status === BootstrapStatus.Running;

  const loopQuery = useQuery({
    queryKey: loopKeys.detail(loopId ?? ""),
    queryFn: () => apiClient.get<Loop>(`/loops/${loopId}`),
    enabled: !!loopId && isPollingActive,
    retry: false,
    refetchInterval: (query) => {
      if (query.state.error) {
        if (pollErrorCount.current >= MAX_POLL_ERRORS) {
          return false;
        }
        return POLL_INTERVAL_MS;
      }
      const status = query.state.data?.status;
      if (status && TERMINAL_STATUSES.has(status)) {
        return false;
      }
      return POLL_INTERVAL_MS;
    },
  });

  const loopData = loopQuery.data;
  const loopError = loopQuery.error;

  useEffect(() => {
    if (!(loopError && isPollingActive)) {
      pollErrorCount.current = 0;
      return;
    }
    pollErrorCount.current++;
    if (pollErrorCount.current >= MAX_POLL_ERRORS) {
      setStoredLoopId(null);
      setState({
        status: BootstrapStatus.Error,
        error:
          loopError instanceof Error
            ? loopError.message
            : "Bootstrap loop not found",
        loopId: loopId ?? undefined,
      });
    }
  }, [loopError, isPollingActive, loopId, setStoredLoopId]);

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
      setStoredLoopId(null);
      setState({ status: BootstrapStatus.Error, error: message, loopId });
    }

    if (
      loopData.status === LoopStatus.Completed &&
      state.status !== BootstrapStatus.Completed
    ) {
      setStoredLoopId(null);
      queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
      setState({ status: BootstrapStatus.Completed, loopId });
    }
  }, [loopData, loopId, state.status, queryClient, setStoredLoopId]);

  const dispatch = useCallback(
    (repos: Array<{ fullName: string }>) => {
      setState({ status: BootstrapStatus.Creating });

      apiClient
        .post<{ loopId: string }>("/agents/bootstrap/start", {
          repos,
        })
        .then((data) => {
          setStoredLoopId(data.loopId);
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
    [apiClient, setStoredLoopId]
  );

  const reset = useCallback(() => {
    setStoredLoopId(null);
    setState({ status: BootstrapStatus.Idle });
  }, [setStoredLoopId]);

  return { state, dispatch, reset };
}
