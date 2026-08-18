"use client";

import type {
  BranchAnalytics,
  BranchesPageData,
  BranchListResponse,
  BranchPageDetail,
  BranchPrCommentsResponse,
} from "@repo/api/src/types/branch";
import type {
  BranchAnalyticsCohortRequest,
  BranchAnalyticsCohortResponse,
} from "@repo/api/src/types/branch-analytics-cohort";
import type { BranchSelectedPullRequestQuery } from "@repo/api/src/types/branch-associated-pull-request";
import type { BranchTraceResult } from "@repo/api/src/types/branch-trace";
import type { BranchUsageSummary } from "@repo/api/src/types/branch-usage";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import type {
  BranchDetailOptions,
  BranchesDataSource,
  BranchQueryFilters,
} from "../data-source/branches-data-source";
import {
  useBranchesDataSource,
  useBranchesQueryContext,
} from "../data-source/provider";
import { consumeBranchQueryForceRefresh } from "./branch-force-refresh";
import {
  type BranchesQueryIdentity,
  branchQueryCacheScope,
  branchRowQueryKeys,
} from "./branch-query-keys";

export type { BranchQueryFilters } from "../data-source/branches-data-source";
export type { BranchesQueryIdentity } from "./branch-query-keys";

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
  all: branchRowQueryKeys.all,
  lists: () => branchRowQueryKeys.lists,
  list: (
    scope: string,
    filters: Record<string, unknown>,
    identity?: BranchesQueryIdentity
  ) =>
    [
      ...branchesKeys.lists(),
      scope,
      branchQueryCacheScope(identity),
      filters,
    ] as const,
  details: () => branchRowQueryKeys.details,
  detail: (
    scope: string,
    id: string,
    identity?: BranchesQueryIdentity,
    selection?: BranchSelectedPullRequestQuery
  ) =>
    [
      ...branchesKeys.details(),
      scope,
      branchQueryCacheScope(identity),
      id,
      selectedPullRequestKey(selection),
    ] as const,
  commentsRoot: () => [...branchesKeys.all, "comments"] as const,
  comments: (
    scope: string,
    id: string,
    identity?: BranchesQueryIdentity,
    selection?: BranchSelectedPullRequestQuery
  ) =>
    [
      ...branchesKeys.commentsRoot(),
      scope,
      branchQueryCacheScope(identity),
      id,
      selectedPullRequestKey(selection),
    ] as const,
  traces: () => [...branchesKeys.all, "trace"] as const,
  trace: (scope: string, id: string, identity?: BranchesQueryIdentity) =>
    [
      ...branchesKeys.traces(),
      scope,
      branchQueryCacheScope(identity),
      id,
    ] as const,
  usages: () => [...branchesKeys.all, "usage"] as const,
  usage: (
    scope: string,
    filters: Record<string, unknown>,
    identity?: BranchesQueryIdentity
  ) =>
    [
      ...branchesKeys.usages(),
      scope,
      branchQueryCacheScope(identity),
      filters,
    ] as const,
  analyticsRoot: () => [...branchesKeys.all, "analytics"] as const,
  analytics: (
    scope: string,
    filters: Record<string, unknown>,
    identity?: BranchesQueryIdentity
  ) =>
    [
      ...branchesKeys.analyticsRoot(),
      scope,
      branchQueryCacheScope(identity),
      filters,
    ] as const,
  cohortAnalyticsRoot: () => [...branchesKeys.all, "cohort-analytics"] as const,
  cohortAnalytics: (
    scope: string,
    request: BranchAnalyticsCohortRequest | null,
    identity?: BranchesQueryIdentity
  ) =>
    [
      ...branchesKeys.cohortAnalyticsRoot(),
      scope,
      branchQueryCacheScope(identity),
      request,
    ] as const,
  pageDataRoot: () => branchRowQueryKeys.pageData,
  pageData: (
    scope: string,
    filters: Record<string, unknown>,
    identity?: BranchesQueryIdentity
  ) =>
    [
      ...branchesKeys.pageDataRoot(),
      scope,
      branchQueryCacheScope(identity),
      filters,
    ] as const,
};

