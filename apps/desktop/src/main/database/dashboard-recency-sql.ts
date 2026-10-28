import { toolInvocationPredicate } from "./db-helpers.js";
import {
  allOrNothingCanonicalSortSql,
  canonicalRankingKeySql,
} from "./session-timestamp-form.js";

/**
 * ISS-6815: the dashboard read whose answer IS a recency over one of the
 * store's TEXT timestamp columns, held as a named constant so a test can execute
 * the production statement rather than a re-typed copy of it.
 *
 * `getTools` came out of `dashboard-queries.ts` the same way
 * `dashboard-skill-sql.ts` did; its consumer
 * keeps only the JS map from a row to a `DashboardToolSummary`.
 */

/** ISS-6815: one SQL-aggregated tool — the rollup `getTools` maps straight on. */
export type SqliteToolRow = {
  tool_name: string;
  invocation_count: bigint;
  session_count: bigint;
  last_used_at: string | null;
  /**
   * The query's single `MAX` aggregate. No summary field maps from it, but it
   * MUST stay in the SELECT list: dropping it leaves the query with no min/max
   * aggregate at all, so the bare-column rule below stops applying and
   * `last_used_at` silently rebinds to the inner column of the same name.
   */
  last_used_sort: string | null;
};

/**
 * COUNT(DISTINCT session_id) + a per-tool recency, in SQL — no typed groupBy
 * form (Prisma `_count` is row count, not distinct), so raw on the one client.
 *
 * ISS-6815: what the max ranks is `last_used_sort`, not the raw `created_at`
 * bytes. This reads the SAME column ISS-6414 fixed `getSkills` over —
 * `events.created_at` holds raw harness text and is deliberately outside the
 * FEA-3743 heal's `HEALED_COLUMNS` (timestamp-format-maintenance.ts), so it
 * carries mixed forms indefinitely, and byte order is only time order at a FIXED
 * width. A whole-second stamp beats a sub-second one at the same instant (`Z`
 * 0x5A sorts after `.` 0x2E), so the byte-wise `MAX` handed the dashboard the
 * EARLIER event as "last used". `allOrNothingCanonicalSortSql`
 * (session-timestamp-form.ts) carries ISS-5497's two-mode rule and why it may
 * not be half-applied, and `canonicalRankingKeySql` is the SSOT's ranking-key
 * form of the canonicalization — the canonical GLOB is a SHAPE test, so shape
 * alone would let an impossible instant like month 13 count as canonical and
 * win the fold on its bytes.
 *
 * `last_used_at` stays the BARE `created_at` beside that single `MAX`, which
 * SQLite documents as taking its value from the row that produced the max — so
 * the fix changes WHICH row wins, not the text form the renderer receives.
 */
export const TOOL_SUMMARY_SQL = `
  SELECT tool_name,
    COUNT(*) AS invocation_count,
    COUNT(DISTINCT session_id) AS session_count,
    created_at AS last_used_at,
    MAX(last_used_sort) AS last_used_sort
  FROM (
    SELECT
      tool_name,
      session_id,
      created_at,
      ${allOrNothingCanonicalSortSql("canonical_created_at", "created_at", "PARTITION BY tool_name")} AS last_used_sort
    FROM (
      SELECT
        tool_name,
        session_id,
        created_at,
        ${canonicalRankingKeySql("created_at")} AS canonical_created_at
      FROM events
      WHERE ${toolInvocationPredicate("tool_name")}
    )
  )
  GROUP BY tool_name
  ORDER BY invocation_count DESC, tool_name ASC
`;
