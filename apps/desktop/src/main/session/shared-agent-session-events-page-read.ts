/**
 * @file shared-agent-session-events-page-read.ts
 * @description ISS-9857: the `desktop:shared-agent-sessions:events` handler
 * body — read the renderer's request (reduced to a record by
 * `coerceSharedQuery`; ISS-9428 moved the sibling list/usage/analytics/pageData
 * channels onto a Zod request schema, which this one has not followed), decode
 * the cursor, clamp
 * the limit with the SAME bounds the cloud route applies, and hand the page
 * read to the sync source.
 *
 * `null` is the ONE fail-closed answer, and it is deliberate that every refusal
 * here collapses onto it: an unknown session, a source that cannot page, and a
 * cursor that does not decode all read `null`. The renderer's local source
 * (`local-agent-sessions-data-source.ts`) maps `null` to a 404 `ApiError`, so
 * on the desktop a malformed cursor reads as not-found where the cloud route
 * answers 400. Acceptable because the client only ever replays cursors a
 * producer minted (the first from the detail prefix's last row, the rest from
 * a page's `nextCursor`), so a cursor that fails to decode is not a user error
 * to explain — it is a contract breach, and refusing to page is the right
 * response to one. Deliberate so this module never grows a second, differently
 * shaped refusal the renderer would have to learn.
 */

import {
  decodeSessionEventCursor,
  type SessionEventCursor,
} from "@repo/api/src/types/agent-session-event-cursor";
import type { AgentSessionEventsPage } from "@repo/api/src/types/agent-session-events-page";
import { SESSION_EVENTS_PAGE_LIMIT_BOUNDS } from "@repo/api/src/types/agent-session-events-page";
import { clampPageLimit } from "@repo/api/src/types/page-limit-bounds";
import type { AgentSessionSyncSource } from "../agent-sync/agent-session-sync-source.js";
import { coerceNonEmptyString } from "./shared-agent-sessions-query.js";

export async function getSharedAgentSessionEventsPage(
  source: AgentSessionSyncSource | null | undefined,
  request: Record<string, unknown>
): Promise<AgentSessionEventsPage | null> {
  const coerced = coerceEventsPageRequest(request);
  if (coerced === null) {
    return null;
  }
  if (!source?.loadSessionEventPage) {
    return null;
  }
  // Invoked as a member, never detached: across the db-host boundary `source`
  // is a Proxy that dispatches on the property access itself.
  const page = await source.loadSessionEventPage({
    sessionId: coerced.sessionId,
    ...(coerced.after ? { after: coerced.after } : {}),
    limit: coerced.limit,
  });
  return page ?? null;
}

type CoercedEventsPageRequest = {
  sessionId: string;
  after?: SessionEventCursor;
  limit: number;
};

/**
 * `null` for a request with no usable session id or a cursor that is present
 * but does not decode. A present-but-empty cursor string is "absent" to the
 * codec (`decodeSessionEventCursor("")` is `null`), so it is refused here too
 * rather than silently restarting the page walk from the first row.
 */
function coerceEventsPageRequest(
  record: Record<string, unknown>
): CoercedEventsPageRequest | null {
  const sessionId = coerceNonEmptyString(record.id);
  if (sessionId === null) {
    return null;
  }
  // A non-number limit is "not asked" and gets the default. The cloud route
  // answers a present-but-blank `?limit=` with a 400 instead; the renderer's
  // typed request (`limit?: number`) cannot send one here, so the two do not
  // disagree on any request a shipped client makes.
  const rawLimit = typeof record.limit === "number" ? record.limit : undefined;
  const limit = clampPageLimit(rawLimit, SESSION_EVENTS_PAGE_LIMIT_BOUNDS);
  if (record.cursor === undefined || record.cursor === null) {
    return { sessionId, limit };
  }
  const after = decodeSessionEventCursor(
    typeof record.cursor === "string" ? record.cursor : null
  );
  if (after === null) {
    return null;
  }
  return { sessionId, after, limit };
}
