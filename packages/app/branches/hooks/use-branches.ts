"use client";

import type {
  BranchAnalytics,
  BranchListResponse,
  BranchPageDetail,
  BranchUsageSummary,
} from "@repo/api/src/types/branch";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import type { BranchQueryFilters } from "../data-source/branches-data-source";
import { useBranchesDataSource } from "../data-source/provider";

export type { BranchQueryFilters } from "../data-source/branches-data-source";

/**
 * The filter-based reads (`list`/`usage`/`analytics`) carry a `scope` segment —
 * the active data source's identity — between the read-type prefix and the
 * filters. This isolates one source's cache entries from another's so a surface
 * that swaps sources (desktop local DB ↔ authenticated backend) never serves
 * stale cross-source rows for the same filters. The scope sits *after* the
 * prefix, so the unscoped prefixes (`lists`/`details`/`usages`/`analyticsRoot`)
 * still match every scope for invalidation. Detail also carries the source
 * scope: local and cloud detail projections can diverge during sync/version-skew
 * windows, so a source switch must never render a same-id stale detail row.
 */
export const branchesKeys = {
  all: ["branches"] as const,
  lists: () => [...branchesKeys.all, "list"] as const,
  list: (scope: string, filters: Record<string, unknown>) =>
    [...branchesKeys.lists(), scope, filters] as const,
  details: () => [...branchesKeys.all, "detail"] as const,
  detail: (scope: string, id: string) =>
    [...branchesKeys.details(), scope, id] as const,
  usages: () => [...branchesKeys.all, "usage"] as const,
  usage: (scope: string, filters: Record<string, unknown>) =>
    [...branchesKeys.usages(), scope, filters] as const,
  analyticsRoot: () => [...branchesKeys.all, "analytics"] as const,
  analytics: (scope: string, filters: Record<string, unknown>) =>
    [...branchesKeys.analyticsRoot(), scope, filters] as const,
};

export function useBranches(
  filters: BranchQueryFilters = {},
  options?: Omit<UseQueryOptions<BranchListResponse>, "queryKey" | "queryFn">
) {
  const dataSource = useBranchesDataSource();

  return useQuery({
    queryKey: branchesKeys.list(dataSource.scope, filters),
    queryFn: () => dataSource.list(filters),
    ...options,
  });
}

export function useBranchDetail(
  id: string,
  options?: Omit<UseQueryOptions<BranchPageDetail>, "queryKey" | "queryFn">
) {
  const dataSource = useBranchesDataSource();

  return useQuery({
    queryKey: branchesKeys.detail(dataSource.scope, id),
    queryFn: () => dataSource.detail(id),
    enabled: Boolean(id),
    ...options,
  });
}

export function useBranchUsage(
  filters: BranchQueryFilters = {},
  options?: Omit<UseQueryOptions<BranchUsageSummary>, "queryKey" | "queryFn">
) {
  const dataSource = useBranchesDataSource();

  return useQuery({
    queryKey: branchesKeys.usage(dataSource.scope, filters),
    queryFn: () => dataSource.usage(filters),
    ...options,
  });
}

export function useBranchAnalytics(
  filters: BranchQueryFilters = {},
  options?: Omit<UseQueryOptions<BranchAnalytics>, "queryKey" | "queryFn">
) {
  const dataSource = useBranchesDataSource();

  return useQuery({
    queryKey: branchesKeys.analytics(dataSource.scope, filters),
    queryFn: () => dataSource.analytics(filters),
    ...options,
  });
}
