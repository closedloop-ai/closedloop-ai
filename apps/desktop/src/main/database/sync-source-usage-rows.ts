/**
 * Per-session usage-row reads shared by every sync-source hydration path.
 *
 * ISS-5801: extracted from `sync-source.ts` (a shrink-only grandfathered file)
 * so the token-usage and invocation-count aggregates live in one leaf module;
 * `sync-source.ts` imports FROM here, never the other way round.
 */
import type { SqliteTokenUsageRow } from "./db-row-types.js";
import type {
  DesktopPrismaReadClient,
  DesktopPrismaReader,
} from "./prisma-client.js";
import { selectRowsByIds } from "./session-detail-mappers.js";

export function selectTokenUsageRows(
  reader: DesktopPrismaReadClient,
  ids: string[]
): Promise<SqliteTokenUsageRow[]> {
  return selectRowsByIds<SqliteTokenUsageRow>(
    reader,
    `
      SELECT
        session_id,
        model,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        cache_write_5m_tokens,
        cache_write_1h_tokens,
        baseline_input,
        baseline_output,
        baseline_cache_read,
        baseline_cache_write,
        created_at,
        cost_usd_estimated
      FROM token_usage
      WHERE session_id IN (__IDS__)
      ORDER BY session_id ASC, model ASC
    `,
    ids
  );
}

/**
 * Compact list token projection: one row per session/model with pre-compaction
 * baselines folded into the effective counts the list has always rendered.
 */
export function selectListTokenUsageRows(
  reader: DesktopPrismaReader,
  ids: string[]
): Promise<SqliteTokenUsageRow[]> {
  return selectRowsByIds<SqliteTokenUsageRow>(
    reader,
    `
      SELECT
        session_id,
        model,
        SUM(COALESCE(input_tokens, 0) + COALESCE(baseline_input, 0)) AS input_tokens,
        SUM(COALESCE(output_tokens, 0) + COALESCE(baseline_output, 0)) AS output_tokens,
        SUM(COALESCE(cache_read_tokens, 0) + COALESCE(baseline_cache_read, 0)) AS cache_read_tokens,
        SUM(COALESCE(cache_write_tokens, 0) + COALESCE(baseline_cache_write, 0)) AS cache_write_tokens,
        CASE WHEN COUNT(cache_write_5m_tokens) = 0 THEN NULL ELSE SUM(cache_write_5m_tokens) END AS cache_write_5m_tokens,
        CASE WHEN COUNT(cache_write_1h_tokens) = 0 THEN NULL ELSE SUM(cache_write_1h_tokens) END AS cache_write_1h_tokens,
        0 AS baseline_input,
        0 AS baseline_output,
        0 AS baseline_cache_read,
        0 AS baseline_cache_write,
        created_at,
        CASE WHEN COUNT(cost_usd_estimated) = 0 THEN NULL ELSE SUM(cost_usd_estimated) END AS cost_usd_estimated
      FROM token_usage
      WHERE session_id IN (__IDS__)
      GROUP BY session_id, model
      ORDER BY session_id ASC, model ASC
    `,
    ids
  );
}

/**
 * ISS-5801: per-session count of locally materialized component invocations —
 * the SAME store the invocation sync lane builds parts from — so the sync gate
 * (`syncedSessionIsSubstantive`) and the local list classify substantive work by
 * the signal that actually queues invocation children. Runs unconditionally on
 * every hydration path (one indexed aggregate over `idx_aci_session_sequence`):
 * a path without the count would silently re-open the withheld-parent orphan
 * class this signal exists to close.
 */
export async function selectInvocationCountRows(
  reader: DesktopPrismaReader,
  ids: string[]
): Promise<Map<string, number>> {
  const rows = await selectRowsByIds<{
    session_id: string;
    invocation_count: number | bigint;
  }>(
    reader,
    `
      SELECT session_id, COUNT(*) AS invocation_count
      FROM agent_component_invocations
      WHERE session_id IN (__IDS__)
      GROUP BY session_id
    `,
    ids
  );
  return new Map(
    rows.map((row) => [row.session_id, Number(row.invocation_count)])
  );
}
