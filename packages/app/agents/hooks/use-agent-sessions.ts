"use client";

import type {
  AgentSessionAnalytics,
  AgentSessionDetail,
  AgentSessionListResponse,
  AgentSessionsPageData,
  AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import type {
  AgentSessionQueryFilters,
  AgentSessionUsageQueryFilters,
} from "../data-source/agent-sessions-data-source";
import { useAgentSessionsDataSource } from "../data-source/provider";

export type {
  AgentSessionQueryFilters,
  AgentSessionUsageQueryFilters,
} from "../data-source/agent-sessions-data-source";

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
  // FEA-4157: the combined list + usage read (mirrors `branchesKeys.pageData`).
  // Scoped after the prefix like the other filter-based reads, so the unscoped
  // `pageDataRoot` prefix still matches every scope for invalidation.
  pageDataRoot: () => [...agentSessionKeys.all, "page-data"] as const,
  pageData: (scope: string, filters: Record<string, unknown>) =>
    [...agentSessionKeys.pageDataRoot(), scope, filters] as const,
  details: () => [...agentSessionKeys.all, "detail"] as const,
  detail: (scope: string, id: string) =>
    [...agentSessionKeys.details(), scope, id] as const,
  // Transcript reads (FEA-2717) carry no source scope: transcript bytes always
  // live in S3 and are read through the authenticated cloud route regardless of
  // which list/detail source a surface injects, so one cache is shared across
  // web and authenticated desktop. The parsed-file key folds in `rawSha256` so a
  // re-upload (new archive identity) invalidates the parsed entry automatically.
  transcripts: () => [...agentSessionKeys.all, "transcript"] as const,
  transcriptAccess: (id: string) =>
    [...agentSessionKeys.transcripts(), "access", id] as const,
  transcriptFile: (id: string, fileKey: string, rawSha256: string) =>
    [
      ...agentSessionKeys.transcripts(),
      "file",
      id,
      fileKey,
      rawSha256,
    ] as const,
};

export function useAgentSessionUsage(
  filters: AgentSessionUsageQueryFilters = {},
  options?: Omit<
    UseQueryOptions<AgentSessionUsageSummary>,
    "queryKey" | "queryFn"
  >
) {
  const dataSource = useAgentSessionsDataSource();

  return useQuery({
    ...options,
    queryKey: agentSessionKeys.usage(dataSource.scope, filters),
    queryFn: () => dataSource.usage(filters),
    enabled: isAgentSessionQueryEnabled(filters) && (options?.enabled ?? true),
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
    ...options,
    queryKey: agentSessionKeys.list(dataSource.scope, filters),
    queryFn: () => dataSource.list(filters),
    enabled: isAgentSessionQueryEnabled(filters) && (options?.enabled ?? true),
  });
}

/**
 * Combined list + usage read (FEA-4157). Both surfaces mount the Sessions table
 * and its prop-driven summary cards together, so this is one query — one
 * underlying `pageData` read — instead of the table and the cards each issuing
 * an independent fetch that redundantly scans the same rows. Mirrors
 * `useBranchesPageData`: a stable scope+filters `queryKey` shares/reuses the
 * cache across navigation, and callers pass the Branches caching affordances
 * (`placeholderData`/`keepPreviousData`, `staleTime`/`gcTime`) so a filter or
 * time-range change shows last-good instead of a spinner. `useAgentSessions`
 * (list-only) stays for surfaces that render the list without the summary cards.
 *
 * ISS-6041: takes the USAGE filter shape, so a host that renders the summary
 * cards can ask this one read for the ISS-5809 period-over-period comparison
 * exactly as `useAgentSessionUsage` does. The opt-in rides the `queryKey` like
 * every other filter, so a surface that starts (or stops) asking for it never
 * serves the other shape from cache.
 */
export function useAgentSessionsPageData(
  filters: AgentSessionUsageQueryFilters = {},
  options?: Omit<UseQueryOptions<AgentSessionsPageData>, "queryKey" | "queryFn">
) {
  const dataSource = useAgentSessionsDataSource();

  return useQuery({
    ...options,
    queryKey: agentSessionKeys.pageData(dataSource.scope, filters),
    queryFn: () => dataSource.pageData(filters),
    enabled: isAgentSessionQueryEnabled(filters) && (options?.enabled ?? true),
  });
}

export function useAgentSessionDetail(
  id: string,
  options?: Omit<UseQueryOptions<AgentSessionDetail>, "queryKey" | "queryFn">
) {
  const dataSource = useAgentSessionsDataSource();

  return useQuery({
    ...options,
    queryKey: agentSessionKeys.detail(dataSource.scope, id),
    queryFn: () => dataSource.detail(id),
    enabled: Boolean(id) && (options?.enabled ?? true),
  });
}

export function useAgentSessionAnalytics(
  filters: AgentSessionQueryFilters = {},
  options?: Omit<UseQueryOptions<AgentSessionAnalytics>, "queryKey" | "queryFn">
) {
  const dataSource = useAgentSessionsDataSource();

  return useQuery({
    ...options,
    queryKey: agentSessionKeys.analytics(dataSource.scope, filters),
    queryFn: () => dataSource.analytics(filters),
    enabled: isAgentSessionQueryEnabled(filters) && (options?.enabled ?? true),
  });
}

function isAgentSessionQueryEnabled(
  filters: AgentSessionQueryFilters
): boolean {
  return !(
    filters.viewerScope === AgentSessionViewerScope.Team && !filters.teamId
  );
}
