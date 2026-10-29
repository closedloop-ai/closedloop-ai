import type { SyncedAgentSessionEvent } from "./agent-session.ts";
import type { PageLimitBounds } from "./page-limit-bounds.ts";

/**
 * ISS-9857 (PRD-666): one keyset page of a session's raw event stream, served
 * by `GET /agent-sessions/[id]/events` on the cloud and by the
 * `desktop:shared-agent-sessions:events` IPC channel on the desktop. The
 * session detail keeps serving its bounded prefix (`AgentSessionDetail.events`
 * plus `eventsTruncated`); this page is how a client reaches event 10,001 and
 * beyond, one page at a time, in the SAME `(createdAt, externalEventId)` order
 * the prefix uses — so the first page after the prefix starts exactly where the
 * prefix stopped.
 *
 * `nextCursor` is present only when the store holds a row past this page;
 * ABSENCE is the only encoding of "this was the last page", so a producer that
 * predates the field reads as exhausted rather than as a third state.
 */
export type AgentSessionEventsPage = {
  events: SyncedAgentSessionEvent[];
  /** Opaque; replay it verbatim as the next request's `cursor`. */
  nextCursor?: string;
};

/** The request both producers accept. `cursor` absent = from the first row. */
export type AgentSessionEventsPageRequest = {
  id: string;
  cursor?: string;
  limit?: number;
};

/**
 * Page-size bounds for the events page, shared by both producers so a page is
 * the same size whichever surface served it. The default is well under the
 * detail prefix (10,000) — a click loads a screenful, not another detail's
 * worth — and the ceiling keeps one desktop page (which carries the per-event
 * `data` blob) far below the prefix the detail read already materializes.
 */
export const SESSION_EVENTS_PAGE_LIMIT_BOUNDS: PageLimitBounds = {
  defaultLimit: 1000,
  maxLimit: 2000,
};
