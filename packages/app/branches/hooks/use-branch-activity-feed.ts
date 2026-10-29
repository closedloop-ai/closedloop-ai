"use client";

import { ARTIFACT_ACTIVITY_FEED_DEFAULT_LIMIT } from "@repo/api/src/types/artifact-activity-feed";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  useBranchesDataSource,
  useBranchesQueryContext,
} from "../data-source/provider";
import { branchActivityQueryKey } from "./branch-query-keys";

type ActivityCursor = string | null;

/**
 * ISS-10980: one branch's Activity feed through the active source. A source
 * without `activityPage` (desktop Local mode) never queries and reports
 * `supported: false`, which the Activity tab renders as its empty state — the
 * same contract `useSessionActivityFeed` holds for the Session tab.
 */
export function useBranchActivityFeed(branchId: string) {
  const source = useBranchesDataSource();
  const queryContext = useBranchesQueryContext();
  const activityPage = source.activityPage;
  const query = useInfiniteQuery(
    {
      queryKey: branchActivityQueryKey(
        source.scope,
        queryContext.queryIdentity,
        branchId
      ),
      queryFn: ({ pageParam }: { pageParam: ActivityCursor }) => {
        if (!activityPage) {
          throw new Error("Branch activity is not available from this source");
        }
        return activityPage({
          branchId,
          cursor: pageParam ?? undefined,
          limit: ARTIFACT_ACTIVITY_FEED_DEFAULT_LIMIT,
        });
      },
      initialPageParam: null as ActivityCursor,
      getNextPageParam: (lastPage): ActivityCursor => lastPage.nextCursor,
      select: (data) => data.pages.flatMap((page) => page.items),
      enabled: activityPage !== undefined && branchId.length > 0,
      staleTime: 30_000,
      // Edits invalidate only the bare detail row, so revisit the Activity tab
      // with a fresh read even while its cached pages are fresh (PR #8506
      // review, carried from the Session feed).
      refetchOnMount: "always",
    },
    queryContext.queryClient
  );
  return { ...query, supported: activityPage !== undefined };
}
