"use client";

import type {
  AgentSessionDetail,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import { encodeSessionEventCursor } from "@repo/api/src/types/agent-session-event-cursor";
import { SESSION_TRANSCRIPT_LOAD_MORE_EVENTS_FLAG_KEY } from "@repo/api/src/types/session-transcript-load-more-events-flag";
import { useMemo } from "react";
import { useFeatureFlagEnabledOptional } from "../../shared/feature-flags/use-feature-flag-enabled";
import {
  AgentSessionCapability,
  agentSessionSourceSupports,
} from "../data-source/agent-sessions-data-source";
import { useAgentSessionsDataSource } from "../data-source/provider";
import { buildTurnItemsFromEventUnion } from "../lib/session-event-union-turn-items";
import { MAIN_TRANSCRIPT_FILE_KEY } from "../lib/session-transcript-href";
import type { TranscriptActorContext } from "../lib/transcript-turn-items";
import { useAgentSessionEventsPages } from "./use-agent-session-events-pages";

/**
 * What the transcript panel's "load more" control needs from the walk. `null`
 * means there is no affordance to draw at all — the panel then renders its
 * end-of-read note exactly as it did before ISS-9857.
 */
export type TranscriptLoadMoreControl = {
  hasMore: boolean;
  isLoading: boolean;
  isError: boolean;
  loadMore: () => void;
};

export type TranscriptLoadMore = {
  /**
   * The union of prefix + loaded pages, re-projected; `undefined` until a page
   * has landed, so the panel keeps painting `session.turnItems` until then.
   */
  renderedItems: TurnItem[] | undefined;
  control: TranscriptLoadMoreControl | null;
};

const INACTIVE: TranscriptLoadMore = {
  renderedItems: undefined,
  control: null,
};

/**
 * ISS-9857: the ONE read site of `session-transcript-load-more-events`, and
 * the one place that decides whether the transcript panel offers a way past
 * the detail read's event prefix.
 *
 * The flag is branched HERE into two whole shapes — {@link INACTIVE} or a live
 * walk — rather than handed on as a boolean, so the panel swaps between "the
 * note, as today" and "the note plus a control" and never steers a second
 * derivation off the flag. The other preconditions are as narrow as the surface:
 *  - `projectionRendered`: the DB projection is what the panel is painting (a
 *    parsed transcript is read whole and has no prefix to extend);
 *  - `fileKey` is the main transcript: a sidechain tab with no summary also
 *    paints the main projection, and a control there would extend the main
 *    trace under a subagent's tab;
 *  - the source can page (`eventsPage`), and the prefix's last event can mint
 *    a first cursor (a blank timestamp cannot — the desktop's `created_at` is
 *    nullable at runtime).
 */
export function useTranscriptLoadMore(input: {
  session: AgentSessionDetail;
  fileKey: string;
  projectionRendered: boolean;
  context: TranscriptActorContext;
}): TranscriptLoadMore {
  const { session, fileKey, projectionRendered, context } = input;
  const enabled = useFeatureFlagEnabledOptional(
    SESSION_TRANSCRIPT_LOAD_MORE_EVENTS_FLAG_KEY
  );
  const dataSource = useAgentSessionsDataSource();
  const firstCursor = useMemo(() => {
    const last = session.events.at(-1);
    return last
      ? encodeSessionEventCursor({
          createdAt: last.createdAt,
          externalEventId: last.externalEventId,
        })
      : null;
  }, [session.events]);
  const active =
    enabled &&
    session.eventsTruncated === true &&
    projectionRendered &&
    fileKey === MAIN_TRANSCRIPT_FILE_KEY &&
    dataSource.eventsPage !== undefined &&
    agentSessionSourceSupports(
      dataSource,
      session.id,
      AgentSessionCapability.EventsPage
    ) &&
    firstCursor !== null;

  // Always mounted so the hook order is stable; disabled, it fetches nothing
  // and the placeholder key names a walk nobody starts.
  const walk = useAgentSessionEventsPages({
    sessionId: session.id,
    firstCursor: firstCursor ?? "",
  });
  const { pages, hasMore } = walk;
  const renderedItems = useMemo(() => {
    if (!active || pages.length === 0) {
      return undefined;
    }
    return buildTurnItemsFromEventUnion({
      session,
      pageEvents: pages.flatMap((page) => page.events),
      context,
      ...(hasMore ? { eventsTruncated: true } : {}),
    });
  }, [active, pages, hasMore, session, context]);

  if (!active) {
    return INACTIVE;
  }
  return {
    renderedItems,
    control: {
      hasMore,
      isLoading: walk.isLoading,
      isError: walk.isError,
      loadMore: walk.loadMore,
    },
  };
}
