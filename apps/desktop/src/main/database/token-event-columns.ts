import type { SyncedSessionLoadOptions } from "../agent-sync/agent-session-sync-source.js";
import type { SqliteTokenEventRow } from "./db-row-types.js";
import type { DesktopPrismaReadClient } from "./prisma-client.js";
import { selectRowsByIds } from "./session-detail-mappers.js";

/**
 * ISS-6050: the `token_events` column list a hydration SELECTs.
 *
 * A LIST read drops the two SYNC-ONLY columns — `cost_summary` (a per-event
 * JSON blob) and `source_identity` — from the projection (ISS-6050 selected them
 * as `NULL AS`; ISS-6227 omits them outright, see {@link tokenEventSelectColumns}).
 * Their only consumer is `token-event-sync.ts`,
 * the cloud payload builder, which never passes the option. The blob multiplied
 * by every token event of every session in the working set is the dominant term
 * in the measured 444MB `pageData({quality:"all"})` read on the 2,962-session
 * snapshot, and the libSQL driver materializes the whole result set before any
 * JS-side omit runs — so it has to be dropped in SQL to save anything. Same
 * idiom as `omitEventData` for `events.data`, for the same reason.
 *
 * Why the two columns and NOT the whole stream, which PR #4850 measured at
 * 444MB -> 139MB before reverting it in 1925c666a: the stream feeds three
 * consumers, and dropping it outright breaks two of them.
 *
 *   1. the activity EXTENT (`activityExtentMs` / `traceActivityTimestamps` ->
 *      `resolveActivityEndMs`) reads `created_at`;
 *   2. `buildSessionAutonomyInput` pushes EVERY event's `created_at` into
 *      `agentActivityTimestamps` — and the Sessions list RENDERS that score
 *      (`AutonomyChip`; Sessions list — "autonomy always
 *      shows"), so an omitted stream moves a DISPLAYED list value;
 *   3. per-event `activityBuckets`/`markers` content (session-trace.ts), whose
 *      every production consumer is under `agents/components/detail/` or
 *      `agents/lib/` — the detail view, which hydrates separately.
 *
 * Keeping every mapped column holds 1 and 2 bit-identical. Nulling the token
 * COUNT columns instead was considered and rejected: `tokenCountValue` returns a
 * non-optional `number`, so a NULL count coerces to a FABRICATED `0` rather than
 * to "unknown". The counts are 8-byte scalars; the blob is the cost.
 *
 * The divergence is therefore exactly TWO fields — a narrowed event omits
 * `costSummary` AND `sourceIdentity`, one per omitted column — pinned by
 * `sync-source-list-token-event-projection.test.ts`, which seeds both columns
 * non-null so either surviving the narrowing fails there.
 * Omitted, never defaulted: an absent field reads as "unknown" where a
 * fabricated one would assert a cost nobody computed.
 *
 * Callers keep `ORDER BY` on the real `model`/`transport_id` columns (SQLite
 * orders by table columns absent from the SELECT list), so row ORDER is
 * identical either way.
 */
export function selectTokenEventRows(
  reader: DesktopPrismaReadClient,
  ids: string[],
  options?: SyncedSessionLoadOptions
): Promise<SqliteTokenEventRow[]> {
  return selectRowsByIds<SqliteTokenEventRow>(
    reader,
    `
      SELECT
        session_id,
        ${tokenEventSelectColumns(options)}
      FROM token_events
      WHERE session_id IN (__IDS__)
      ORDER BY session_id ASC, created_at ASC, model ASC, transport_id ASC
    `,
    ids
  );
}

/**
 * ISS-6227: a narrowed read omits the two sync-only columns from the result set
 * ENTIRELY rather than selecting them as `NULL AS`.
 *
 * `NULL AS source_identity` still materializes a cell per row, and on this
 * boundary a cell — not a byte — is the unit of cost, so the saving scales with
 * the ROW COUNT of the working set rather than with the stored bytes.
 *
 * Parity is structural, not merely observed: `parseStoredTokenSourceIdentity`
 * and `parseStoredTokenCostSummary` both return `undefined` for `null` AND for
 * `undefined`, and `mapSyncedTokenEvent` spreads each field conditionally — so
 * an absent property and a NULL cell produce the same synced event. The narrowed
 * event therefore still omits `costSummary` rather than defaulting it — omitted
 * reads as "unknown" where a fabricated value would assert a cost nobody
 * computed. `sync-source-list-token-event-projection.test.ts` pins both halves.
 */
function tokenEventSelectColumns(options?: SyncedSessionLoadOptions): string {
  const syncOnlyColumns = options?.omitTokenEventCostColumns
    ? ""
    : `,
        source_identity,
        cost_summary`;
  return `transport_id,
        model,
        created_at,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        cache_write_5m_tokens,
        cache_write_1h_tokens,
        cost_usd_estimated,
        input_cost_usd_estimated,
        output_cost_usd_estimated,
        cache_read_cost_usd_estimated,
        cache_creation_cost_usd_estimated,
        agent_id${syncOnlyColumns}`;
}
