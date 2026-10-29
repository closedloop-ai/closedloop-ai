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
import { BranchListPageMode } from "@repo/api/src/types/branch-list-contract";
import type { BranchTraceResult } from "@repo/api/src/types/branch-trace";
import type { BranchUsageSummary } from "@repo/api/src/types/branch-usage";
import {
  type NetworkMode,
  type UseQueryOptions,
  useQuery,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type {
  BranchesDataSource,
  BranchQueryFilters,
} from "../data-source/branches-data-source";
import {
  useBranchesDataSource,
  useBranchesQueryContext,
} from "../data-source/provider";
import {
  analyticsFilters,
  BRANCH_SERVER_ANALYTICS_STAGGER_MS,
} from "../data-source/server-page-data";
import {
  BRANCH_DETAIL_FRESHNESS_MS,
  branchDetailQueryPolicy,
} from "./branch-detail-query-policy";
import {
  type BranchesQueryIdentity,
  branchQueryCacheScope,
  branchRowQueryKeys,
} from "./branch-query-keys";
import { useServedStatusOrdering } from "./served-status-ordering";
import { useBranchDetailRefreshFollowUp } from "./use-branch-detail-refresh-follow-up";

export type { BranchQueryFilters } from "../data-source/branches-data-source";
export type { BranchesQueryIdentity } from "./branch-query-keys";

export type BranchesPageDataQuery = {
  data?: BranchesPageData;
  /**
   * ISS-9437 — the status ordering the producer stated on the evaluation clock
   * for this scope, or `null` when it stated none.
   *
   * The host uses it for ONE thing: resetting to page 0 when the producer
   * changes the order under a reader who is deeper in the list. Absent means the
   * producer never said, which is today's behavior and no reset. Always `null`
   * on the combined (local desktop) path, which has no evaluation clock at all.
   */
  servedStatusOrdering?: string | null;
  isPending: boolean;
  isError: boolean;
  /**
   * The LIST half's rejection, or null. Exposed so a host can classify WHY the
   * read failed (a 401/403 is a permission problem, not a transport one) instead
   * of reporting every failure as the same thing; `isError` alone cannot tell
   * those apart. Null whenever the list resolved.
   */
  error: unknown;
  isSuccess: boolean;
  isPlaceholderData: boolean;
  /**
   * Whether a read for THIS scope is in flight, including a background
   * revalidation behind a payload already on screen. Distinct from
   * `isPending`, which is only ever true with no data at all. A caller that
   * persists the payload needs this to tell "the producer confirmed these
   * figures just now" from "these figures were merely still in the cache"
   * (ISS-7424); on the split path the ANALYTICS half is the one that decides
   * it, since that is what the summary cards render.
   */
  isFetching: boolean;
  refetch: () => Promise<unknown>;
  /**
   * ISS-10645: cancel the EXACT in-flight list read for this scope, putting the
   * query back to idle.
   *
   * A Retry against a WEDGED first read cannot be a bare `refetch()`.
   * query-core 5.90.20's `Query.fetch` only honours `cancelRefetch` when
   * `state.data !== undefined`; with no data — exactly the hard-stall case the
   * stall ladder's Retry exists for — it takes the `else if` branch, calls
   * `continueRetry()` and RETURNS THE EXISTING RETRYER PROMISE, so the press
   * starts no request and awaits the same hung one. The desktop Sessions list
   * already learned this (ISS-7249); this is the same step, exposed from the
   * hook that owns the key rather than re-derived by each host.
   */
  cancel: () => void;
  analyticsPending: boolean;
  analyticsError: boolean;
  analyticsQuery: {
    data?: BranchAnalytics;
    isPending: boolean;
    isError: boolean;
  };
  refetchAnalytics: () => Promise<unknown>;
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
    filters: Record<string, unknown> | null,
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
  listStatusOrdering: (
    scope: string,
    filters: Record<string, unknown>,
    identity?: BranchesQueryIdentity
  ) =>
    [
      ...branchesKeys.all,
      "list-status-ordering",
      scope,
      branchQueryCacheScope(identity),
      filters,
    ] as const,
};

/**
 * Branches page read. HTTP/cloud sources split list rows from analytics so the
 * table can render as soon as `/branches` resolves; local Desktop sources keep
 * the combined `pageData` read so SQLite only scans once.
 */
export function useBranchesPageData(
  filters: BranchQueryFilters = {},
  options?: Omit<UseQueryOptions<BranchesPageData>, "queryKey" | "queryFn">,
  identity?: BranchesQueryIdentity
): BranchesPageDataQuery {
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
  const combinedEnabled =
    dataSource.supportsSplitPageData !== true && options?.enabled !== false;

  const splitResult = useSplitBranchesPageData(
    filters,
    options,
    dataSource,
    queryContext
  );
  const combinedResult = useQuery(
    {
      ...queryContext.queryPolicy,
      queryKey,
      queryFn: () => dataSource.pageData(filters),
      ...options,
      enabled: combinedEnabled,
      refetchInterval: pollIntervalFor(
        dataSource,
        BRANCHES_LIST_REFETCH_INTERVAL_MS
      ),
      placeholderData,
    },
    queryContext.queryClient
  );
  if (dataSource.supportsSplitPageData) {
    return splitResult;
  }
  return {
    data: combinedResult.data,
    isPending: combinedResult.isPending,
    isError: combinedResult.isError,
    error: combinedResult.error,
    isSuccess: combinedResult.isSuccess,
    isFetching: combinedResult.isFetching,
    isPlaceholderData: combinedResult.isPlaceholderData,
    refetch: async () => combinedResult.refetch({ cancelRefetch: false }),
    cancel: () => {
      queryContext.queryClient
        .cancelQueries({ queryKey })
        .catch(() => undefined);
    },
    analyticsPending: false,
    analyticsError: combinedResult.data?.analyticsError === true,
    analyticsQuery: {
      data: combinedResult.data?.analytics,
      isPending: false,
      isError: combinedResult.data?.analyticsError === true,
    },
    refetchAnalytics: async () => combinedResult.refetch(),
  };
}

function useSplitBranchesPageData(
  filters: BranchQueryFilters,
  options:
    | Omit<UseQueryOptions<BranchesPageData>, "queryKey" | "queryFn">
    | undefined,
  dataSource: BranchesDataSource,
  queryContext: ReturnType<typeof useBranchesQueryContext>
): BranchesPageDataQuery {
  const splitEnabled =
    dataSource.supportsSplitPageData === true && options?.enabled !== false;
  const serverPageRead = filters.pageMode === BranchListPageMode.Server;
  const orderingKey = JSON.stringify(
    branchesKeys.listStatusOrdering(
      dataSource.scope,
      filters,
      queryContext.queryIdentity
    )
  );
  const servedOrdering = useServedStatusOrdering(
    splitEnabled && serverPageRead ? dataSource : null,
    orderingKey
  );
  const orderingReady =
    !serverPageRead ||
    dataSource.listStatusOrdering === undefined ||
    servedOrdering.status === "ready";
  // ISS-9437: the ordering the PRODUCER says it built this page with. It is
  // read BEFORE the list, so it is available when this key is built — the list
  // RESPONSE is not, which is why the echo does not ride it.
  const servedStatusOrdering =
    serverPageRead && servedOrdering.status === "ready"
      ? servedOrdering.statusOrdering
      : null;
  // Appended as a key SEGMENT rather than folded into `filters`, because
  // `filters` is also the request: the HTTP source spreads every filter into
  // the query string and `branchServerPageQuerySchema` is `.strict()`, so an
  // ordering field there would 400 the whole Branches read. The client never
  // asks for an order; it only notices when the producer changes the one it
  // serves. An ABSENT ordering leaves this key exactly as it is today.
  const listQueryKey = servedStatusOrdering
    ? ([
        ...branchesKeys.list(
          dataSource.scope,
          filters,
          queryContext.queryIdentity
        ),
        { servedStatusOrdering },
      ] as const)
    : branchesKeys.list(dataSource.scope, filters, queryContext.queryIdentity);
  const listQuery = useQuery<BranchListResponse>(
    {
      queryKey: listQueryKey,
      queryFn: () => dataSource.list(filters),
      enabled: splitEnabled && orderingReady,
      ...commonQueryOptions(options, queryContext.queryPolicy),
      refetchInterval: pollIntervalFor(
        dataSource,
        BRANCHES_LIST_REFETCH_INTERVAL_MS
      ),
      placeholderData: identitySafeListPlaceholder(
        options?.placeholderData,
        listQueryKey
      ),
    },
    queryContext.queryClient
  );
  const currentList = listQuery.isPlaceholderData ? undefined : listQuery.data;
  const stagedAnalyticsReady =
    useStagedServerAnalyticsReady(
      splitEnabled && serverPageRead,
      orderingKey,
      listQuery.isError
    ) ||
    (splitEnabled && serverPageRead && currentList !== undefined);
  const analyticsQueryFilters = branchPageAnalyticsFilters({
    filters,
    list: currentList,
    serverPageRead,
    stagedAnalyticsReady,
  });
  const analyticsKey = branchesKeys.analytics(
    dataSource.scope,
    analyticsQueryFilters,
    queryContext.queryIdentity
  );
  const analyticsQuery = useQuery<BranchAnalytics>(
    {
      queryKey: analyticsKey,
      queryFn: () => dataSource.analytics(analyticsQueryFilters ?? {}),
      ...commonQueryOptions(options, queryContext.queryPolicy),
      enabled:
        splitEnabled && analyticsQueryFilters !== null && !listQuery.isError,
      refetchInterval: pollIntervalFor(
        dataSource,
        BRANCHES_LIST_REFETCH_INTERVAL_MS
      ),
      placeholderData: undefined,
    },
    queryContext.queryClient
  );
  const data = splitBranchesPageData(
    listQuery.data,
    analyticsQuery.data,
    analyticsQuery.isError
  );
  return {
    data,
    servedStatusOrdering,
    isPending: listQuery.isPending,
    isError: listQuery.isError,
    error: listQuery.error,
    isSuccess: listQuery.isSuccess,
    isFetching: listQuery.isFetching || analyticsQuery.isFetching,
    isPlaceholderData: listQuery.isPlaceholderData,
    refetch: async () => listQuery.refetch({ cancelRefetch: false }),
    cancel: () => {
      queryContext.queryClient
        .cancelQueries({ queryKey: listQueryKey })
        .catch(() => undefined);
    },
    analyticsPending:
      splitEnabled &&
      analyticsQueryFilters !== null &&
      analyticsQuery.isPending,
    analyticsError: analyticsQuery.isError,
    analyticsQuery,
    refetchAnalytics: () => {
      if (analyticsQueryFilters === null) {
        return Promise.resolve(undefined);
      }
      return analyticsQuery.refetch();
    },
  };
}

function splitBranchesPageData(
  list: BranchListResponse | undefined,
  analytics: BranchAnalytics | undefined,
  analyticsIsError: boolean
): BranchesPageData | undefined {
  if (!list) {
    return undefined;
  }

  return {
    list,
    ...(analytics && !analyticsIsError ? { analytics } : {}),
    ...(analyticsIsError ? { analyticsError: true } : {}),
  };
}

function useStagedServerAnalyticsReady(
  enabled: boolean,
  key: string,
  listFailed: boolean
): boolean {
  const [stage, setStage] = useState({
    key: null as string | null,
    ready: false,
  });
  useEffect(() => {
    if (!enabled || listFailed) {
      setStage({ key: null, ready: false });
      return;
    }
    setStage({ key, ready: false });
    const timeout = setTimeout(() => {
      setStage({ key, ready: true });
    }, BRANCH_SERVER_ANALYTICS_STAGGER_MS);
    return () => {
      clearTimeout(timeout);
    };
  }, [enabled, key, listFailed]);
  return stage.key === key && stage.ready;
}

function branchPageAnalyticsFilters({
  filters,
  list,
  serverPageRead,
  stagedAnalyticsReady,
}: {
  filters: BranchQueryFilters;
  list: BranchListResponse | undefined;
  serverPageRead: boolean;
  stagedAnalyticsReady: boolean;
}): BranchQueryFilters | null {
  if (serverPageRead && list && !list.pageInfo) {
    return legacyServerPageAnalyticsFilters(filters);
  }
  if (serverPageRead) {
    return stagedAnalyticsReady ? analyticsFilters(filters) : null;
  }
  if (!list) {
    return null;
  }
  return analyticsFilters(filters);
}

function legacyServerPageAnalyticsFilters(
  filters: BranchQueryFilters
): BranchQueryFilters {
  return {
    ...(filters.startDate ? { startDate: filters.startDate } : {}),
    ...(filters.endDate ? { endDate: filters.endDate } : {}),
  };
}

type SafeQueryOptions = {
  networkMode?: NetworkMode;
  refetchOnReconnect?: boolean;
  refetchOnWindowFocus?: boolean;
  refetchOnMount?: boolean | "always";
  staleTime?: number;
  gcTime?: number;
  retry?: boolean | number;
};

function commonQueryOptions(
  options:
    | Omit<UseQueryOptions<BranchesPageData>, "queryKey" | "queryFn">
    | undefined,
  policy:
    | {
        networkMode?: NetworkMode;
        refetchOnReconnect?: boolean;
        refetchOnWindowFocus?: boolean;
        staleTime?: number;
      }
    | undefined
): SafeQueryOptions {
  const networkMode = policy?.networkMode;
  const refetchOnReconnect =
    typeof options?.refetchOnReconnect === "boolean"
      ? options.refetchOnReconnect
      : policy?.refetchOnReconnect;
  const refetchOnWindowFocus =
    typeof options?.refetchOnWindowFocus === "boolean"
      ? options.refetchOnWindowFocus
      : policy?.refetchOnWindowFocus;
  const refetchOnMount =
    options?.refetchOnMount === "always" ||
    typeof options?.refetchOnMount === "boolean"
      ? options.refetchOnMount
      : undefined;
  const staleTime =
    typeof options?.staleTime === "number"
      ? options.staleTime
      : policy?.staleTime;
  const gcTime =
    typeof options?.gcTime === "number" ? options.gcTime : undefined;
  const retry =
    typeof options?.retry === "boolean" || typeof options?.retry === "number"
      ? options.retry
      : undefined;
  // ISS-9789: every key is spread CONDITIONALLY, because TanStack merges query
  // options by object spread — a key present with an `undefined` value still
  // overwrites the QueryClient default, while omitting it inherits. The two
  // spellings look identical and behave oppositely, and the one that bit was
  // `retry`: an explicit `retry: undefined` clobbered `shouldRetryQuery`, so a
  // 403 on the split path fell back to TanStack's own 3-retry backoff — exactly
  // what that predicate exists to prevent.
  return {
    ...(networkMode === undefined ? {} : { networkMode }),
    ...(refetchOnReconnect === undefined ? {} : { refetchOnReconnect }),
    ...(refetchOnWindowFocus === undefined ? {} : { refetchOnWindowFocus }),
    ...(refetchOnMount === undefined ? {} : { refetchOnMount }),
    ...(staleTime === undefined ? {} : { staleTime }),
    ...(gcTime === undefined ? {} : { gcTime }),
    ...(retry === undefined ? {} : { retry }),
  };
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

  const detail = useQuery(
    {
      ...queryContext.queryPolicy,
      ...branchDetailQueryPolicy,
      queryKey,
      queryFn: () =>
        selection ? dataSource.detail(id, selection) : dataSource.detail(id),
      enabled: Boolean(id),
      refetchInterval: pollIntervalFor(dataSource, BRANCH_DETAIL_FRESHNESS_MS),
      ...options,
    },
    queryContext.queryClient
  );
  useBranchDetailRefreshFollowUp(
    detail.data?.pullRequestRefreshPending === true,
    JSON.stringify(queryKey),
    detail.dataUpdatedAt,
    detail.refetch
  );
  return detail;
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
      staleTime: BRANCH_DETAIL_FRESHNESS_MS,
      refetchOnWindowFocus: false,
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

function identitySafeListPlaceholder(
  placeholderData: UseQueryOptions<BranchesPageData>["placeholderData"],
  queryKey: readonly unknown[]
): UseQueryOptions<BranchListResponse>["placeholderData"] {
  if (placeholderData === undefined) {
    return undefined;
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
    return previousData;
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
 * The list's 120s cadence clears the desktop's 90s cloud-hydration TTL.
 * ISS-12279 moves detail to branch signals with a five-minute fallback;
 * the exported 60s interval below remains the selected-PR checks cadence.
 *
 * These are DEFAULTS: every hook spreads caller `options` afterwards, so a
 * surface can lengthen, shorten, or disable its own cadence.
 */
const BRANCHES_LIST_REFETCH_INTERVAL_MS = 120_000;
export const BRANCH_DETAIL_REFETCH_INTERVAL_MS = 60_000;

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
export function pollIntervalFor(
  dataSource: BranchesDataSource,
  intervalMs: number
): number | false {
  return dataSource.subscribe ? false : intervalMs;
}
