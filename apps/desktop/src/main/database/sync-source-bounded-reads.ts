/**
 * @file sync-source-bounded-reads.ts
 * @description The per-session BOUNDED hydration reads for the synced-session
 * loader. Each one caps what a single session can pull onto the synchronous,
 * heap-capped db-host thread, and each applies its bound PER SESSION rather than
 * as one `LIMIT`/`take` over a multi-id `IN (...)` read — which would cap the
 * TOTAL across the batch and, with rows ordered by session id, silently starve
 * later sessions of their rows entirely.
 *
 * Split out of `sync-source.ts` (a grandfathered over-ceiling module) by
 * ISS-5407, which added the second such read.
 */
import { ERROR_EVENT_TERMS } from "@repo/api/src/agent-session-events";
import type { SessionEventCounts } from "../agent-sync/agent-session-sync-source.js";
import { toolInvocationPredicate } from "./db-helpers.js";
import type { SqliteEventRow } from "./db-row-types.js";
import type { DesktopPrismaReadClient } from "./prisma-client.js";
import { selectRowsByIds } from "./session-detail-mappers.js";

/**
 * ISS-5407: the row limit an `eventRowCap` actually imposes, or `undefined` when
 * the read stays UNBOUNDED.
 *
 * A cap that is not a whole number >= 0 degrades to the unbounded read, not to
 * some clamped `LIMIT`. Truncation is encoded by ABSENCE, so a fallback that
 * served fewer rows than the caller's ceiling would report a one-row prefix as a
 * COMPLETE stream — the exact lie this bound exists to prevent. Unbounded is the
 * pre-ISS-5407 behavior: it costs memory, but it cannot lie.
 *
 * Exported because the caller must ask the SAME question the read asked — "was
 * this read bounded?" — when it decides which of the session's event-DERIVED
 * fields may still be folded from these rows. Two parallel predicates would
 * drift, and the drift would be silent.
 */
export function resolveEventRowFetchLimit(
  eventRowCap?: number
): number | undefined {
  if (
    eventRowCap === undefined ||
    !Number.isInteger(eventRowCap) ||
    eventRowCap < 0
  ) {
    return undefined;
  }
  return eventRowCap + 1;
}

/**
 * ISS-5407: the hydration read for a batch's raw `events` rows, optionally
 * bounded PER SESSION at `eventRowCap + 1` rows (one PAST the ceiling, the
 * ISS-5075 idiom, so the caller can DETECT a read that hit the bound).
 *
 * `eventDataColumn` is the caller's already-resolved `data` projection — the
 * literal column, or `NULL AS data` on the FEA-2038 omit path — so the row shape
 * is identical either way.
 *
 * The bound is applied per session with its own `LIMIT`, mirroring
 * `selectBoundedActivitySegments`: one `LIMIT` on a multi-id `IN (...)` query
 * caps the TOTAL across the batch and — with rows ordered by `session_id` —
 * would silently starve later sessions of their events entirely. Only the
 * single-session detail read sets a cap today, so the extra round-trips are
 * bounded by the batch size and cost nothing on the uncapped lanes, which keep
 * the original one-statement read.
 */
export async function selectEventRows(
  reader: DesktopPrismaReadClient,
  ids: string[],
  eventDataColumn: string,
  eventRowCap?: number
): Promise<SqliteEventRow[]> {
  const projection = `
        id,
        session_id,
        agent_id,
        event_type,
        tool_name,
        summary,
        ${eventDataColumn},
        created_at`;
  const fetchLimit = resolveEventRowFetchLimit(eventRowCap);
  if (fetchLimit === undefined) {
    return selectRowsByIds<SqliteEventRow>(
      reader,
      `
      SELECT${projection}
      FROM events
      WHERE session_id IN (__IDS__)
      ORDER BY session_id ASC, created_at ASC, id ASC
    `,
      ids
    );
  }
  const rows: SqliteEventRow[] = [];
  for (const sessionId of ids) {
    const sessionRows = await selectRowsByIds<SqliteEventRow>(
      reader,
      `
      SELECT${projection}
      FROM events
      WHERE session_id IN (__IDS__)
      ORDER BY created_at ASC, id ASC
      LIMIT ${fetchLimit}
    `,
      [sessionId]
    );
    for (const row of sessionRows) {
      rows.push(row);
    }
  }
  return rows;
}

/** FEA-3568: one persisted activity-segment row loaded for the sync payload. */
export type SyncedSegmentQueryRow = {
  sessionId: string;
  phase: string;
  startMs: bigint;
  endMs: bigint;
  confidence: number;
  evidenceLayers: unknown;
  version: number;
  workItemRef: string | null;
  subagentId: string | null;
};

