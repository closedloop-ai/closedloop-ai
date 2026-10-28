import type { SqliteEventRow, SqliteTokenEventRow } from "./db-row-types.js";
import type { DesktopPrismaReader } from "./prisma-client.js";
import { CANONICAL_UTC_TIMESTAMP_GLOB_SQL } from "./session-timestamp-form.js";

const STREAM_PAGE_ROWS = 512;

type TokenEventScanRow = SqliteTokenEventRow & {
  scan_rowid: number | bigint;
};

export type TokenEventPageCursor = {
  createdAt: string;
  model: string;
  rowId: number | bigint;
  transportId: string | null;
};

export type TokenEventPageStatement = {
  params: unknown[];
  sql: string;
};

const TOKEN_EVENT_PAGE_SELECT = `SELECT rowid AS scan_rowid, session_id,
  transport_id, model, created_at, input_tokens, output_tokens,
  cache_read_tokens, cache_write_tokens, cache_write_5m_tokens,
  cache_write_1h_tokens, cost_usd_estimated, input_cost_usd_estimated,
  output_cost_usd_estimated, cache_read_cost_usd_estimated,
  cache_creation_cost_usd_estimated
FROM token_events`;

/** Page event rows by their persisted stable order without retaining a session. */
export async function* eventPages(
  reader: DesktopPrismaReader,
  sessionId: string
): AsyncGenerator<SqliteEventRow[]> {
  let cursor: { createdAt: string | null; id: string } | null = null;
  while (true) {
    const rows = await readEventPage(reader, sessionId, cursor);
    if (rows.length === 0) {
      return;
    }
    yield rows;
    const last = rows.at(-1);
    if (!last) {
      return;
    }
    cursor = { createdAt: last.created_at ?? null, id: last.id };
  }
}

/** Page events in the canonical trace timeline order. */
export async function* timelineEventPages(
  reader: DesktopPrismaReader,
  sessionId: string
): AsyncGenerator<SqliteEventRow[]> {
  let afterTimestamp: string | null = null;
  while (true) {
    const rows: SqliteEventRow[] =
      afterTimestamp === null
        ? await reader.$queryRawUnsafe<SqliteEventRow[]>(
            // lexical-timestamp-ok: the first pass in this same read snapshot
            // proved every event uses the fixed-width canonical UTC form.
            `SELECT id, session_id, agent_id, event_type, tool_name, summary,
                    NULL AS data, created_at
               FROM events
              WHERE session_id = $1
              ORDER BY created_at ASC, id ASC
              LIMIT $2`,
            sessionId,
            STREAM_PAGE_ROWS
          )
        : await reader.$queryRawUnsafe<SqliteEventRow[]>(
            // lexical-timestamp-ok: the first pass in this same read snapshot
            // proved every event uses the fixed-width canonical UTC form.
            `SELECT id, session_id, agent_id, event_type, tool_name, summary,
                    NULL AS data, created_at
               FROM events
              WHERE session_id = $1 AND created_at > $2
              ORDER BY created_at ASC, id ASC
              LIMIT $3`,
            sessionId,
            afterTimestamp,
            STREAM_PAGE_ROWS
          );
    if (rows.length === 0) {
      return;
    }
    const boundaryTimestamp: string | undefined = rows.at(-1)?.created_at;
    if (!boundaryTimestamp) {
      return;
    }
    const prefix = rows
      .filter((row) => row.created_at !== boundaryTimestamp)
      .sort(compareCanonicalTimelineEvents);
    if (prefix.length > 0) {
      yield prefix;
    }
    yield* equalTimestampEventPages(reader, sessionId, boundaryTimestamp);
    afterTimestamp = boundaryTimestamp;
  }
}

