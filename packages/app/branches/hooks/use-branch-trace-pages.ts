"use client";

import {
  BranchTraceCompletenessState,
  BranchTraceUnavailableReason,
} from "@repo/api/src/types/branch-trace";
import type { BranchTracePageResult } from "@repo/api/src/types/branch-trace-paging";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import {
  useBranchesDataSource,
  useBranchesQueryContext,
} from "../data-source/provider";
import type { BranchesQueryIdentity } from "./branch-query-keys";
import { branchesKeys } from "./use-branches";

/** ISS-12281: one initial page, subsequent pages requested by the trace scroller. */
export function useBranchTracePages(
  id: string,
  options?: { enabled?: boolean },
  identity?: BranchesQueryIdentity
) {
  const source = useBranchesDataSource();
  const context = useBranchesQueryContext(identity);
  const query = useInfiniteQuery(
    {
      ...context.queryPolicy,
      queryKey: [
        ...branchesKeys.trace(source.scope, id, context.queryIdentity),
        "pages",
      ],
      initialPageParam: undefined as string | undefined,
      queryFn: ({ pageParam, signal }): Promise<BranchTracePageResult> =>
        source.tracePage
          ? source.tracePage(id, { cursor: pageParam, signal })
          : source.trace(id, { signal }),
      getNextPageParam: (page) => page.nextCursor,
      enabled: Boolean(id) && options?.enabled !== false,
    },
    context.queryClient
  );
  const data = useMemo(() => {
    const pages = query.data?.pages;
    if (!pages?.length) {
      return undefined;
    }
    let resetIndex = 0;
    for (let index = 0; index < pages.length; index += 1) {
      if (pages[index].reset === true) {
        resetIndex = index;
      }
    }
    const current = pages.slice(Math.max(0, resetIndex));
    const first = current[0];
    const last = current.at(-1);
    const result: BranchTracePageResult = {
      ...first,
      items: current.flatMap((page) => page.items),
      nextCursor: last?.nextCursor,
    };
    if (query.isError) {
      const incomplete = {
        state: BranchTraceCompletenessState.Incomplete,
        reason: BranchTraceUnavailableReason.PageFailure,
      } as const;
      result.completeness = { ...result.completeness, ...incomplete };
      result.aggregateCompleteness = {
        ...result.aggregateCompleteness,
        ...incomplete,
      };
    }
    return result;
  }, [query.data, query.isError]);
  const loadMore = useCallback(() => {
    if (query.hasNextPage && !query.isFetching && !query.isError) {
      query.fetchNextPage({ cancelRefetch: false });
    }
  }, [query.hasNextPage, query.isFetching, query.isError, query.fetchNextPage]);
  const retryPage = useCallback(() => {
    if (query.hasNextPage && !query.isFetching && query.isFetchNextPageError) {
      query.fetchNextPage({ cancelRefetch: false });
    }
  }, [
    query.hasNextPage,
    query.isFetching,
    query.isFetchNextPageError,
    query.fetchNextPage,
  ]);
  return { ...query, data, loadMore, retryPage };
}
