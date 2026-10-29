import {
  encodeSessionEventCursor,
  type SessionEventCursor,
} from "@repo/api/src/types/agent-session-event-cursor";
import {
  type AgentSessionEventsPage,
  SESSION_EVENTS_PAGE_LIMIT_BOUNDS,
} from "@repo/api/src/types/agent-session-events-page";
import { clampPageLimit } from "@repo/api/src/types/page-limit-bounds";
import { withDb } from "@repo/database";
import { toSyncedDetailEvent } from "./synced-payload";

/**
 * ISS-9857 (PRD-666): one keyset page of a session's raw event stream, the
 * read behind `GET /agent-sessions/[id]/events`. The detail read keeps serving
 * its bounded prefix; this is how a client reaches event 10,001 and beyond.
 *
 * Ordered by `(eventCreatedAt, externalEventId)` — TWO keys where the detail
 * select in `records.ts` orders by three. Its third key, `id`, is unreachable:
 * `@@unique([agentSessionId, externalEventId])` means no two rows of one
 * session share an `externalEventId`, so the second key already decides every
 * tie. Two keys is therefore the same total order, and it is the order the
 * cursor can carry, because a client mints the first cursor from a served
 * event, which has no `id`.
 *
 * The org gate is a SEPARATE statement from the page on purpose. The
 * single-query relation predicate `readSessionTokenEvents` uses (an
 * `artifact.organizationId` clause on the events query) answers a foreign
 * session and an exhausted one with the same empty array, and this route owes
 * a 404 for the first, so the session's membership is decided first and the
 * page is read only for a session the caller may see.
 *
 * Reads one row past `limit` so the probe row, not a count, decides whether a
 * continuation exists. Declaring `nextCursor` in this module is what exempts
 * that `take: limit + 1` from the `no-terminal-cap` and
 * `no-terminal-cap-threaded` source gates: the bound is a request-scoped page
 * size with a continuation the caller can follow, not a terminal ceiling.
 */
export async function readAgentSessionEventsPage(input: {
  organizationId: string;
  id: string;
  cursor?: SessionEventCursor;
  limit?: number;
}): Promise<AgentSessionEventsPage | null> {
  const owned = await withDb((db) =>
    db.sessionDetail.findFirst({
      where: {
        artifactId: input.id,
        artifact: { is: { organizationId: input.organizationId } },
      },
      select: { artifactId: true },
    })
  );
  if (!owned) {
    return null;
  }

  const limit = clampPageLimit(input.limit, SESSION_EVENTS_PAGE_LIMIT_BOUNDS);
  const rows = await withDb((db) =>
    db.agentSessionEvent.findMany({
      where: {
        agentSessionId: input.id,
        ...(input.cursor ? sessionEventCursorWhere(input.cursor) : {}),
      },
      select: {
        externalEventId: true,
        agentExternalId: true,
        eventType: true,
        toolName: true,
        eventCreatedAt: true,
      },
      orderBy: [{ eventCreatedAt: "asc" }, { externalEventId: "asc" }],
      take: limit + 1,
    })
  );

  const events = rows.slice(0, limit).map(toSyncedDetailEvent);
  const last = events.at(-1);
  const nextCursor =
    rows.length > limit && last
      ? encodeSessionEventCursor({
          createdAt: last.createdAt,
          externalEventId: last.externalEventId,
        })
      : null;
  return {
    events,
    ...(nextCursor === null ? {} : { nextCursor }),
  };
}

/**
 * Every event that sorts strictly after `cursor` under the read's order: a
 * later timestamp, or the same instant with a greater `externalEventId`.
 */
function sessionEventCursorWhere(cursor: SessionEventCursor) {
  const at = new Date(cursor.createdAt);
  return {
    OR: [
      { eventCreatedAt: { gt: at } },
      { eventCreatedAt: at, externalEventId: { gt: cursor.externalEventId } },
    ],
  };
}
