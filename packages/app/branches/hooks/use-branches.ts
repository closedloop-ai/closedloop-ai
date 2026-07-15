"use client";

import type {
  BranchAnalytics,
  BranchListResponse,
  BranchPageDetail,
  BranchPrCommentsResponse,
  BranchUsageSummary,
  MergedTraceItem,
} from "@repo/api/src/types/branch";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import type { BranchQueryFilters } from "../data-source/branches-data-source";
import { useBranchesDataSource } from "../data-source/provider";
import { consumeBranchQueryForceRefresh } from "./branch-force-refresh";

export type { BranchQueryFilters } from "../data-source/branches-data-source";

export type BranchesQueryIdentity = {
  /** Caller-owned cache segment, such as the hosted web org identity. */
  cacheScope?: string;
};

/**
 * The filter-based reads (`list`/`usage`/`analytics`) carry a `scope` segment —
 * the active data source's identity — between the read-type prefix and the
 * filters. This isolates one source's cache entries from another's; callers can
 * add a `cacheScope` segment for surface-local identities such as hosted web
 * orgs, preventing cross-org stale reads while preserving desktop defaults.
 * The scoped segments sit *after* the prefix, so unscoped prefixes still match
 * every scope for invalidation.
 */
export const branchesKeys = {
  all: ["branches"] as const,
  lists: () => [...branchesKeys.all, "list"] as const,
  list: (
    scope: string,
    filters: Record<string, unknown>,
    identity?: BranchesQueryIdentity
  ) => [...branchesKeys.lists(), scope, cacheScope(identity), filters] as const,
  details: () => [...branchesKeys.all, "detail"] as const,
  detail: (scope: string, id: string, identity?: BranchesQueryIdentity) =>
    [...branchesKeys.details(), scope, cacheScope(identity), id] as const,
  commentsRoot: () => [...branchesKeys.all, "comments"] as const,
  comments: (scope: string, id: string, identity?: BranchesQueryIdentity) =>
    [...branchesKeys.commentsRoot(), scope, cacheScope(identity), id] as const,
  traces: () => [...branchesKeys.all, "trace"] as const,
  trace: (scope: string, id: string, identity?: BranchesQueryIdentity) =>
    [...branchesKeys.traces(), scope, cacheScope(identity), id] as const,
  usages: () => [...branchesKeys.all, "usage"] as const,
  usage: (
    scope: string,
    filters: Record<string, unknown>,
    identity?: BranchesQueryIdentity
  ) =>
    [...branchesKeys.usages(), scope, cacheScope(identity), filters] as const,
  analyticsRoot: () => [...branchesKeys.all, "analytics"] as const,
  analytics: (
    scope: string,
    filters: Record<string, unknown>,
    identity?: BranchesQueryIdentity
  ) =>
    [
      ...branchesKeys.analyticsRoot(),
      scope,
      cacheScope(identity),
      filters,
    ] as const,
};

export function useBranches(
  filters: BranchQueryFilters = {},
  options?: Omit<UseQueryOptions<BranchListResponse>, "queryKey" | "queryFn">,
  identity?: BranchesQueryIdentity
) {
  const dataSource = useBranchesDataSource();
  const queryKey = branchesKeys.list(dataSource.scope, filters, identity);

  return useQuery({
    queryKey,
    queryFn: () => dataSource.list(listOptionsForQuery(filters, queryKey)),
    ...options,
  });
}

export function useBranchDetail(
  id: string,
  options?: Omit<UseQueryOptions<BranchPageDetail>, "queryKey" | "queryFn">,
  identity?: BranchesQueryIdentity
) {
  const dataSource = useBranchesDataSource();
  const queryKey = branchesKeys.detail(dataSource.scope, id, identity);

  return useQuery({
    queryKey,
    queryFn: () => {
      const readOptions = detailOptionsForQuery(queryKey);
      return readOptions
        ? dataSource.detail(id, readOptions)
        : dataSource.detail(id);
    },
    enabled: Boolean(id),
    ...options,
  });
}

export function useBranchComments(
  id: string,
  options?: Omit<
    UseQueryOptions<BranchPrCommentsResponse>,
    "queryKey" | "queryFn"
  >,
  identity?: BranchesQueryIdentity
) {
  const dataSource = useBranchesDataSource();

  return useQuery({
    queryKey: branchesKeys.comments(dataSource.scope, id, identity),
    queryFn: () => dataSource.comments(id),
    enabled: Boolean(id),
    ...options,
  });
}

/**
 * The branch's events-heavy merged trace (PLN-1148 Phase 2) — split out of
 * `useBranchDetail` so the detail page paints without it and the trace loads only
 * when the Sessions & timeline tab mounts (Radix unmounts inactive tab content,
 * so a caller that lives inside the tab gets the lazy fetch for free). The port's
 * `trace` is best-effort (resolves `[]`, never rejects), so this query does not
 * surface an error state to the timeline.
 */
export function useBranchTrace(
  id: string,
  options?: Omit<
    UseQueryOptions<readonly MergedTraceItem[]>,
    "queryKey" | "queryFn"
  >,
  identity?: BranchesQueryIdentity
) {
  const dataSource = useBranchesDataSource();

  return useQuery({
    queryKey: branchesKeys.trace(dataSource.scope, id, identity),
    queryFn: () => dataSource.trace(id),
    enabled: Boolean(id),
    ...options,
  });
}

export function useBranchUsage(
  filters: BranchQueryFilters = {},
  options?: Omit<UseQueryOptions<BranchUsageSummary>, "queryKey" | "queryFn">,
  identity?: BranchesQueryIdentity
) {
  const dataSource = useBranchesDataSource();

  return useQuery({
    queryKey: branchesKeys.usage(dataSource.scope, filters, identity),
    queryFn: () => dataSource.usage(filters),
    ...options,
  });
}

export function useBranchAnalytics(
  filters: BranchQueryFilters = {},
  options?: Omit<UseQueryOptions<BranchAnalytics>, "queryKey" | "queryFn">,
  identity?: BranchesQueryIdentity
) {
  const dataSource = useBranchesDataSource();

  return useQuery({
    queryKey: branchesKeys.analytics(dataSource.scope, filters, identity),
    queryFn: () => dataSource.analytics(filters),
    ...options,
  });
}

function cacheScope(identity?: BranchesQueryIdentity): string {
  return identity?.cacheScope ?? "default";
}

function listOptionsForQuery(
  filters: BranchQueryFilters,
  queryKey: readonly unknown[]
): BranchQueryFilters & { forceRefresh?: boolean } {
  if (!consumeBranchQueryForceRefresh(queryKey)) {
    return filters;
  }
  return { ...filters, forceRefresh: true };
}

function detailOptionsForQuery(
  queryKey: readonly unknown[]
): { forceRefresh: true } | undefined {
  return consumeBranchQueryForceRefresh(queryKey)
    ? { forceRefresh: true }
    : undefined;
}