/**
 * List-only branch read for screens that need branch identity metadata without
 * mounting the Branches table analytics. Use the combined page-data hook when a
 * surface renders both the list and summary cards together.
 */
export function useBranchList(
  filters: BranchQueryFilters = {},
  options?: Omit<UseQueryOptions<BranchListResponse>, "queryKey" | "queryFn">,
  identity?: BranchesQueryIdentity
) {
  const dataSource = useBranchesDataSource();
  const queryContext = useBranchesQueryContext(identity);
  const queryKey = branchesKeys.list(
    dataSource.scope,
    filters,
    queryContext.queryIdentity
  );

  return useQuery(
    {
      ...queryContext.queryPolicy,
      queryKey,
      queryFn: () => dataSource.list(listOptionsForQuery(filters, queryKey)),
      ...options,
    },
    queryContext.queryClient
  );
}

/**
 * Combined list + analytics read (FEA-3056 follow-up). Both surfaces mount
 * the Branches list and its summary cards together, so this is the only list
 * read: one query, one underlying `pageData` read, instead of two independent
 * fetches that redundantly scan the same rows. There is no standalone list-only
 * hook — add one back only if a screen genuinely needs the list without
 * analytics.
 */
export function useBranchesPageData(
  filters: BranchQueryFilters = {},
  options?: Omit<UseQueryOptions<BranchesPageData>, "queryKey" | "queryFn">,
  identity?: BranchesQueryIdentity
) {
  const dataSource = useBranchesDataSource();
  const queryContext = useBranchesQueryContext(identity);
  const queryKey = branchesKeys.pageData(
    dataSource.scope,
    filters,
    queryContext.queryIdentity
  );
  const placeholderData = identitySafePageDataPlaceholder(
    options?.placeholderData,
    queryKey
  );

  return useQuery(
    {
      ...queryContext.queryPolicy,
      queryKey,
      queryFn: () =>
        dataSource.pageData(listOptionsForQuery(filters, queryKey)),
      refetchInterval: pollIntervalFor(
        dataSource,
        BRANCHES_LIST_REFETCH_INTERVAL_MS
      ),
      ...options,
      placeholderData,
    },
    queryContext.queryClient
  );
}

export function useBranchDetail(
  id: string,
  options?: Omit<UseQueryOptions<BranchPageDetail>, "queryKey" | "queryFn">,
  identity?: BranchesQueryIdentity,
  selection?: BranchSelectedPullRequestQuery
) {
  const dataSource = useBranchesDataSource();
  const queryContext = useBranchesQueryContext(identity);
  const queryKey = branchesKeys.detail(
    dataSource.scope,
    id,
    queryContext.queryIdentity,
    selection
  );

  return useQuery(
    {
      ...queryContext.queryPolicy,
      queryKey,
      queryFn: () => {
        const readOptions = detailOptionsForQuery(queryKey, selection);
        return readOptions
          ? dataSource.detail(id, readOptions)
          : dataSource.detail(id);
      },
      enabled: Boolean(id),
      refetchInterval: pollIntervalFor(
        dataSource,
        BRANCH_DETAIL_REFETCH_INTERVAL_MS
      ),
      ...options,
    },
    queryContext.queryClient
  );
}

export function useBranchComments(
  id: string,
  options?: Omit<
    UseQueryOptions<BranchPrCommentsResponse>,
    "queryKey" | "queryFn"
  >,
  identity?: BranchesQueryIdentity,
  selection?: BranchSelectedPullRequestQuery
) {
  const dataSource = useBranchesDataSource();
  const queryContext = useBranchesQueryContext(identity);

  return useQuery(
    {
      ...queryContext.queryPolicy,
      queryKey: branchesKeys.comments(
        dataSource.scope,
        id,
        queryContext.queryIdentity,
        selection
      ),
      queryFn: () =>
        selection
          ? dataSource.comments(id, selection)
          : dataSource.comments(id),
      enabled: Boolean(id),
      ...options,
    },
    queryContext.queryClient
  );
}

