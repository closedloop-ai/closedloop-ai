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
import { MAX_SYNCED_ACTIVITY_SEGMENTS } from "@repo/api/src/types/agent-session";
import type { SessionEventCounts } from "../agent-sync/agent-session-sync-source.js";
import { toolInvocationPredicate } from "./db-helpers.js";
import { yieldDbHostLoop } from "./db-host/yield-db-host-loop.js";
import type { SqliteEventRow } from "./db-row-types.js";
import type {
  DesktopPrismaReadClient,
  DesktopPrismaReader,
} from "./prisma-client.js";
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
 * would silently starve later sessions of their events entirely.
 *
 * The `LIMIT` is what lets SQLite stop at a bounded top-N. A `ROW_NUMBER()`
 * window cannot: `bounded_rank <= n` does not push into a window subquery, so it
 * ranks the session's WHOLE event set carrying the multi-KB `data` blob — the
 * materialization ISS-5407 added this bound to prevent.
 *
 * The loop is sized for ONE id, because the only caller that sets `eventRowCap`
 * is the single-session detail read; a test pins that rather than trusting this
 * sentence. A second capped caller passing many ids makes this an N+1 — batch it
 * under a per-session bound then, do not widen the loop.
 */
export async function selectEventRows(
  reader: DesktopPrismaReadClient,
  ids: string[],
  eventDataColumn: string,
  eventRowCap?: number
): Promise<SqliteEventRow[]> {
  const projection = eventRowProjection(eventDataColumn);
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

// ISS-9117: the ceiling that classifies a session as "over" for the paged read.
// ISS-9865: over-ceiling sessions are now keyset-paged (not capped at this +1).
export const ACTIVITY_SEGMENT_SYNC_MAX_ROWS = 50_000;

// ISS-9865: the per-chunk page size for keyset-paged over-ceiling reads.
// Matches the cloud wire cap so each page maps to one sync chunk.
export const ACTIVITY_SEGMENT_PAGE_SIZE = MAX_SYNCED_ACTIVITY_SEGMENTS;

// ISS-9865: hard memory-safety ceiling. A tiling PAST this — not AT it — is
// refused by the read, which retains nothing and reports `overflowed`, so the
// db-host thread has a bounded worst case even for a pathological or buggy
// tiling. The session then ships tiling-stripped and OWED (ISS-7265 debt), the
// same shape a chunk-budget strip takes, rather than being acknowledged as a
// complete sync.
export const ACTIVITY_SEGMENT_ABSOLUTE_CEILING = 500_000;

/**
 * ISS-9865: what one batch's activity-segment read actually found — the rows,
 * and the sessions whose tiling it REFUSED at
 * {@link ACTIVITY_SEGMENT_ABSOLUTE_CEILING}.
 *
 * `overflowedSessionIds` is carried rather than re-derived downstream because
 * the two states are no longer distinguishable by row count: a refused session
 * contributes ZERO rows here, exactly like a session with no tiling at all. An
 * assembly that inferred the refusal from `rows.length` would read the refusal
 * as "nothing to send" and acknowledge a silently-dropped tiling as a complete
 * delivery (davetho P1, PR #7099).
 */
export type BoundedActivitySegments = {
  rows: SyncedSegmentQueryRow[];
  overflowedSessionIds: ReadonlySet<string>;
};

/** ISS-9865: one over-ceiling session's paged read: its rows, or its refusal. */
type PagedSessionSegments = {
  rows: SyncedSegmentQueryRow[];
  overflowed: boolean;
};

/**
 * ISS-9865: the three row thresholds the segment read applies. Parameterized for
 * the same reason `requeueOwedActivityTilings`' `chunkSize` is: the REFUSAL at
 * the absolute ceiling is a behaviour a suite has to be able to drive, and
 * seeding half a million rows to reach the production number would make the one
 * test that proves it too slow to keep. Production passes nothing and gets the
 * module constants.
 */
export type ActivitySegmentReadBounds = {
  /** Above this a session leaves the batched read and pays its own paged reads. */
  pagingThreshold: number;
  /** Rows per keyset page. */
  pageSize: number;
  /** Past this the tiling is REFUSED — see {@link BoundedActivitySegments}. */
  absoluteCeiling: number;
};

const DEFAULT_ACTIVITY_SEGMENT_READ_BOUNDS: ActivitySegmentReadBounds = {
  pagingThreshold: ACTIVITY_SEGMENT_SYNC_MAX_ROWS,
  pageSize: ACTIVITY_SEGMENT_PAGE_SIZE,
  absoluteCeiling: ACTIVITY_SEGMENT_ABSOLUTE_CEILING,
};

const ACTIVITY_SEGMENT_SYNC_SELECT = {
  sessionId: true,
  phase: true,
  startMs: true,
  endMs: true,
  confidence: true,
  evidenceLayers: true,
  version: true,
  workItemRef: true,
  subagentId: true,
} as const;

/**
 * Load the activity-segment tiling for a batch of sessions, bounded PER SESSION
 * so no single session can pull an unbounded row set onto the synchronous
 * db-host thread. The bound may NOT be one `take` over a multi-id `IN (...)`
 * read: that caps the TOTAL across the batch and — with rows ordered by
 * sessionId — silently starves later sessions of their segments while returning
 * exactly as many rows as it was asked for.
 *
 * ISS-9117: so it is a CLASSIFY-then-read. Every session at or under the ceiling
 * is read in one batched statement — its whole tiling is by definition within
 * the bound — and only a session ABOVE it pays its own reads.
 *
 * ISS-9865: over-ceiling sessions are now keyset-paged in chunks of
 * {@link ACTIVITY_SEGMENT_PAGE_SIZE} rows using a compound cursor on
 * `(startMs, id)` so each SQLite statement materializes at most one page. The
 * complete tiling is accumulated and returned, then chunked across sync parts by
 * `chunkOversizedSession`. A tiling PAST
 * {@link ACTIVITY_SEGMENT_ABSOLUTE_CEILING} is refused instead — see
 * {@link BoundedActivitySegments} for why the refusal is REPORTED rather than
 * left for a caller to infer from an empty row set.
 *
 * Both the batched read and the paged reads run in ONE read-scoped
 * `$transaction`, which pins a committed snapshot — a rebuild committing
 * mid-flight lands outside the snapshot entirely. The FEA-2264 yields the pager
 * takes between pages do not break that: they hand the store thread's loop a
 * turn, and the snapshot the transaction holds outlives them.
 */
export async function selectBoundedActivitySegments(
  reader: DesktopPrismaReadClient,
  ids: string[],
  bounds: ActivitySegmentReadBounds | undefined = undefined
): Promise<BoundedActivitySegments> {
  const readBounds = bounds ?? DEFAULT_ACTIVITY_SEGMENT_READ_BOUNDS;
  if (ids.length === 0) {
    return { rows: [], overflowedSessionIds: new Set() };
  }
  const overflowedSessionIds = new Set<string>();
  const rowsBySessionId = await reader.$transaction(async (tx) => {
    const aboveCeiling = await selectOverCeilingSessionIds(
      tx,
      ids,
      readBounds.pagingThreshold
    );
    const withinCeiling = ids.filter((id) => !aboveCeiling.has(id));
    const grouped = new Map<string, SyncedSegmentQueryRow[]>();
    if (withinCeiling.length > 0) {
      // Ordered by (sessionId, startMs) so the read stays on
      // `idx_session_activity_segments_session_start` and each session's rows
      // arrive in the same order its own `take` read produced.
      const batched = await tx.sessionActivitySegment.findMany({
        where: { sessionId: { in: withinCeiling } },
        select: ACTIVITY_SEGMENT_SYNC_SELECT,
        orderBy: [{ sessionId: "asc" }, { startMs: "asc" }],
      });
      for (const row of batched) {
        const existing = grouped.get(row.sessionId);
        if (existing) {
          existing.push(row);
        } else {
          grouped.set(row.sessionId, [row]);
        }
      }
    }
    for (const sessionId of aboveCeiling) {
      const paged = await pageSessionSegments(tx, sessionId, readBounds);
      if (paged.overflowed) {
        overflowedSessionIds.add(sessionId);
        continue;
      }
      grouped.set(sessionId, paged.rows);
    }
    return grouped;
  });
  const segmentRows: SyncedSegmentQueryRow[] = [];
  for (const id of ids) {
    const rows = rowsBySessionId.get(id);
    if (!rows) {
      continue;
    }
    for (const row of rows) {
      segmentRows.push(row);
    }
  }
  return { rows: segmentRows, overflowedSessionIds };
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
  reader: DesktopPrismaReader,
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

/**
 * ISS-9117: which of `ids` hold MORE segments than the memory-safety ceiling, in
 * one statement whose work is bounded per session.
 *
 * This is a SENTINEL read, not a count. `COUNT(*)` has to walk every matching
 * row to answer, so a session with millions of segments would block the
 * synchronous db-host thread just to learn it is over 50,000 — and then still
 * pay the capped read. Asking instead whether row `MAX_ROWS` (0-based) EXISTS
 * stops the index scan at 50,001 entries, exactly where the per-session `take`
 * this batching replaced stopped, and it answers the only question the caller
 * has. The scalar subquery is `LIMIT 1 OFFSET`, not `EXISTS`, because a scalar
 * subquery's `LIMIT`/`OFFSET` is unambiguously honored.
 *
 * The ids arrive as ONE json array parameter rather than an `IN (...)` list so
 * they can drive the query as a rowset: a multi-row `VALUES` clause is a
 * compound SELECT in SQLite and would fault above `SQLITE_MAX_COMPOUND_SELECT`
 * (500) — well under the 5,000-id `SESSION_HYDRATION_WINDOW` this read serves.
 * Driving from the ids is also what keeps the plan off a table scan: it seeks
 * `idx_session_activity_segments_session_start` once per id.
 */
async function selectOverCeilingSessionIds(
  tx: DesktopPrismaReader,
  ids: string[],
  pagingThreshold: number
): Promise<Set<string>> {
  // Interpolated, not bound: SQLite does not accept a parameter in a scalar
  // subquery's OFFSET. The value is a number this module owns, never caller
  // input, and `Math.trunc` keeps it one even if a caller passes a float.
  const offset = Math.max(0, Math.trunc(pagingThreshold));
  const rows = await tx.$queryRawUnsafe<{ session_id: string }[]>(
    `
      WITH ids(session_id) AS (SELECT value FROM json_each($1))
      SELECT i.session_id AS session_id
      FROM ids i
      WHERE (
        SELECT s.id
        FROM session_activity_segments s
        WHERE s.session_id = i.session_id
        ORDER BY s.start_ms
        LIMIT 1 OFFSET ${offset}
      ) IS NOT NULL
    `,
    JSON.stringify(ids)
  );
  return new Set(rows.map((row) => row.session_id));
}

/**
 * The `events` columns a detail-shaped read projects, in the order
 * `SqliteEventRow` names them. Shared with the ISS-9857 keyset page
 * (`session-event-page-read.ts`) so a page row and a prefix row cannot drift
 * to different column sets.
 */
export function eventRowProjection(eventDataColumn: string): string {
  return `
        id,
        session_id,
        agent_id,
        event_type,
        tool_name,
        summary,
        ${eventDataColumn},
        created_at`;
}

/**
 * ISS-9865: keyset-page one over-ceiling session's activity segments in chunks
 * of {@link ACTIVITY_SEGMENT_PAGE_SIZE} using a compound cursor on
 * `(startMs, id)`.
 *
 * THE COMPOUND KEY IS A READ-CORRECTNESS GUARD, NOT A CLAIM ABOUT WHAT THE
 * CLOUD STORES (whitlockk, PR #7099). The local table indexes `(sessionId, startMs)`
 * and does NOT make it unique, so duplicate starts are physically representable
 * here — and a cursor on `startMs` alone skips every row that shares the page
 * boundary's start. The CLOUD is the opposite: `validateActivityTiling`
 * (`apps/api/.../activity-segment-persistence.ts`) rejects the whole tiling as
 * `segment_overlap` when a row starts before the previous one ends, which a
 * duplicate start always does. So a local duplicate cannot persist, and the
 * earlier version of this comment was wrong to cite the subagent/parent case as
 * one that does. What the compound key buys is that such a tiling is read WHOLE
 * and refused by the cloud with a stated reason, instead of being silently
 * short-read here and shipped as a plausible partial.
 *
 * OVERFLOW IS DECIDED BEFORE THE ROWS ARE RETAINED (davetho P1, PR #7099).
 * The final page asks for exactly ONE row past
 * {@link ACTIVITY_SEGMENT_ABSOLUTE_CEILING}, so a tiling of exactly the ceiling
 * is COMPLETE and ships, and a proven overflow drops every row it accumulated
 * rather than carrying ~500k rows through `mapSyncedActivitySegment` and into a
 * payload the assembly then omits. The caller gets `overflowed` as a fact from
 * the read, never re-derived from a row count that no longer distinguishes the
 * two.
 */
async function pageSessionSegments(
  tx: DesktopPrismaReader,
  sessionId: string,
  bounds: ActivitySegmentReadBounds
): Promise<PagedSessionSegments> {
  const pagedSelect = { ...ACTIVITY_SEGMENT_SYNC_SELECT, id: true };
  let rows: SyncedSegmentQueryRow[] = [];
  let cursorStartMs: bigint | undefined;
  let cursorId: string | undefined;
  for (;;) {
    // One row past the ceiling at most: the probe that distinguishes a tiling
    // AT the ceiling (complete) from one PAST it (overflow), without ever
    // materializing a whole extra page beyond the bound.
    const take = Math.min(
      bounds.pageSize,
      bounds.absoluteCeiling - rows.length + 1
    );
    const page = await tx.sessionActivitySegment.findMany({
      where: {
        sessionId,
        ...(cursorStartMs === undefined
          ? {}
          : {
              OR: [
                { startMs: { gt: cursorStartMs } },
                {
                  AND: [{ startMs: cursorStartMs }, { id: { gt: cursorId! } }],
                },
              ],
            }),
      },
      select: pagedSelect,
      orderBy: [{ startMs: "asc" }, { id: "asc" }],
      take,
    });
    for (const row of page) {
      rows.push(row);
    }
    if (rows.length > bounds.absoluteCeiling) {
      // Proven overflow. Drop the accumulated set HERE, at the only frame that
      // still holds the sole reference to it: every later frame would copy it
      // before discarding it.
      rows = [];
      return { rows, overflowed: true };
    }
    if (page.length < take) {
      break;
    }
    const last = page.at(-1)!;
    cursorStartMs = last.startMs;
    cursorId = last.id;
    // FEA-2264: give the store thread a real loop turn between full pages, so a
    // ceiling-sized tiling does not hold it for 100 synchronous statements while
    // queued renderer reads wait the whole tiling out (whitlockk, PR #7099). libSQL
    // is synchronous on this single JS thread, so without a macrotask boundary
    // nothing else runs. The read `$transaction` pins one committed snapshot
    // across the yield, exactly as the analytics breakdowns do.
    await yieldDbHostLoop();
  }
  return { rows, overflowed: false };
}
