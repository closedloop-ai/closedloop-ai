"use client";

import type {
  AgentSessionAnalytics,
  AgentSessionDetail,
  AgentSessionListResponse,
  AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import type { AgentSessionQueryFilters } from "../data-source/agent-sessions-data-source";
import { useAgentSessionsDataSource } from "../data-source/provider";

export type { AgentSessionQueryFilters } from "../data-source/agent-sessions-data-source";

/**
 * The filter-based reads (`list`/`usage`/`analytics`) carry a `scope` segment —
 * the active data source's identity — between the read-type prefix and the
 * filters. This isolates one source's cache entries from another's so a surface
 * that swaps sources (desktop local DB ↔ authenticated backend) never serves
 * stale cross-source rows for the same filters. The scope sits *after* the
 * prefix, so the unscoped prefixes (`lists`/`usages`/`analyticsRoot`) still
 * match every scope for invalidation. Detail also carries the source scope:
 * local and cloud detail projections can diverge during sync/version-skew
 * windows, so a source switch must never render a same-id stale detail row.
 */
export const agentSessionKeys = {
  all: ["agent-sessions"] as const,
  usages: () => [...agentSessionKeys.all, "usage"] as const,
  usage: (scope: string, filters: Record<string, unknown>) =>
    [...agentSessionKeys.usages(), scope, filters] as const,
  analyticsRoot: () => [...agentSessionKeys.all, "analytics"] as const,
  analytics: (scope: string, filters: Record<string, unknown>) =>
    [...agentSessionKeys.analyticsRoot(), scope, filters] as const,
  lists: () => [...agentSessionKeys.all, "list"] as const,
  list: (scope: string, filters: Record<string, unknown>) =>
    [...agentSessionKeys.lists(), scope, filters] as const,
  details: () => [...agentSessionKeys.all, "detail"] as const,
  detail: (scope: string, id: string) =>
    [...agentSessionKeys.details(), scope, id] as const,
};

export function useAgentSessionUsage(
  filters: AgentSessionQueryFilters = {},
  options?: Omit<
    UseQueryOptions<AgentSessionUsageSummary>,
    "queryKey" | "queryFn"
  >
) {
  const dataSource = useAgentSessionsDataSource();

  return useQuery({
    queryKey: agentSessionKeys.usage(dataSource.scope, filters),
    queryFn: () => dataSource.usage(filters),
    ...options,
  });
}

export function useAgentSessions(
  filters: AgentSessionQueryFilters = {},
  options?: Omit<
    UseQueryOptions<AgentSessionListResponse>,
    "queryKey" | "queryFn"
  >
) {
  const dataSource = useAgentSessionsDataSource();

  return useQuery({
    queryKey: agentSessionKeys.list(dataSource.scope, filters),
    queryFn: () => dataSource.list(filters),
    ...options,
  });
}

export function useAgentSessionDetail(
  id: string,
  options?: Omit<UseQueryOptions<AgentSessionDetail>, "queryKey" | "queryFn">
) {
  const dataSource = useAgentSessionsDataSource();

  return useQuery({
    queryKey: agentSessionKeys.detail(dataSource.scope, id),
    queryFn: () => dataSource.detail(id),
    enabled: Boolean(id),
    ...options,
  });
}

export function useAgentSessionAnalytics(
  filters: AgentSessionQueryFilters = {},
  options?: Omit<UseQueryOptions<AgentSessionAnalytics>, "queryKey" | "queryFn">
) {
  const dataSource = useAgentSessionsDataSource();

  return useQuery({
    queryKey: agentSessionKeys.analytics(dataSource.scope, filters),
    queryFn: () => dataSource.analytics(filters),
    ...options,
  });
}
