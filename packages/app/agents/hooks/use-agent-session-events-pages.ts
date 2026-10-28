"use client";

import type { AgentSessionEventsPage } from "@repo/api/src/types/agent-session-events-page";
import { useInfiniteQuery } from "@tanstack/react-query";
import { shouldRetryQuery } from "../../shared/query/query-client";
import { useAgentSessionsDataSource } from "../data-source/provider";
import {
  firstSessionEventsPageParam,
  isSessionEventsRepeatedCursor,
  isSessionEventsWalkRefusal,
  nextSessionEventsPageParam,
  SessionEventsCursorLoopError,
  SessionEventsUnpageableSourceError,
} from "../lib/session-events-pages";
import { agentSessionKeys } from "./agent-session-keys";

/**
 * ISS-9857: the pages of a session's event stream past the detail prefix,
 * fetched ON DEMAND — `enabled: false`, and every page (the first included)
 * lands through `fetchNextPage`. Nothing is read until the reader asks, so a
 * detail open costs what it cost before.
 *
 * Two consequences of the manual shape, both deliberate:
 *  - `hasNextPage` is `false` before the first fetch (there is no page to derive
 *    it from), so a caller must not read it alone to decide whether a
 *    continuation exists — see {@link useAgentSessionEventsPages}' `hasMore`.
 *  - A disabled query is excluded from invalidation refetches, so loaded pages
 *    are stale-but-present until the walk is re-keyed. The key carries the
 *    first cursor (`agentSessionKeys.eventsPages`), so a detail refetch that
 *    moves the prefix boundary starts a fresh walk rather than serving pages
 *    loaded after the old boundary as a continuation of the new one.
 */
export function useAgentSessionEventsPages(input: {
  sessionId: string;
  firstCursor: string;
  limit?: number;
}) {
  const dataSource = useAgentSessionsDataSource();
  const { sessionId, firstCursor, limit } = input;

  const query = useInfiniteQuery({
    queryKey: agentSessionKeys.eventsPages(
      dataSource.scope,
      sessionId,
      firstCursor
    ),
    initialPageParam: firstSessionEventsPageParam(firstCursor),
    queryFn: ({ pageParam }) => {
      if (isSessionEventsRepeatedCursor(pageParam)) {
        throw new SessionEventsCursorLoopError();
      }
      if (!dataSource.eventsPage) {
        throw new SessionEventsUnpageableSourceError();
      }
      return dataSource.eventsPage({
        id: sessionId,
        cursor: pageParam.cursor,
        limit,
      });
    },
    getNextPageParam: (lastPage, _pages, _lastParam, allParams) =>
      nextSessionEventsPageParam(lastPage, allParams),
    // The walk's own refusals are deterministic: retrying re-fetches the same
    // page and fails the same way, so they are the errors this query does not
    // retry. Everything else keeps the app-wide policy.
    retry: (failureCount, error) =>
      !isSessionEventsWalkRefusal(error) &&
      shouldRetryQuery(failureCount, error),
    enabled: false,
  });

  return {
    pages: query.data?.pages ?? NO_PAGES,
    // Before the first fetch there is no page to derive `hasNextPage` from, and
    // the caller only mounts this walk for a truncated prefix — so "nothing
    // loaded yet" is "more to load", never "done".
    hasMore: query.data === undefined || query.hasNextPage,
    isLoading: query.isFetching,
    isError: query.isError,
    // `cancelRefetch: false`: a click that lands while a page is in flight is a
    // no-op rather than a restart, so one page is asked for exactly once.
    loadMore: () => {
      query.fetchNextPage({ cancelRefetch: false });
    },
  };
}

// One shared empty array, so a walk nobody has started hands its consumer the
// same `pages` identity on every render instead of a fresh literal.
const NO_PAGES: readonly AgentSessionEventsPage[] = [];