/** Page token events by the canonical stable order with `rowid` as a final tie. */
export async function* tokenEventPages(
  reader: DesktopPrismaReader,
  sessionId: string
): AsyncGenerator<SqliteTokenEventRow[]> {
  let cursor: {
    createdAt: string;
    model: string;
    rowId: number | bigint;
    transportId: string | null;
  } | null = null;
  while (true) {
    const rows = await readTokenEventPage(reader, sessionId, cursor);
    if (rows.length === 0) {
      return;
    }
    yield rows;
    const last = rows.at(-1);
    if (!last) {
      return;
    }
    cursor = {
      createdAt: last.created_at,
      model: last.model,
      rowId: last.scan_rowid,
      transportId: last.transport_id,
    };
  }
}

/** Page every token event by rowid for bounded timestamp validation. */
export async function* tokenEventScanPages(
  reader: DesktopPrismaReader,
  sessionId: string
): AsyncGenerator<TokenEventScanRow[]> {
  let afterRowId: number | bigint | null = null;
  while (true) {
    const rows: TokenEventScanRow[] =
      afterRowId === null
        ? await reader.$queryRawUnsafe<TokenEventScanRow[]>(
            `SELECT rowid AS scan_rowid, session_id, transport_id, model, created_at,
              input_tokens, output_tokens, cache_read_tokens,
              cache_write_tokens, cache_write_5m_tokens,
              cache_write_1h_tokens, cost_usd_estimated,
              input_cost_usd_estimated, output_cost_usd_estimated,
              cache_read_cost_usd_estimated,
              cache_creation_cost_usd_estimated
         FROM token_events
        WHERE session_id = $1
        ORDER BY rowid ASC
        LIMIT $2`,
            sessionId,
            STREAM_PAGE_ROWS
          )
        : await reader.$queryRawUnsafe<TokenEventScanRow[]>(
            `SELECT rowid AS scan_rowid, session_id, transport_id, model, created_at,
              input_tokens, output_tokens, cache_read_tokens,
              cache_write_tokens, cache_write_5m_tokens,
              cache_write_1h_tokens, cost_usd_estimated,
              input_cost_usd_estimated, output_cost_usd_estimated,
              cache_read_cost_usd_estimated,
              cache_creation_cost_usd_estimated
         FROM token_events
        WHERE session_id = $1 AND rowid > $2
        ORDER BY rowid ASC
        LIMIT $3`,
            sessionId,
            afterRowId,
            STREAM_PAGE_ROWS
          );
    if (rows.length === 0) {
      return;
    }
    yield rows;
    afterRowId = rows.at(-1)?.scan_rowid ?? afterRowId;
  }
}

/** Read the exceptional malformed-timestamp path in legacy stable order. */
export function readLegacyTokenEvents(
  reader: DesktopPrismaReader,
  sessionId: string
): Promise<SqliteTokenEventRow[]> {
  return reader.$queryRawUnsafe<SqliteTokenEventRow[]>(
    `SELECT session_id, transport_id, model, created_at, input_tokens,
            output_tokens, cache_read_tokens, cache_write_tokens,
            cache_write_5m_tokens, cache_write_1h_tokens,
            cost_usd_estimated, input_cost_usd_estimated,
            output_cost_usd_estimated, cache_read_cost_usd_estimated,
            cache_creation_cost_usd_estimated
       FROM token_events WHERE session_id = $1
       ORDER BY created_at ASC, model ASC, transport_id ASC, rowid ASC`,
    sessionId
  );
}