// ISS-4541: load the FULL per-session tiling so it can be CHUNKED across sync
// parts (see chunkOversizedSession) instead of truncated to a single payload —
// the transport byte cap is no longer a data cap. This is still bounded per
// session (a pathological tiling can't pull an unbounded row set onto the
// synchronous db-host thread), but the ceiling is a memory-safety backstop set
// far above any realistic tiling (p99 ~1051 segments; the old row cap was
// 5000), NOT the transport cap. A tiling that somehow hits the ceiling is
// logged at assembly time — visible, never a silent drop. `+ 1` lets the
// assembly detect the (extraordinarily pathological) overflow the same way the
// old cap-based load did.
export const ACTIVITY_SEGMENT_SYNC_MAX_ROWS = 50_000;
const ACTIVITY_SEGMENT_SYNC_FETCH_LIMIT = ACTIVITY_SEGMENT_SYNC_MAX_ROWS + 1;

/**
 * Load the activity-segment tiling for a batch of sessions, bounded PER SESSION
 * so no single session can pull an unbounded row set onto the synchronous
 * db-host thread. Each session is queried independently with its own `take`
 * (index-covered by `idx_session_activity_segments_session_start`), because a
 * single `take` on a multi-id `IN (...)` query would cap the TOTAL rows across
 * the batch and — with rows ordered by sessionId — silently starve later
 * sessions of their segments. Sessions in the batch are few (<= the sync batch
 * size), so the extra round-trips are cheap relative to the load they replace.
 */
export async function selectBoundedActivitySegments(
  reader: DesktopPrismaReadClient,
  ids: string[]
): Promise<SyncedSegmentQueryRow[]> {
  const segmentRows: SyncedSegmentQueryRow[] = [];
  for (const sessionId of ids) {
    const rows = await reader.sessionActivitySegment.findMany({
      where: { sessionId },
      select: {
        sessionId: true,
        phase: true,
        startMs: true,
        endMs: true,
        confidence: true,
        evidenceLayers: true,
        version: true,
        workItemRef: true,
        subagentId: true,
      },
      orderBy: { startMs: "asc" },
      take: ACTIVITY_SEGMENT_SYNC_FETCH_LIMIT,
    });
    for (const row of rows) {
      segmentRows.push(row);
    }
  }
  return segmentRows;
}

/**
 * ISS-5407 (stage review): the WHOLE-RUN event counts for a session, computed by
 * the database rather than folded from the loaded rows.
 *
 * The detail read is bounded, so folding `toolUseCount`/`errorCount` over the
 * rows it loaded would answer for the PREFIX. Those two numbers render as bare
 * stats on the detail ("N tool calls", the Errors stat) with no truncation
 * qualifier, and the SAME session's row in the Sessions list folds them over the
 * full stream — so a prefix fold would put two different whole-run claims about
 * one session on two screens of one app, and disagree with web besides (the
 * cloud detail reads persisted count columns, which the cap never touches).
 * Aggregating in SQL keeps them on an unbounded basis without materializing an
 * unbounded row set: the result is one row per session whatever the stream size.
 *
 * The predicates are the SQL twins of `countToolUseEvents`
 * (`Boolean(event.toolName)`) and `countErrorEvents`
 * (`ERROR_EVENT_PATTERN.test(event.eventType)`). The error terms are read from
 * {@link ERROR_EVENT_TERMS} — the module that owns them names a SQL `LIKE` built
 * from those substrings as the sanctioned way to keep the two classifications
 * from drifting — and SQLite's `LIKE` is ASCII-case-insensitive, matching the
 * regex's `i` flag. The terms are module-owned ASCII literals, never caller
 * input, so interpolating them carries no injection surface; the session ids
 * still bind as parameters.
 */
export async function selectSessionEventCounts(
  reader: DesktopPrismaReadClient,
  ids: string[]
): Promise<Map<string, SessionEventCounts>> {
  const counts = new Map<string, SessionEventCounts>();
  if (ids.length === 0) {
    return counts;
  }
  const errorPredicate = ERROR_EVENT_TERMS.map(
    (term) => `event_type LIKE '%${term}%'`
  ).join(" OR ");
  const rows = await selectRowsByIds<SessionEventCountRow>(
    reader,
    `
      SELECT
        session_id,
        SUM(CASE WHEN ${toolInvocationPredicate("tool_name")} THEN 1 ELSE 0 END) AS tool_use_count,
        SUM(CASE WHEN ${errorPredicate} THEN 1 ELSE 0 END) AS error_count
      FROM events
      WHERE session_id IN (__IDS__)
      GROUP BY session_id
    `,
    ids
  );
  for (const row of rows) {
    counts.set(row.session_id, {
      toolUseCount: Number(row.tool_use_count ?? 0),
      errorCount: Number(row.error_count ?? 0),
    });
  }
  return counts;
}

type SessionEventCountRow = {
  session_id: string;
  tool_use_count: number | bigint | null;
  error_count: number | bigint | null;
};
