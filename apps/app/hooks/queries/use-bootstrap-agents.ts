"use client";

import type { BulkIngestAgentResponse } from "@repo/api/src/types/agent";
import type { Loop } from "@repo/api/src/types/loop";
import { LoopStatus } from "@repo/api/src/types/loop";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApiClient } from "@/hooks/use-api-client";
import { agentKeys } from "./use-agents";
import { loopKeys } from "./use-loops";

// --- Bootstrap loop result shape (from uploadedArtifacts) ---

type BootstrapLoopRepoResult = {
  fullName: string;
  success: boolean;
  error?: string;
  agents: Array<{
    name: string;
    slug: string;
    role: string;
    description: string;
    prompt: string;
  }>;
  criticGates: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  duration: number;
};

type BootstrapLoopResult = {
  repos: BootstrapLoopRepoResult[];
  totalDuration: number;
};

// --- Public types ---

export type BootstrapRepoSummary = {
  fullName: string;
  success: boolean;
  error?: string;
  agentCount: number;
};

export type BootstrapIngestResult = {
  repoSummaries: BootstrapRepoSummary[];
  totalCreated: number;
  totalUpdated: number;
};

export const BootstrapStatus = {
  Idle: "idle",
  Creating: "creating",
  Dispatched: "dispatched",
  Running: "running",
  Ingesting: "ingesting",
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
  | { status: typeof BootstrapStatus.Ingesting; loopId: string }
  | {
      status: typeof BootstrapStatus.Completed;
      loopId: string;
      result: BootstrapIngestResult;
    }
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
  const ingestingRef = useRef(false);

  // Derive loopId and polling eligibility from state
  const loopId = "loopId" in state ? state.loopId : null;
  const isPollingActive =
    state.status === BootstrapStatus.Dispatched ||
    state.status === BootstrapStatus.Running;

  // Poll loop detail while active
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

  // React to loop status changes
  const loopData = loopQuery.data;
  useEffect(() => {
    if (!(loopData && loopId)) {
      return;
    }

    // Map LoopStatus → BootstrapStatus
    if (
      loopData.status === LoopStatus.Running &&
      state.status === BootstrapStatus.Dispatched
    ) {
      setState({ status: BootstrapStatus.Running, loopId });
    }

    // Terminal failure states
    if (
      loopData.status === LoopStatus.Failed ||
      loopData.status === LoopStatus.Cancelled ||
      loopData.status === LoopStatus.TimedOut
    ) {
      const message =
        loopData.error?.message ?? `Bootstrap ${loopData.status.toLowerCase()}`;
      setState({ status: BootstrapStatus.Error, error: message, loopId });
    }

    // Completion → trigger ingestion
    if (loopData.status === LoopStatus.Completed && !ingestingRef.current) {
      ingestingRef.current = true;
      setState({ status: BootstrapStatus.Ingesting, loopId });

      const bootstrapResult =
        loopData.uploadedArtifacts as BootstrapLoopResult | null;
      if (!bootstrapResult?.repos) {
        setState({
          status: BootstrapStatus.Error,
          error: "Bootstrap completed but no results found",
          loopId,
        });
        ingestingRef.current = false;
        return;
      }

      ingestResults(bootstrapResult.repos, apiClient, loopId)
        .then((result) => {
          queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
          setState({ status: BootstrapStatus.Completed, loopId, result });
        })
        .catch((err) => {
          setState({
            status: BootstrapStatus.Error,
            error:
              err instanceof Error ? err.message : "Failed to ingest agents",
            loopId,
          });
        })
        .finally(() => {
          ingestingRef.current = false;
        });
    }
  }, [loopData, loopId, state.status, apiClient, queryClient]);

  const dispatch = useCallback(
    (repos: Array<{ fullName: string }>) => {
      ingestingRef.current = false;
      setState({ status: BootstrapStatus.Creating });

      apiClient
        .post<{ loopId: string }>("/agents/bootstrap/start", {
          repos: repos.map((r) => ({ fullName: r.fullName })),
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
    ingestingRef.current = false;
    setState({ status: BootstrapStatus.Idle });
  }, []);

  return { state, dispatch, reset };
}

// --- Ingestion helpers ---

async function ingestRepoAgents(
  repo: BootstrapLoopRepoResult,
  apiClient: ReturnType<typeof useApiClient>,
  loopId: string
): Promise<BootstrapRepoSummary & { created: number; updated: number }> {
  if (!repo.success || repo.agents.length === 0) {
    return {
      fullName: repo.fullName,
      success: repo.success,
      error: repo.error,
      agentCount: 0,
      created: 0,
      updated: 0,
    };
  }

  try {
    const result = await apiClient.post<BulkIngestAgentResponse>(
      "/agents/bulk-ingest",
      {
        agents: repo.agents.map((a) => ({
          name: a.name,
          role: a.role,
          description: a.description ?? undefined,
          prompt: a.prompt,
        })),
        bootstrapRunId: loopId,
        sourceRepo: repo.fullName,
        criticGates: repo.criticGates ?? undefined,
      }
    );

    return {
      fullName: repo.fullName,
      success: true,
      agentCount: result.agents.length,
      created: result.created,
      updated: result.updated,
    };
  } catch (err) {
    return {
      fullName: repo.fullName,
      success: false,
      error: err instanceof Error ? err.message : "Failed to ingest agents",
      agentCount: 0,
      created: 0,
      updated: 0,
    };
  }
}

async function ingestResults(
  repos: BootstrapLoopRepoResult[],
  apiClient: ReturnType<typeof useApiClient>,
  loopId: string
): Promise<BootstrapIngestResult> {
  const summaries: BootstrapRepoSummary[] = [];
  let totalCreated = 0;
  let totalUpdated = 0;

  for (const repo of repos) {
    const result = await ingestRepoAgents(repo, apiClient, loopId);
    totalCreated += result.created;
    totalUpdated += result.updated;
    summaries.push({
      fullName: result.fullName,
      success: result.success,
      error: result.error,
      agentCount: result.agentCount,
    });
  }

  return { repoSummaries: summaries, totalCreated, totalUpdated };
}
