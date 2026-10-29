/**
 * @file session-event-page-read.ts
 * @description ISS-9857: one keyset page of a session's raw `events` rows past
 * the detail read's bounded prefix — the desktop twin of the cloud's
 * `GET /agent-sessions/[id]/events`.
 *
 * The bound is pushed into SQL as `LIMIT limit + 1`. ISS-5407's heap-capped
 * db-host hazard was the UNBOUNDED read carrying the multi-KB `data` blob; a
 * page of at most `SESSION_EVENTS_PAGE_LIMIT_BOUNDS.maxLimit` (2,000) rows with
 * `data` is smaller than the 10,001-row read the detail itself already makes.
 *
 * The keyset is `(created_at, id)`, the SAME order `selectEventRows` serves the
 * prefix in (`ORDER BY created_at ASC, id ASC`), so the first page after the
 * prefix starts exactly where the prefix stopped. `created_at` is nullable text
 * at runtime (typed `string` in `db-row-types.ts`): NULL rows sort first in
 * SQLite, so they always fall inside the prefix and a cursored page never
 * starts on one. Rows are mapped exactly as the sync source maps a detail row
 * (`sync-source.ts`, `events:`), so a page row and a prefix row are the same
 * shape to the renderer.
 *
 * Composed into `createSqliteSessionSyncSource` through
 * {@link createSessionEventPageReader}, the `createSessionDetailLinkReaders`
 * pattern, so the grandfathered `sync-source.ts` carries the wiring only.
 */

import {
  encodeSessionEventCursor,
  type SessionEventCursor,
} from "@repo/api/src/types/agent-session-event-cursor";
import type { AgentSessionEventsPage } from "@repo/api/src/types/agent-session-events-page";
import { parseJsonValueText } from "../agent-sync/agent-sync-json-text.js";
import type { SqliteEventRow } from "./db-row-types.js";
import type { DesktopPrisma } from "./prisma-client.js";
import { eventRowProjection } from "./sync-source-bounded-reads.js";

export type SessionEventPageRequest = {
  sessionId: string;
  /** The keyset position to page strictly AFTER; absent = from the first row. */
  after?: SessionEventCursor;
  /** Rows to serve; the caller has already clamped it to the shared bounds. */
  limit: number;
};

/**
 * `null` when no `sessions` row carries `sessionId` — the same fail-closed
 * answer the detail read gives, so an unknown id and a disabled runtime read
 * alike as not-found. A known session with no rows past the cursor answers
 * `{ events: [] }` with no `nextCursor`, which is the contract's only encoding
 * of "last page".
 *
 * `nextCursor` is minted from the LAST SERVED row, and only when the probe row
 * (the `+ 1`) came back AND the codec accepts the position. A served row with a
 * NULL `created_at` cannot mint one — `encodeSessionEventCursor` returns `null`
 * for an empty timestamp — so the key is omitted and the client offers no
 * continuation rather than a wrong one.
 */
export async function readSessionEventPage(
  prisma: DesktopPrisma,
  input: SessionEventPageRequest
): Promise<AgentSessionEventsPage | null> {
  const { sessionId, after, limit } = input;
  if (!(Number.isSafeInteger(limit) && limit > 0)) {
    throw new RangeError(
      `session event page limit must be a positive integer, got ${String(limit)}`
    );
  }
  const rows = await prisma.read(async (reader) => {
    const sessionRows = await reader.$queryRawUnsafe<{ id: string }[]>(
      "SELECT id FROM sessions WHERE id = $1 LIMIT 1",
      sessionId
    );
    if (sessionRows.length === 0) {
      return null;
    }
    const fetchLimit = limit + 1;
    const projection = eventRowProjection("data");
    // Byte order on purpose, and the same byte order `selectEventRows` serves
    // the detail prefix in: this page CONTINUES that read, and a cursor is a
    // position in that order (minted from a served row, replayed verbatim), so
    // the two statements must sort identically or the boundary row is skipped
    // or repeated. Canonicalising here alone would put the page in a different
    // order from the prefix it extends; when the burn-down owner (ISS-11317)
    // re-ranks the prefix read, this statement and its keyset predicate move
    // with it. Not ISS-7450: that ticket REGISTERED the rule and seeded the
    // allowlist entry, and says burning it down is separate work. Not ISS-11106
    // either: it adjudicated one site and handed the rest to ISS-11317.
    if (after) {
      // lexical-timestamp-ok: the order contract is `selectEventRows`' own
      // (sync-source-bounded-reads.ts, its seeded no-lexical-timestamp-aggregate
      // entry) and the cursor operands are bind parameters copied from rows that
      // read served in that order, never a stored value compared across forms.
      return reader.$queryRawUnsafe<SqliteEventRow[]>(
        `
        SELECT${projection}
        FROM events
        WHERE session_id = $1
          AND (created_at > $2 OR (created_at = $2 AND id > $3))
        ORDER BY created_at ASC, id ASC
        LIMIT $4
        `,
        sessionId,
        after.createdAt,
        after.externalEventId,
        fetchLimit
      );
    }
    // lexical-timestamp-ok: same order contract as the cursored statement above
    // — the first page must start where `selectEventRows`' prefix starts.
    return reader.$queryRawUnsafe<SqliteEventRow[]>(
      `
      SELECT${projection}
      FROM events
      WHERE session_id = $1
      ORDER BY created_at ASC, id ASC
      LIMIT $2
      `,
      sessionId,
      fetchLimit
    );
  });
  if (rows === null) {
    return null;
  }
  const served = rows.slice(0, limit);
  const events = served.map((row) => ({
    externalEventId: String(row.id),
    agentExternalId: row.agent_id,
    eventType: row.event_type,
    toolName: row.tool_name,
    summary: row.summary,
    data: parseJsonValueText(row.data),
    createdAt: row.created_at,
  }));
  const last = served.at(-1);
  const nextCursor =
    rows.length > limit && last
      ? encodeSessionEventCursor({
          createdAt: last.created_at ?? "",
          externalEventId: String(last.id),
        })
      : null;
  return {
    events,
    ...(nextCursor === null ? {} : { nextCursor }),
  };
}

/** The `loadSessionEventPage` member of the SQLite sync source. */
export function createSessionEventPageReader(prisma: DesktopPrisma): {
  loadSessionEventPage: (
    input: SessionEventPageRequest
  ) => Promise<AgentSessionEventsPage | null>;
} {
  return {
    loadSessionEventPage: (input: SessionEventPageRequest) =>
      readSessionEventPage(prisma, input),
  };
}
