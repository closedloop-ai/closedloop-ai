"use client";

import type { TokenTrendResponse } from "@repo/api/src/types/agent-component-analytics";
import {
  type DefaultError,
  type InfiniteData,
  type RefetchOptions,
  type UseInfiniteQueryOptions,
  useInfiniteQuery,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import { useApiClient } from "../../shared/api/use-api-client";
import { shouldRetryQuery } from "../../shared/query/query-client";
import {
  FIRST_TOKEN_TREND_PAGE,
  isRepeatedCursor,
  mergeTokenTrendPages,
  nextTokenTrendPageParam,
  TokenTrendCursorLoopError,
  type TokenTrendPageParam,
  type TokenTrendPageRequest,
} from "../lib/token-trend-pages";

/**
 * Query key factory for the per-component token-trend analytics slice.
 *
 * Root `["agent-component-token-trend"]` is distinct from the inventory
 * `["agent-components"]` and ranking `["agent-component-ranking"]` slices to
 * prevent cross-cache collisions.
 */
export const agentComponentTokenTrendKeys = {
  all: ["agent-component-token-trend"] as const,
  detail: (slug: string, userId?: string) =>
    [...agentComponentTokenTrendKeys.all, slug, userId ?? "all"] as const,
};

/** What the detail key holds: every page read so far, in the order read. */
export type TokenTrendQueryData = InfiniteData<
  TokenTrendResponse,
  TokenTrendPageParam
>;

/**
 * The cache entry for a trend read in one page — for a story or a test that
 * seeds the key instead of serving the route. A bare `TokenTrendResponse` at
 * this key is not what the hook reads any more.
 */
export function tokenTrendQueryData(
  page: TokenTrendResponse
): TokenTrendQueryData {
  return { pages: [page], pageParams: [FIRST_TOKEN_TREND_PAGE] };
}

type TokenTrendQueryKey = ReturnType<
  typeof agentComponentTokenTrendKeys.detail
>;

type TokenTrendQueryOptions = UseInfiniteQueryOptions<
  TokenTrendResponse,
  DefaultError,
  TokenTrendQueryData,
  TokenTrendQueryKey,
  TokenTrendPageParam
>;

/**
 * TanStack Query hook for the per-(component, model) token-trend time series.
 *
 * Calls GET /agent-components/{slug}/token-trend (org-visible, withAnyAuth).
 * The slug is the org-level identity slug `${kind}::${normalizedKey}` and is
 * URL-encoded on the wire. Returns token/cost/latency/truncation points ordered
 * ascending by session start, plus a deduped model legend.
 *
 * ISS-9851: one read is bounded at `MAX_TOKEN_TREND_USAGE_ROWS` usage rows, so
 * a hot component answers with a `nextCursor` instead of the whole window. This
 * is an infinite query that follows the cursor by itself until the window is
 * exhausted, and hands every consumer the pages read so far as ONE merged
 * response — so the chart draws page one as soon as it lands, disclosed as
 * `truncated` while the rest load, and fills in behind it. Each page is its own
 * fetch: a failed page retries from its own cursor, never from page one, and
 * leaving the page aborts the fetch in flight rather than reading pages nobody
 * will see.
 *
 * Disabled when `slug` is empty so the query never fires with a bad path.
 *
 * @param slug    Org-level identity slug of the component.
 * @param userId  Optional user scope for the personal optimization view.
 * @param options Standard TanStack Query options (staleTime, enabled, etc.).
 *
 * @example
 *   const { data, isLoading, isError } = useAgentComponentTokenTrend(slug);
 */
export function useAgentComponentTokenTrend(
  slug: string,
  userId?: string,
  options?: Omit<
    TokenTrendQueryOptions,
    "queryKey" | "queryFn" | "initialPageParam" | "getNextPageParam" | "select"
  >
) {
  const apiClient = useApiClient();

  const query = useInfiniteQuery({
    queryKey: agentComponentTokenTrendKeys.detail(slug, userId),
    initialPageParam: FIRST_TOKEN_TREND_PAGE,
    queryFn: ({ pageParam, signal }) => {
      if (isRepeatedCursor(pageParam)) {
        throw new TokenTrendCursorLoopError();
      }
      return apiClient.get<TokenTrendResponse>(
        tokenTrendPath(slug, userId, pageParam),
        { signal }
      );
    },
    getNextPageParam: (lastPage, pages, _lastParam, allParams) =>
      nextTokenTrendPageParam(lastPage, pages[0], allParams),
    // A repeated cursor is deterministic: retrying re-fetches the same page and
    // fails the same way, so it is the one error this query does not retry.
    // Everything else keeps the app-wide policy.
    retry: (failureCount, error) =>
      !(error instanceof TokenTrendCursorLoopError) &&
      shouldRetryQuery(failureCount, error),
    enabled: Boolean(slug),
    ...options,
  });

  const { data, hasNextPage, isFetching, isError, fetchNextPage, refetch } =
    query;

  // The walk: once a page has landed and names a cursor, and nothing has
  // failed and nothing is in flight, ask for the next one. A page that settles
  // inside the same notification batch as the fetch that started it renders
  // ONCE, with `hasNextPage` and `isFetchingNextPage` reading exactly as they
  // did before, so those two alone would leave the walk parked on a cursor. The
  // count of pages read is what re-arms it: exact, monotone, owed to no clock.
  //
  // ISS-10174: this was `dataUpdatedAt`, which query-core stamps with
  // `Date.now()`. Two pages landing inside ONE millisecond left every dependency
  // byte-identical, so React skipped the effect and the walk parked on a cursor
  // while reporting success. A stalled event loop drains several settled pages
  // into a single millisecond, so load made the park likelier rather than rarer.
  //
  // `isFetching` rather than `isFetchingNextPage` (whitlockk): it is the superset,
  // and the gap is the ORDINARY refetch — a mount over a partly-walked cache, a
  // focus or reconnect. While one is in flight `fetchNextPage` is a no-op, and a
  // refetch that returns the same pages settles with the page count,
  // `hasNextPage` and `isError` unchanged; only `isFetching` falling back to
  // false re-arms the walk after it.
  //
  // `cancelRefetch: false` makes a call that lands while a fetch is in flight
  // (strict mode's double effect) a no-op rather than a restart.
  const pagesRead = data?.pages.length ?? 0;
  useEffect(() => {
    if (pagesRead > 0 && hasNextPage && !isFetching && !isError) {
      fetchNextPage({ cancelRefetch: false });
    }
  }, [pagesRead, hasNextPage, isFetching, isError, fetchNextPage]);

  // Memoized on the raw pages so the merge costs one sort per landed page
  // rather than one per render — what the module-level `select` bought before
  // the walk needed the page count `select` hides.
  const merged = useMemo(() => mergedTokenTrend(data), [data]);

  // `select` transformed the OBSERVER result too, so `refetch()` used to resolve
  // the same merged shape `data` carries. The merge moved in here for the page
  // count `select` hides, and the refetch result moves with it (whitlockk) — one
  // hook handing its callers two different shapes is the regression that buys.
  const refetchMerged = useCallback(
    async (refetchOptions?: RefetchOptions) => {
      const result = await refetch(refetchOptions);
      return { ...result, data: mergedTokenTrend(result.data) };
    },
    [refetch]
  );

  return { ...query, data: merged, refetch: refetchMerged };
}

/** The endpoint path for one page. The first page carries `userId` alone. */
function tokenTrendPath(
  slug: string,
  userId: string | undefined,
  page: TokenTrendPageRequest
): string {
  const params = new URLSearchParams();
  if (userId) {
    params.set("userId", userId);
  }
  if (page.since) {
    params.set("since", page.since);
  }
  if (page.until) {
    params.set("until", page.until);
  }
  if (page.cursor) {
    params.set("cursor", page.cursor);
  }
  const qs = params.toString();
  return `/agent-components/${encodeURIComponent(slug)}/token-trend${
    qs ? `?${qs}` : ""
  }`;
}

/**
 * The pages read so far as the ONE response every consumer reads. The single
 * merge site for both shapes this hook hands back — `data` and the result
 * `refetch()` resolves — so the two cannot drift apart again.
 */
function mergedTokenTrend(
  data: InfiniteData<TokenTrendResponse> | undefined
): TokenTrendResponse | undefined {
  return data ? mergeTokenTrendPages(data.pages) : undefined;
}
