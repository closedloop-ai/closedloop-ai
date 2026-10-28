import type { BranchMetricCostFacts } from "@repo/lib/branches/branch-cost-facts";
import {
  type CostMetricWindow,
  type CostSliceRow,
  cohortHoldsCostEvents,
  foldCostWindow,
  HOLDS_EVENTS_SLICE,
  planCostSliceBoundaries,
  UNPLACEABLE_SLICE,
} from "@repo/lib/branches/branch-cost-slices";
import { activeWriteLinkSql, type BranchKeyRow } from "./branch-reads.js";
import type { DbHostPrisma } from "./prisma-client.js";
import {
  CANONICAL_UTC_TIMESTAMP_GLOB_SQL,
  isRealInstantSql,
} from "./session-timestamp-form.js";

/** Sorts below every canonical instant, so an unbounded window reads from the start. */
const BEFORE_ALL_INSTANTS = "0000";

/** Names the statement in query logs and lets a test tell it from the event reads. */
export const BRANCH_COST_SLICES_SQL_TAG = "branch_cost_slices";

type SliceRawRow = {
  slice: number | bigint;
  spend: number | null;
  included: number | bigint | null;
  unusable: number | bigint | null;
};

/**
 * ISS-12361: per-window AI spend for the branches in `cohort`, in SQL with no
 * session or parameter cap (ISS-12346 rulings C1-C6). Each event is split evenly
 * across the distinct branches its session wrote to among the cohort and the
 * `eligible` set, the cohort always counted in the divisor.
 *
 * Every list is one bound JSON array, so the statement binds five parameters at
 * any cohort width. An event whose `created_at` is not a canonical instant is
 * unusable in every window: it cannot be placed in time, and the byte-wise
 * window bounds below are only chronological for the canonical form.
 */
export async function readBranchCostMetricFacts(
  prisma: DbHostPrisma,
  input: {
    cohort: readonly BranchKeyRow[];
    eligible: readonly BranchKeyRow[];
    windows: readonly CostMetricWindow[];
  }
): Promise<BranchMetricCostFacts> {
  const { boundaries, unboundedBelow } = planCostSliceBoundaries(input.windows);
  if (input.cohort.length === 0 || boundaries.length === 0) {
    return { cohortHoldsEvents: false, windows: new Map() };
  }
  const rows = await prisma.client.$queryRawUnsafe<SliceRawRow[]>(
    branchCostSlicesSql(),
    keyListJson(input.cohort),
    keyListJson(input.eligible),
    JSON.stringify(boundaries),
    unboundedBelow
      ? BEFORE_ALL_INSTANTS
      : (boundaries[0] ?? BEFORE_ALL_INSTANTS),
    boundaries.at(-1) ?? BEFORE_ALL_INSTANTS
  );
  const slices: CostSliceRow[] = rows.map((row) => ({
    slice: Number(row.slice),
    spend: row.spend,
    included: Number(row.included ?? 0),
    unusable: Number(row.unusable ?? 0),
  }));
  return {
    cohortHoldsEvents: cohortHoldsCostEvents(slices),
    windows: new Map(
      input.windows.map((window) => [
        window.key,
        foldCostWindow(window, boundaries, slices),
      ])
    ),
  };
}

function keyListJson(keys: readonly BranchKeyRow[]): string {
  return JSON.stringify(
    keys.map((key) => ({
      repoFullName: key.repoFullName,
      branchName: key.branchName,
    }))
  );
}

