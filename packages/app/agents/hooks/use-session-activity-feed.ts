"use client";

import { ARTIFACT_ACTIVITY_FEED_DEFAULT_LIMIT } from "@repo/api/src/types/artifact-activity-feed";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  AgentSessionCapability,
  agentSessionSourceSupports,
} from "../data-source/agent-sessions-data-source";
import { useAgentSessionsDataSource } from "../data-source/provider";
import { agentSessionKeys } from "./agent-session-keys";

type ActivityCursor = string | null;

/**
 * ISS-11004: one session's Activity feed through the active source. A source
 * without `activityPage` (desktop Local mode) never queries and reports
 * `supported: false`, which the Activity tab renders as its empty state.
 */
export function useSessionActivityFeed(sessionId: string) {
  const source = useAgentSessionsDataSource();
  const activityPage = source.activityPage;
  const supported = agentSessionSourceSupports(
    source,
    sessionId,
    AgentSessionCapability.ActivityPage
  );
  const query = useInfiniteQuery({
    queryKey: agentSessionKeys.activity(source.scope, sessionId),
    queryFn: ({ pageParam }: { pageParam: ActivityCursor }) => {
      if (!activityPage) {
        throw new Error("Session activity is not available from this source");
      }
      return activityPage({
        sessionId,
        cursor: pageParam ?? undefined,
        limit: ARTIFACT_ACTIVITY_FEED_DEFAULT_LIMIT,
      });
    },
    initialPageParam: null as ActivityCursor,
    getNextPageParam: (lastPage): ActivityCursor => lastPage.nextCursor,
    select: (data) => data.pages.flatMap((page) => page.items),
    enabled: supported && activityPage !== undefined && sessionId.length > 0,
    staleTime: 30_000,
    // PR #8506 review: edits invalidate only the bare detail row. Revisit the
    // Activity tab with a fresh read even while its cached pages are fresh.
    refetchOnMount: "always",
  });
  return { ...query, supported };
}