function readEventPage(
  reader: DesktopPrismaReader,
  sessionId: string,
  cursor: { createdAt: string | null; id: string } | null
): Promise<SqliteEventRow[]> {
  const select = `SELECT id, session_id, agent_id, event_type, tool_name,
                         summary, NULL AS data, created_at
                    FROM events`;
  if (cursor === null) {
    return reader.$queryRawUnsafe<SqliteEventRow[]>(
      // lexical-timestamp-ok: complete validation scan, not chronology.
      `${select}
        WHERE session_id = $1
        ORDER BY created_at ASC, id ASC
        LIMIT $2`,
      sessionId,
      STREAM_PAGE_ROWS
    );
  }
  if (cursor.createdAt === null) {
    // lexical-timestamp-ok: this continues the complete byte-ordered scan above.
    return reader.$queryRawUnsafe<SqliteEventRow[]>(
      `${select}
        WHERE session_id = $1
          AND ((created_at IS NULL AND id > $2) OR created_at IS NOT NULL)
        ORDER BY created_at ASC, id ASC
        LIMIT $3`,
      sessionId,
      cursor.id,
      STREAM_PAGE_ROWS
    );
  }
  // lexical-timestamp-ok: this continues the complete byte-ordered scan above.
  return reader.$queryRawUnsafe<SqliteEventRow[]>(
    `${select}
      WHERE session_id = $1
        AND (created_at > $2 OR (created_at = $2 AND id > $3))
      ORDER BY created_at ASC, id ASC
      LIMIT $4`,
    sessionId,
    cursor.createdAt,
    cursor.id,
    STREAM_PAGE_ROWS
  );
}

async function* equalTimestampEventPages(
  reader: DesktopPrismaReader,
  sessionId: string,
  createdAt: string
): AsyncGenerator<SqliteEventRow[]> {
  const rankPredicates = [
    "event_type = 'UserMessage'",
    "event_type = 'AssistantMessage'",
    `event_type NOT IN ('UserMessage', 'AssistantMessage')
       AND tool_name IS NOT NULL AND tool_name <> ''`,
    `event_type NOT IN ('UserMessage', 'AssistantMessage')
       AND (tool_name IS NULL OR tool_name = '')`,
  ];
  for (const predicate of rankPredicates) {
    let afterId: string | null = null;
    while (true) {
      const rows: SqliteEventRow[] =
        afterId === null
          ? await reader.$queryRawUnsafe<SqliteEventRow[]>(
              `SELECT id, session_id, agent_id, event_type, tool_name, summary,
                      NULL AS data, created_at
                 FROM events
                WHERE session_id = $1 AND created_at = $2
                  AND (${predicate})
                ORDER BY id ASC
                LIMIT $3`,
              sessionId,
              createdAt,
              STREAM_PAGE_ROWS
            )
          : await reader.$queryRawUnsafe<SqliteEventRow[]>(
              `SELECT id, session_id, agent_id, event_type, tool_name, summary,
                      NULL AS data, created_at
                 FROM events
                WHERE session_id = $1 AND created_at = $2
                  AND (${predicate}) AND id > $3
                ORDER BY id ASC
                LIMIT $4`,
              sessionId,
              createdAt,
              afterId,
              STREAM_PAGE_ROWS
            );
      if (rows.length === 0) {
        break;
      }
      yield rows;
      afterId = rows.at(-1)?.id ?? afterId;
    }
  }
}

function compareCanonicalTimelineEvents(
  left: SqliteEventRow,
  right: SqliteEventRow
): number {
  const byTime = left.created_at.localeCompare(right.created_at);
  if (byTime !== 0) {
    return byTime;
  }
  const byRank = eventTimelineOrder(left) - eventTimelineOrder(right);
  return byRank;
}

function eventTimelineOrder(row: SqliteEventRow): number {
  if (row.event_type === "UserMessage") {
    return 0;
  }
  if (row.event_type === "AssistantMessage") {
    return 1;
  }
  return row.tool_name ? 2 : 3;
}

async function readTokenEventPage(
  reader: DesktopPrismaReader,
  sessionId: string,
  cursor: TokenEventPageCursor | null
): Promise<TokenEventScanRow[]> {
  const page: TokenEventScanRow[] = [];
  for (const statement of tokenEventPageStatements(sessionId, cursor)) {
    const rows = await reader.$queryRawUnsafe<TokenEventScanRow[]>(
      statement.sql,
      ...statement.params
    );
    page.push(...rows.slice(0, STREAM_PAGE_ROWS - page.length));
    if (page.length === STREAM_PAGE_ROWS) {
      break;
    }
  }
  return page;
}

