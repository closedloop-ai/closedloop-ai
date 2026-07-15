"use client";

import type { AgentComponentDetail } from "@repo/api/src/types/agent-component";
import { useQuery } from "@tanstack/react-query";
import { useAgentComponentsDataSource } from "../data-source/provider";
import {
  type AgentComponentsQueryIdentity,
  agentComponentKeys,
} from "./use-agent-components";

/**
 * Detail hook for the Agents workspace component inventory slice (FEA-2923 / T-2.2).
 *
 * Calls `dataSource.detail(slug)` which rejects with an `ApiError` (status 404)
 * when the slug is not found — it never resolves null. The query is wrapped with
 * `throwOnError: false` so a 404 surfaces as `isError: true` (and `error` on the
 * result) rather than propagating to the nearest React error boundary.
 *
 * Sessions and Branches tab data (AC-002) are delivered as `data.sessionsTab` and
 * `data.branchesTab` on the resolved `AgentComponentDetail`. In Phase 1 the stub
 * source populates these with empty arrays; the HTTP source will pass through
 * whatever the server returns.
 *
 * Usage:
 *   const { data, isLoading, isError, error } = useAgentComponentDetail(slug);
 */
export function useAgentComponentDetail(
  slug: string,
  identity?: AgentComponentsQueryIdentity
) {
  const dataSource = useAgentComponentsDataSource();

  return useQuery<AgentComponentDetail, Error>({
    queryKey: agentComponentKeys.detail(dataSource.scope, slug, identity),
    queryFn: () => dataSource.detail(slug),
    enabled: Boolean(slug),
    throwOnError: false,
  });
}