function branchCostSlicesSql(): string {
  // Shape AND value, the pair every other timestamp guard in this store already
  // spells (component-tombstone-repair.ts, sync-burndown-store.ts). Every field
  // of the canonical glob is a bare `[0-9]` class, so the shape alone admits
  // `2026-06-02T12:60:00.000Z` — expected width, not an instant — and here that
  // is a spend total published Complete over an event nothing can place in time.
  const canonical = `COALESCE(te.created_at GLOB ${CANONICAL_UTC_TIMESTAMP_GLOB_SQL}
          AND (${isRealInstantSql("te.created_at")}), 0)`;
  // `MATERIALIZED` on the two key sets is load-bearing, not decoration: inlined,
  // each is re-scanned per candidate row, and the 900-session cap this read
  // replaces is what used to bound that. Materializing lets SQLite build an
  // automatic index over each set before the join. Measured on the AC store at
  // two links and four events per session: 500 branches/2.5k sessions 2027ms ->
  // 256ms, 1k/5k 12177ms -> 897ms, so the growth is no longer superlinear.
  return `/* ${BRANCH_COST_SLICES_SQL_TAG} */
    WITH cohort AS MATERIALIZED (
      SELECT json_extract(value, '$.repoFullName') AS repo,
             json_extract(value, '$.branchName') AS branch
      FROM json_each(?1)
    ),
    divisor AS MATERIALIZED (
      SELECT repo, branch FROM cohort
      UNION
      SELECT json_extract(value, '$.repoFullName'),
             json_extract(value, '$.branchName')
      FROM json_each(?2)
    ),
    links AS (
      SELECT DISTINCT sal.session_id AS session_id,
             a.repo_full_name AS repo,
             a.branch_name AS branch
      FROM session_artifact_links sal
      JOIN artifacts a ON a.id = sal.artifact_id AND a.kind = 'branch'
      JOIN divisor d ON d.branch = a.branch_name AND d.repo IS a.repo_full_name
      WHERE a.branch_name IS NOT NULL
        AND ${activeWriteLinkSql("sal", "a")}
    ),
    membership AS (
      SELECT l.session_id AS session_id,
             EXISTS (
               SELECT 1 FROM cohort c WHERE c.branch = l.branch AND c.repo IS l.repo
             ) AS in_cohort
      FROM links l
    ),
    shares AS (
      SELECT m.session_id AS session_id,
             CAST(SUM(m.in_cohort) AS REAL) / COUNT(*) AS share
      FROM membership m
      GROUP BY m.session_id
      HAVING SUM(m.in_cohort) > 0
    ),
    events AS (
      SELECT DISTINCT te.transport_id, te.session_id, te.model, te.created_at,
             te.input_tokens, te.output_tokens, te.cache_read_tokens,
             te.cache_write_tokens, te.cache_write_5m_tokens,
             te.cache_write_1h_tokens, te.cost_usd_estimated,
             ${canonical} AS canon
      FROM token_events te
      WHERE te.session_id IN (SELECT session_id FROM shares)
        AND (
          NOT ${canonical}
          OR (te.created_at >= ?4 AND te.created_at < ?5)
        )
    ),
    placed AS (
      SELECT shares.share AS share,
             CASE WHEN te.canon THEN (
               SELECT COUNT(*) FROM json_each(?3) WHERE value <= te.created_at
             ) ELSE ${UNPLACEABLE_SLICE} END AS slice,
             te.cost_usd_estimated AS cost,
             (te.canon AND ${usableEventSql("te")}) AS ok
      FROM events te
      JOIN shares ON shares.session_id = te.session_id
    )
    SELECT slice,
           SUM(CASE WHEN ok THEN share * cost END) AS spend,
           SUM(ok) AS included,
           SUM(1 - ok) AS unusable
    FROM placed
    GROUP BY slice
    UNION ALL
    SELECT ${HOLDS_EVENTS_SLICE}, 0.0,
           EXISTS (
             SELECT 1 FROM token_events held
             WHERE held.session_id IN (SELECT session_id FROM shares)
           ),
           0`;
}

/** A present, non-negative, finite cost; token counts are not consulted (ISS-12346 C1). */
function usableEventSql(alias: string): string {
  return `(
    typeof(${alias}.cost_usd_estimated) IN ('integer', 'real')
    AND ${alias}.cost_usd_estimated >= 0
    AND ${alias}.cost_usd_estimated < 9e999
  )`;
}
