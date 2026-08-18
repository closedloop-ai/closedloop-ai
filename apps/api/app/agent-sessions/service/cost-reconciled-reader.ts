import { TokenCostCompleteness } from "@repo/api/src/types/token-cost-provenance";
import { Prisma, withDb } from "@repo/database";
import { toNumber } from "@/lib/prisma-number";
import type { SessionCostAuthorityMap } from "./cost-authority";
import { SESSION_DETAIL_TOKEN_EVENT_MAX_ROWS } from "./records";

/**
 * Per-session cap on the token-event rows the reconciled-cost aggregate scans.
 * `agent_session_token_events` is an append-only stream (persist-session-children
 * never deletes), so a single long-running session can hold tens of thousands of
 * rows and a 1,000-session component-detail read could otherwise aggregate
 * millions of rows in one query (FEA-4276 reviewer: the perf-cliff concern).
 *
 * We bound the DB work by aggregating only the first
 * `SESSION_DETAIL_TOKEN_EVENT_MAX_ROWS` events per session (via a
 * `ROW_NUMBER()` window), the SAME cap the DETAIL read applies
 * (`getSessionTokenEvents`). A session at/above the cap is treated as "capped"
 * by `reconcileSessionCost` and falls back to the stored rollup on BOTH the list
 * and detail paths — so the bound never changes a displayed figure, it only
 * stops an unbounded scan for the pathological sessions that already fall back.
 *
 * This is a mitigation, not the durable fix. The durable fix is a maintained
 * per-session token-event cost/count projection (a `token_event_cost_sum` /
 * `token_event_priced_count` / `token_event_count` triple on `SessionDetail`,
 * kept in sync by the desktop producer the same way `estimatedCost` is) so the
 * reconciled cost resolves from one cheap indexed read with no per-event scan at
 * all. That needs a schema + producer (sync) change outside this PR's safe
 * scope; tracked as the FEA-4276 follow-up.
 */
export const RECONCILED_COST_EVENT_SCAN_CAP =
  SESSION_DETAIL_TOKEN_EVENT_MAX_ROWS;

type ReconciledCostRow = {
  agentSessionId: string;
  eventCount: bigint;
  pricedCount: bigint;
  costSum: Prisma.Decimal | number | null;
  tokenSum: bigint | number | null;
};

/**
 * FEA-4276: bulk-read the per-session per-event token-cost aggregate for a set of
 * sessions in ONE query, so the LIST can reconcile cost the same way the DETAIL
 * path does (`reconcileSessionCost`) without a per-row token-event fan-out.
 * Returns a map of session artifact id → { count, pricedCount, sum }; sessions
 * with no token events are absent (callers fall back to the stored rollup). An
 * empty id list short-circuits with no query.
 *
 * Three properties this query must hold, each a FEA-4276 review requirement:
 *
 *   1. TENANT ISOLATION (org-scoped): `agent_session_token_events` carries no
 *      `organization_id` — org isolation is JOIN-REACHED through
 *      `SessionDetail → Artifact.organizationId` (the schema's documented
 *      contract, shared with the sibling `agent_session_activity_segments`).
 *      This reader keeps that relation predicate in the owning query
 *      (`JOIN session_detail … JOIN artifacts … WHERE organization_id = …`) so a
 *      cross-org id can never be reconciled even if a caller passes it in — the
 *      isolation does not depend on the caller having pre-scoped the ids.
 *
 *   2. COMPLETENESS SIGNALS: two independent under-report guards.
 *      (a) UNPRICED rows: legacy omitted costs remain literal zero after the
 *          no-backfill migration; new omission persists as NULL; partial
 *          summaries carry a subtotal but are knowingly incomplete. We count
 *          legacy positive rows plus `complete` summaries (including $0);
 *          `reconcileSessionCost` trusts the per-event sum ONLY when every
 *          counted row was priced.
 *      (b) DROPPED/OVERFLOWED chunks (shafty review): the per-event stream is
 *          chunked into separate append-only sync requests, so a dropped or
 *          overflow-truncated chunk leaves fewer rows than the session actually
 *          has WITHOUT hitting the read cap — a partial stream a row count alone
 *          can't detect. We also return `tokenSum` = Σ(input_tokens +
 *          output_tokens); `reconcileSessionCost` cross-checks it against the
 *          rollup token total and falls back to the rollup when the per-event
 *          tokens under-report it (an incomplete stream). Both guards fall back to
 *          the rollup, which the desktop producer keeps whole.
 *
 *   3. BOUNDED WORK (perf cliff): the aggregate scans at most
 *      `RECONCILED_COST_EVENT_SCAN_CAP` rows per session (a `ROW_NUMBER()`
 *      window), so one read over 1,000 sessions can never aggregate the full
 *      append-only history. A capped session reports `eventCount` at the cap and
 *      falls back to the rollup, exactly as the detail path does.
 */
export function getReconciledCostsBySessionId(input: {
  organizationId: string;
  sessionIds: readonly string[];
}): Promise<SessionCostAuthorityMap> {
  const ids = [...new Set(input.sessionIds)];
  if (ids.length === 0) {
    return Promise.resolve(new Map());
  }
  return withDb(async (db) => {
    const rows = await db.$queryRaw<ReconciledCostRow[]>(Prisma.sql`
      WITH capped_events AS (
        SELECT
          te.agent_session_id,
          te.estimated_cost,
          te.cost_completeness,
          te.input_tokens,
          te.output_tokens,
          ROW_NUMBER() OVER (
            PARTITION BY te.agent_session_id
            ORDER BY te.event_created_at ASC, te.external_event_id ASC
          ) AS rn
        FROM agent_session_token_events AS te
        JOIN session_detail AS sd
          ON sd.artifact_id = te.agent_session_id
        JOIN artifacts AS a
          ON a.id = sd.artifact_id
        WHERE te.agent_session_id IN (${Prisma.join(
          ids.map((id) => Prisma.sql`${id}::uuid`)
        )})
          AND a.organization_id = ${input.organizationId}::uuid
      )
      SELECT
        agent_session_id AS "agentSessionId",
        COUNT(*) AS "eventCount",
        COUNT(*) FILTER (
          WHERE cost_completeness = ${TokenCostCompleteness.Complete}
             OR (cost_completeness IS NULL AND estimated_cost > 0)
        ) AS "pricedCount",
        COALESCE(SUM(estimated_cost), 0) AS "costSum",
        COALESCE(SUM(input_tokens + output_tokens), 0) AS "tokenSum"
      FROM capped_events
      WHERE rn <= ${RECONCILED_COST_EVENT_SCAN_CAP}
      GROUP BY agent_session_id
    `);
    const map = new Map<
      string,
      { count: number; pricedCount: number; sum: number; tokenSum: number }
    >();
    for (const row of rows) {
      map.set(row.agentSessionId, {
        count: Number(row.eventCount),
        pricedCount: Number(row.pricedCount),
        sum: toNumber(row.costSum),
        tokenSum: toNumber(row.tokenSum),
      });
    }
    return map;
  });
}
