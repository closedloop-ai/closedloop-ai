"use client";

import type { BulkIngestAgentResponse } from "@repo/api/src/types/agent";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { useApiClient } from "@/hooks/use-api-client";
import { agentKeys } from "./use-agents";

type BootstrapRepoResult = {
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

type BootstrapCommandResult = {
  type: "bootstrap:result";
  success: boolean;
  repos: BootstrapRepoResult[];
  totalDuration: number;
};

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
  Running: "running",
  Ingesting: "ingesting",
  Completed: "completed",
  Error: "error",
} as const;
export type BootstrapStatus =
  (typeof BootstrapStatus)[keyof typeof BootstrapStatus];

export type BootstrapState =
  | { status: typeof BootstrapStatus.Idle }
  | { status: typeof BootstrapStatus.Running }
  | { status: typeof BootstrapStatus.Ingesting }
  | {
      status: typeof BootstrapStatus.Completed;
      result: BootstrapIngestResult;
    }
  | { status: typeof BootstrapStatus.Error; error: string };

export function useBootstrapAgents() {
  const [state, setState] = useState<BootstrapState>({
    status: BootstrapStatus.Idle,
  });
  const abortRef = useRef<AbortController | null>(null);
  const apiClient = useApiClient();
  const queryClient = useQueryClient();

  const dispatch = useCallback(
    async (repos: Array<{ fullName: string }>) => {
      abortRef.current?.abort();

      const controller = new AbortController();
      abortRef.current = controller;

      setState({ status: BootstrapStatus.Running });

      const bootstrapResult = await dispatchToGateway(
        repos,
        controller,
        setState
      );
      if (!bootstrapResult) {
        return;
      }

      setState({ status: BootstrapStatus.Ingesting });

      try {
        const result = await ingestResults(bootstrapResult.repos, apiClient);
        queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
        setState({ status: BootstrapStatus.Completed, result });
      } catch (err) {
        setState({
          status: BootstrapStatus.Error,
          error: err instanceof Error ? err.message : "Failed to ingest agents",
        });
      }
    },
    [apiClient, queryClient]
  );

  const reset = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setState({ status: BootstrapStatus.Idle });
  }, []);

  return { state, dispatch, reset };
}

async function dispatchToGateway(
  repos: Array<{ fullName: string }>,
  controller: AbortController,
  setState: (state: BootstrapState) => void
): Promise<BootstrapCommandResult | null> {
  try {
    const response = await fetch("/api/gateway/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "bootstrap",
        repos: repos.map((r) => ({ fullName: r.fullName })),
        options: { depth: "medium" },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(
        (data as { error?: string }).error ??
          `Bootstrap failed (${response.status})`
      );
    }

    return (await response.json()) as BootstrapCommandResult;
  } catch (err) {
    if (controller.signal.aborted) {
      setState({ status: BootstrapStatus.Idle });
    } else {
      setState({
        status: BootstrapStatus.Error,
        error: err instanceof Error ? err.message : "Bootstrap failed",
      });
    }
    return null;
  }
}

async function ingestRepoAgents(
  repo: BootstrapRepoResult,
  apiClient: ReturnType<typeof useApiClient>
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
        bootstrapRunId: crypto.randomUUID(),
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
  repos: BootstrapRepoResult[],
  apiClient: ReturnType<typeof useApiClient>
): Promise<BootstrapIngestResult> {
  const summaries: BootstrapRepoSummary[] = [];
  let totalCreated = 0;
  let totalUpdated = 0;

  for (const repo of repos) {
    const result = await ingestRepoAgents(repo, apiClient);
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
