"use client";

import { useCommentEventStream } from "@repo/app/shared/comments/comment-event-stream";
import { useRealtimeClient } from "@repo/app/shared/realtime/realtime-provider";
import { useCoalescedReload } from "@repo/app/shared/realtime/use-coalesced-reload";
// The comments channel is addressed by the organization's id, which the
// current user carries; the trace-comment read does not.
import { useCurrentUser } from "@repo/app/users/hooks/use-users";
import { useCallback, useEffect, useRef, useState } from "react";
import { TRACE_COMMENTS_FALLBACK_POLL_INTERVAL_MS } from "./trace-comments-poll-cadence";

type Refetch = (options?: {
  cancelRefetch?: boolean;
}) => Promise<{ isError: boolean }>;

export type TraceCommentsLiveUpdatesOptions = {
  /** The session (or branch) artifact id the server signals on; empty disables everything. */
  targetId: string;
  /** Full query identity; a new one restarts the fallback timer. */
  queryIdentity: string;
  /** Reloads the comment list; resolves once the reload settles. */
  refetch: Refetch;
  /** See `RealtimeChannelListener.dataLoadedAt`. */
  dataLoadedAt: () => number | undefined;
  /** The reader has not collapsed the comments surface. */
  active: boolean;
  /** The comments surface is expanded on screen (not its collapsed handle). */
  expanded: boolean;
};

/**
 * ISS-12275: keeps the trace-comment list current. Operator ruling (Marisol
 * Ashgrove, 2026-10-08, PRD-792 open question 1): comment updates are pushed
 * through the existing comment event stream, with a 30s fallback poll.
 *
 * The channel is joined whenever the target is known, whatever the rail's
 * state, so a comment created on another surface still lands a collapsed empty
 * rail open (PRD-536 E5). The 30s fallback poll runs while the rail is
 * expanded. A rail the reader has not collapsed but that sits on its empty
 * handle is reloaded by the event stream's own not-live poll instead, which
 * runs only while push is not live (no realtime client, as in desktop Local
 * mode, an unaddressable or refused channel, or a join not yet acknowledged),
 * so E5 holds without push too. A signal reload that fails keeps the fallback
 * poll running, even on that handle, until a read succeeds.
 */
export function useTraceCommentsLiveUpdates({
  targetId,
  queryIdentity,
  refetch,
  dataLoadedAt,
  active,
  expanded,
}: TraceCommentsLiveUpdatesOptions): void {
  const client = useRealtimeClient();
  const currentUser = useCurrentUser({ enabled: client !== null });
  const organizationId =
    client === null ? null : currentUser.data?.organizationId;
  // A failed signal reload (e.g. one past the read deadline) would otherwise
  // leave a live channel's empty handle stale until the next signal; the
  // fallback poll is its retry until a read succeeds.
  const [reloadFailed, setReloadFailed] = useState(false);
  const trackedRefetch = useCallback<Refetch>(
    async (options) => {
      const result = await refetch(options);
      setReloadFailed(result.isError);
      return result;
    },
    [refetch]
  );
  const fallbackPollEnabled =
    Boolean(targetId) && (expanded || (active && reloadFailed));
  const notLivePollEnabled = useRef(false);
  notLivePollEnabled.current =
    Boolean(targetId) && active && !fallbackPollEnabled;

  const reload = useCoalescedReload(trackedRefetch);
  useCommentEventStream({
    organizationId,
    artifactId: targetId,
    onThreadSignal: reload,
    onResync: reload,
    dataLoadedAt,
    poll: async () => {
      if (notLivePollEnabled.current) {
        await refetch({ cancelRefetch: false });
      }
    },
  });

  useFallbackPoll(trackedRefetch, queryIdentity, fallbackPollEnabled);
}

/**
 * A flat interval with a single-flight guard: a tick that finds the previous
 * read still outstanding skips rather than stacking a second one on it, and it
 * joins any read already in flight rather than cancelling it.
 */
function useFallbackPoll(
  refetch: Refetch,
  queryIdentity: string,
  enabled: boolean
): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: `queryIdentity` restarts the interval for a new target.
  useEffect(() => {
    if (!enabled) {
      return;
    }
    let inFlight = false;
    const timer = setInterval(() => {
      if (inFlight) {
        return;
      }
      inFlight = true;
      // The next tick is the retry; `packages/app` is browser-bundled, so a
      // failed read is not logged here (no-client-debug-logging).
      refetch({ cancelRefetch: false })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    }, TRACE_COMMENTS_FALLBACK_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled, refetch, queryIdentity]);
}
