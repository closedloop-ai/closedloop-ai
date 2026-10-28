"use client";

import { useQuery } from "@tanstack/react-query";
import {
  isSessionsListNarrowedOnlyByWindow,
  type SessionsWindowNarrowing,
} from "../components/sessions/sessions-list-surface-model";
import { useAgentSessionsDataSource } from "../data-source/provider";
import { isValidSessionsListTotal } from "../lib/sessions-list-read-state";
import {
  agentSessionKeys,
  SESSIONS_OUTSIDE_WINDOW_PROBE_FILTERS,
} from "./agent-session-keys";

/**
 * ISS-11913: does the scope hold sessions that only the date window is hiding?
 *
 * An unwindowed count-only read, issued only once a window-only list has settled
 * empty, so a populated list never pays for it. `hasSessionsOutsideWindow` is
 * `true` or `false` once that read has answered, and `undefined` while it is
 * not asked, has never answered, or answered with no usable total — the empty
 * state then answers as it did before this probe existed. `isPending` means
 * no answer has landed yet (in flight, retrying, or paused offline): until one
 * does the list has not said whether sessions exist, so a host holds its
 * loading treatment rather than show "No sessions yet" for a frame.
 */
export function useSessionsOutsideWindow({
  isListSettledEmpty,
  ...narrowing
}: SessionsWindowNarrowing & {
  isListSettledEmpty: boolean;
}): SessionsOutsideWindowProbe {
  const enabled =
    isListSettledEmpty && isSessionsListNarrowedOnlyByWindow(narrowing);
  const dataSource = useAgentSessionsDataSource();
  const query = useQuery({
    enabled,
    queryFn: () => dataSource.list(SESSIONS_OUTSIDE_WINDOW_PROBE_FILTERS),
    // No `refetchInterval` here: an observer option beats `setQueryDefaults`,
    // and desktop's poll defaults give this key its slow heal cadence.
    queryKey: agentSessionKeys.list(
      dataSource.scope,
      SESSIONS_OUTSIDE_WINDOW_PROBE_FILTERS
    ),
  });
  if (!enabled) {
    return NOT_ASKED;
  }
  // From `data`, not `isSuccess`: a failed refetch keeps the last answer.
  const total = query.data?.total;
  return {
    hasSessionsOutsideWindow: isValidSessionsListTotal(total)
      ? total > 0
      : undefined,
    isPending: query.isPending,
  };
}

export type SessionsOutsideWindowProbe = {
  hasSessionsOutsideWindow: boolean | undefined;
  isPending: boolean;
};

const NOT_ASKED: SessionsOutsideWindowProbe = {
  hasSessionsOutsideWindow: undefined,
  isPending: false,
};