/**
 * The branch's events-heavy merged trace (PLN-1148 Phase 2) — split out of
 * `useBranchDetail` so the detail page paints without it and the trace loads only
 * when the Sessions & timeline tab mounts (Radix unmounts inactive tab content,
 * so a caller that lives inside the tab gets the lazy fetch for free). The port's
 * completed Session/page failures are represented inside the typed result;
 * request cancellation remains a real query lifecycle outcome.
 */
export function useBranchTrace(
  id: string,
  options?: Omit<UseQueryOptions<BranchTraceResult>, "queryKey" | "queryFn">,
  identity?: BranchesQueryIdentity
) {
  const dataSource = useBranchesDataSource();
  const queryContext = useBranchesQueryContext(identity);

  return useQuery(
    {
      ...queryContext.queryPolicy,
      queryKey: branchesKeys.trace(
        dataSource.scope,
        id,
        queryContext.queryIdentity
      ),
      queryFn: ({ signal }) => dataSource.trace(id, { signal }),
      enabled: Boolean(id),
      ...options,
    },
    queryContext.queryClient
  );
}

export function useBranchUsage(
  filters: BranchQueryFilters = {},
  options?: Omit<UseQueryOptions<BranchUsageSummary>, "queryKey" | "queryFn">,
  identity?: BranchesQueryIdentity
) {
  const dataSource = useBranchesDataSource();
  const queryContext = useBranchesQueryContext(identity);

  return useQuery(
    {
      ...queryContext.queryPolicy,
      queryKey: branchesKeys.usage(
        dataSource.scope,
        filters,
        queryContext.queryIdentity
      ),
      queryFn: () => dataSource.usage(filters),
      ...options,
    },
    queryContext.queryClient
  );
}

export function useBranchAnalytics(
  filters: BranchQueryFilters = {},
  options?: Omit<UseQueryOptions<BranchAnalytics>, "queryKey" | "queryFn">,
  identity?: BranchesQueryIdentity
) {
  const dataSource = useBranchesDataSource();
  const queryContext = useBranchesQueryContext(identity);

  return useQuery(
    {
      ...queryContext.queryPolicy,
      queryKey: branchesKeys.analytics(
        dataSource.scope,
        filters,
        queryContext.queryIdentity
      ),
      queryFn: () => dataSource.analytics(filters),
      ...options,
    },
    queryContext.queryClient
  );
}

/** Read canonical metrics for one exact, already-filtered Branch cohort. */
export function useBranchCohortAnalytics(
  request: BranchAnalyticsCohortRequest | null,
  options?: Omit<
    UseQueryOptions<BranchAnalyticsCohortResponse | null>,
    "queryKey" | "queryFn"
  >,
  identity?: BranchesQueryIdentity
) {
  const dataSource = useBranchesDataSource();
  const queryContext = useBranchesQueryContext(identity);
  const enabled = request !== null && options?.enabled !== false;

  return useQuery(
    {
      ...queryContext.queryPolicy,
      queryKey: branchesKeys.cohortAnalytics(
        dataSource.scope,
        request,
        queryContext.queryIdentity
      ),
      queryFn: () =>
        request ? (dataSource.cohortAnalytics?.(request) ?? null) : null,
      ...options,
      enabled,
    },
    queryContext.queryClient
  );
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
  queryKey: readonly unknown[],
  selection?: BranchSelectedPullRequestQuery
): BranchDetailOptions | undefined {
  const forceRefresh = consumeBranchQueryForceRefresh(queryKey);
  if (!(selection || forceRefresh)) {
    return undefined;
  }
  return {
    ...selection,
    ...(forceRefresh ? { forceRefresh: true } : {}),
  };
}

function selectedPullRequestKey(selection?: BranchSelectedPullRequestQuery) {
  if (
    selection?.repositoryFullName === undefined ||
    selection.pullRequestNumber === undefined
  ) {
    return null;
  }
  return {
    repositoryFullName: selection.repositoryFullName,
    pullRequestNumber: selection.pullRequestNumber,
  };
}