/**
 * Build disjoint continuation seeks in canonical token order. Splitting each
 * lexicographic arm lets SQLite seek the matching index prefix, including the
 * implicit rowid tie-break, instead of rescanning earlier arms of an OR ladder.
 */
export function tokenEventPageStatements(
  sessionId: string,
  cursor: TokenEventPageCursor | null
): TokenEventPageStatement[] {
  if (cursor === null) {
    return [
      {
        sql: `${TOKEN_EVENT_PAGE_SELECT}
          WHERE session_id = $1
            AND created_at GLOB ${CANONICAL_UTC_TIMESTAMP_GLOB_SQL}
          ORDER BY created_at ASC, model ASC, transport_id ASC, rowid ASC
          LIMIT ${STREAM_PAGE_ROWS}`,
        params: [sessionId],
      },
    ];
  }
  return [
    sameTransportStatement(sessionId, cursor),
    laterTransportStatement(sessionId, cursor),
    {
      sql: `${TOKEN_EVENT_PAGE_SELECT}
        WHERE session_id = $1 AND created_at = $2 AND model > $3
        ORDER BY model ASC, transport_id ASC, rowid ASC
        LIMIT ${STREAM_PAGE_ROWS}`,
      params: [sessionId, cursor.createdAt, cursor.model],
    },
    {
      // lexical-timestamp-ok: the initial page admits only the fixed-width
      // canonical UTC form, and every continuation cursor comes from that set.
      sql: `${TOKEN_EVENT_PAGE_SELECT}
        WHERE session_id = $1 AND created_at > $2
        ORDER BY created_at ASC, model ASC, transport_id ASC, rowid ASC
        LIMIT ${STREAM_PAGE_ROWS}`,
      params: [sessionId, cursor.createdAt],
    },
  ];
}

function sameTransportStatement(
  sessionId: string,
  cursor: TokenEventPageCursor
): TokenEventPageStatement {
  if (cursor.transportId === null) {
    return {
      sql: `${TOKEN_EVENT_PAGE_SELECT}
        WHERE session_id = $1 AND created_at = $2 AND model = $3
          AND transport_id IS NULL AND rowid > $4
        ORDER BY rowid ASC
        LIMIT ${STREAM_PAGE_ROWS}`,
      params: [sessionId, cursor.createdAt, cursor.model, cursor.rowId],
    };
  }
  return {
    sql: `${TOKEN_EVENT_PAGE_SELECT}
      WHERE session_id = $1 AND created_at = $2 AND model = $3
        AND transport_id = $4 AND rowid > $5
      ORDER BY rowid ASC
      LIMIT ${STREAM_PAGE_ROWS}`,
    params: [
      sessionId,
      cursor.createdAt,
      cursor.model,
      cursor.transportId,
      cursor.rowId,
    ],
  };
}

function laterTransportStatement(
  sessionId: string,
  cursor: TokenEventPageCursor
): TokenEventPageStatement {
  if (cursor.transportId === null) {
    return {
      sql: `${TOKEN_EVENT_PAGE_SELECT}
        WHERE session_id = $1 AND created_at = $2 AND model = $3
          AND transport_id IS NOT NULL
        ORDER BY transport_id ASC, rowid ASC
        LIMIT ${STREAM_PAGE_ROWS}`,
      params: [sessionId, cursor.createdAt, cursor.model],
    };
  }
  return {
    sql: `${TOKEN_EVENT_PAGE_SELECT}
      WHERE session_id = $1 AND created_at = $2 AND model = $3
        AND transport_id > $4
      ORDER BY transport_id ASC, rowid ASC
      LIMIT ${STREAM_PAGE_ROWS}`,
    params: [sessionId, cursor.createdAt, cursor.model, cursor.transportId],
  };
}
