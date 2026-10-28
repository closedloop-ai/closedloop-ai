import { isUuid } from "@/lib/is-uuid";
import { decodeTimeIdCursor, encodeTimeIdCursor } from "@/lib/time-id-cursor";

/**
 * ISS-9851 — where a token-trend page ended, so the next page can start
 * strictly after it.
 *
 * The read orders `sessionStartedAt desc, agentSessionId asc, id asc`, which
 * keeps one session's rows contiguous (ISS-6887). The cursor is therefore a
 * SESSION position, never a row position: a page always ends on a session it
 * decided whole — emitted, or dropped because it alone exceeds the row
 * ceiling — and the next page resumes after that session, so no session is
 * ever split across two pages.
 */
export type TokenTrendCursor = {
  sessionStartedAtMs: number;
  agentSessionId: string;
};

export function encodeTokenTrendCursor(cursor: TokenTrendCursor): string {
  return encodeTimeIdCursor(cursor.sessionStartedAtMs, cursor.agentSessionId);
}

/**
 * `null` for anything this endpoint did not mint. `agentSessionId` is a uuid
 * column, and a non-uuid string in a Prisma comparison is a query error, so
 * the id's shape is checked here where it can still become a 400.
 */
export function decodeTokenTrendCursor(raw: string): TokenTrendCursor | null {
  const decoded = decodeTimeIdCursor(raw, isUuid);
  if (!decoded) {
    return null;
  }
  return { sessionStartedAtMs: decoded.ms, agentSessionId: decoded.id };
}

/**
 * Every usage row that sorts strictly after `cursor` under the read's order:
 * an older session, or a session that started in the same instant with a
 * greater id.
 */
export function tokenTrendCursorWhere(cursor: TokenTrendCursor) {
  const startedAt = new Date(cursor.sessionStartedAtMs);
  return {
    OR: [
      { session: { sessionStartedAt: { lt: startedAt } } },
      {
        session: { sessionStartedAt: startedAt },
        agentSessionId: { gt: cursor.agentSessionId },
      },
    ],
  };
}