/**
 * Preserve previous rows only while the source and authenticated cache owner
 * stay the same. TanStack observers survive query-key changes, so an
 * unrestricted `keepPreviousData` would otherwise expose identity A while an
 * identity-B query is pending or paused.
 */
function identitySafePageDataPlaceholder(
  placeholderData: UseQueryOptions<BranchesPageData>["placeholderData"],
  queryKey: readonly unknown[]
): UseQueryOptions<BranchesPageData>["placeholderData"] {
  if (typeof placeholderData !== "function") {
    return placeholderData;
  }
  return (previousData, previousQuery) => {
    if (
      !(
        previousQuery &&
        hasSameBranchQueryOwner(previousQuery.queryKey, queryKey)
      )
    ) {
      return undefined;
    }
    return placeholderData(previousData, previousQuery);
  };
}

function hasSameBranchQueryOwner(
  previousQueryKey: readonly unknown[],
  queryKey: readonly unknown[]
): boolean {
  return (
    previousQueryKey[0] === queryKey[0] &&
    previousQueryKey[1] === queryKey[1] &&
    previousQueryKey[2] === queryKey[2] &&
    previousQueryKey[3] === queryKey[3]
  );
}

/**
 * PLN-1535 M3.3 — the pull half of the plan's freshness model (D8).
 *
 * The dirty-scope resync nudge rides the relay/compute-target command lane,
 * which is API-key authenticated, so it only ever reached desktops registered
 * as compute targets — never the general population. After M3 a Branches read
 * costs a Postgres query against the projection rather than a live GitHub
 * GraphQL call, so a modest poll is affordable where it never was before, and
 * it covers the case the nudge was supposed to: an idle but FOCUSED window
 * sitting on stale branch data.
 *
 * `refetchIntervalInBackground` is deliberately left at TanStack's `false`
 * default, which is what makes this VISIBLE-tab rather than unconditional: a
 * hidden or backgrounded window must not poll the cloud on a timer. Note this
 * is the opposite choice from the desktop Sessions poll
 * (`sessions-list-poll-defaults.ts`), where background polling is load-bearing
 * because it heals a local live-bridge flush that a permanently-hidden
 * renderer would otherwise defer forever. Different problem, different answer.
 *
 * Both intervals sit in the plan's ~60-90s band and clear the desktop
 * cloud-hydration TTL for their scope, so a poll can actually observe new data
 * instead of re-reading the same cached overlay. Detail is comfortably clear
 * (60s poll over a 30s `DETAIL_TTL_MS`). The list is deliberately 120s rather
 * than the 90s it started at: `LIST_TTL_MS` is ALSO 90s, and TanStack restarts
 * the interval when a fetch settles, so an equal interval only cleared expiry
 * by the previous request's round-trip latency. Losing that race put
 * `hydrate()` down its `cached && expiresAt > now()` branch — the list
 * re-rendering the identical overlay while the user watched a refresh cycle
 * change nothing. A margin measured in milliseconds is not a design.
 *
 * These are DEFAULTS: every hook spreads caller `options` afterwards, so a
 * surface can lengthen, shorten, or disable its own cadence.
 */
const BRANCHES_LIST_REFETCH_INTERVAL_MS = 120_000;
const BRANCH_DETAIL_REFETCH_INTERVAL_MS = 60_000;

/**
 * The poll cadence for one Branches read — or `false` for a source that pushes.
 *
 * A live source (the desktop local DB) implements `subscribe` and is
 * invalidated by its `desktop:db:changed` push through `BranchesLiveBridge`, so
 * a timer would re-read the single db-host worker on a schedule to learn
 * nothing it was not about to be told. It also runs under FEA-3754's
 * `DESKTOP_LOCAL_BRANCH_QUERY_POLICY`, whose `staleTime: Infinity` deliberately
 * freezes that cache — and a `refetchInterval` would quietly override it, since
 * TanStack polls on the interval regardless of staleness. The poll is for the
 * pull-only cloud read, which has no push channel; that is the case D8 is
 * about.
 */
function pollIntervalFor(
  dataSource: BranchesDataSource,
  intervalMs: number
): number | false {
  return dataSource.subscribe ? false : intervalMs;
}
