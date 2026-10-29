import { LinkType } from "@repo/api/src/types/artifact";
import { ArtifactType, Prisma, withDb } from "@repo/database";
import type { BranchMetricCostFacts } from "@repo/lib/branches/branch-cost-facts";
import {
  type CostMetricWindow,
  type CostSliceBoundaries,
  type CostSliceRow,
  cohortHoldsCostEvents,
  foldCostWindow,
  HOLDS_EVENTS_SLICE,
  planCostSliceBoundaries,
} from "@repo/lib/branches/branch-cost-slices";
import { setAppSpanAttributes } from "@repo/observability/tracing/spans";
import { readBranchAnalyticsRollupAsOf } from "./branch-analytics-rollup";
import { BRANCH_ANALYTICS_ROLLUP_SOURCE } from "./branch-analytics-rollup-contract";
import {
  branchAnalyticsSessionLinkKindSql,
  branchSessionTokenEventInScopeSql,
} from "./branch-analytics-rollup-sql";
import { activeWriteBranchParticipationSql } from "./branch-contribution-sql";
import {
  BRANCH_PRODUCT_READ_SNAPSHOT_FULL_CORPUS_TIMEOUT_MS,
  BRANCH_PRODUCT_READ_SNAPSHOT_MAX_WAIT_MS,
} from "./branch-product-read-snapshot";

/** ISS-12346: AI spend per window, computed in SQL with no caps (rulings C1-C6). */

type ShareRow = { session_id: string; share: number };

export type SlicePlan = CostSliceBoundaries & {
  /** UTC days an edge falls inside, which no whole daily bucket can answer. */
  splitDays: string[];
};

const DAY_MS = 86_400_000;

/**
 * The gate and the aggregation it licenses share one MVCC snapshot, on the
 * branch read's own full-corpus budget — this read spans the org's whole linked
 * session set, so `withDb.tx`'s 5s default would expire before the statements do.
 */
const COST_FACTS_SNAPSHOT = {
  isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  maxWait: BRANCH_PRODUCT_READ_SNAPSHOT_MAX_WAIT_MS,
  timeout: BRANCH_PRODUCT_READ_SNAPSHOT_FULL_CORPUS_TIMEOUT_MS,
} as const;

/**
 * Per-window spend for the branches in `cohortIds`. Every event is split evenly
 * across the distinct branches its session wrote to among the branches
 * `eligible` selects as `id` (the cohort is always counted in the divisor), and
 * a cohort branch takes its share.
 *
 * Whole days come from the daily rollup when it is fresh and complete for the
 * cohort's sessions, and only the days an edge falls inside are read from the
 * source events. Anything the rollup cannot vouch for is read from the events.
 *
 * ONE RepeatableRead snapshot carries the whole read (B4, tamsinb review on
 * #8791). The freshness gate and the aggregation that trusts it are separate
 * statements: on pooled connections a refresh pass purging a session's rollup
 * rows between them dropped that session's whole-day spend while its edge-day
 * events still counted and `unusable` stayed 0 — an undercount the card would
 * publish as Complete. The pre-ISS-12346 callers got this from the branch read
 * snapshot they ran inside; these reads take their own connection, so they open
 * their own, on that snapshot's budget rather than `withDb.tx`'s 5s default.
 */
export function readCostMetricFacts(
  organizationId: string,
  cohortIds: readonly string[],
  eligible: Prisma.Sql,
  windows: readonly CostMetricWindow[]
): Promise<BranchMetricCostFacts> {
  const plan = planSlices(windows);
  return withDb.tx(async (db) => {
    const shares = await db.$queryRaw<ShareRow[]>(
      costSharesSql(organizationId, cohortIds, eligible)
    );
    const sessions = {
      ids: shares.map((row) => row.session_id),
      shares: shares.map((row) => Number(row.share)),
    };
    const rows =
      sessions.ids.length === 0
        ? []
        : await db.$queryRaw<CostSliceRow[]>(
            await sliceStatement(db, organizationId, sessions, plan)
          );
    return {
      cohortHoldsEvents: cohortHoldsCostEvents(rows),
      windows: new Map(
        windows.map((window) => [
          window.key,
          foldCostWindow(window, plan.boundaries, rows),
        ])
      ),
    };
  }, COST_FACTS_SNAPSHOT);
}

type CostSessions = { ids: string[]; shares: number[] };

async function sliceStatement(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  sessions: CostSessions,
  plan: SlicePlan
): Promise<Prisma.Sql> {
  const asOf = await readBranchAnalyticsRollupAsOf(
    db,
    organizationId,
    sessions.ids,
    new Date()
  );
  setAppSpanAttributes({
    "branches.analytics.cost_facts.source": asOf ? "rollup" : "events",
    "branches.analytics.cost_facts.session_count": sessions.ids.length,
  });
  return asOf
    ? costSlicesFromRollupSql(organizationId, sessions, plan, asOf)
    : costSlicesFromEventsSql(sessions, plan);
}

export function planSlices(windows: readonly CostMetricWindow[]): SlicePlan {
  const { boundaries, unboundedBelow } = planCostSliceBoundaries(windows);
  return {
    boundaries,
    unboundedBelow,
    splitDays: [
      ...new Set(
        boundaries.flatMap((edge) => {
          const day = Math.floor(Date.parse(edge) / DAY_MS) * DAY_MS;
          return day === Date.parse(edge) ? [] : [new Date(day).toISOString()];
        })
      ),
    ],
  };
}

/**
 * Each session that wrote to a cohort branch, with the cohort's fraction of the
 * branches it wrote to among the eligible set (the cohort always counted).
 */
export function costSharesSql(
  organizationId: string,
  cohortIds: readonly string[],
  eligible: Prisma.Sql
): Prisma.Sql {
  const cohort = [...cohortIds];
  return Prisma.sql`
    WITH divisor_branches AS MATERIALIZED (
      SELECT unnest(${cohort}::uuid[]) AS id
      UNION
      SELECT eligible.id FROM (${eligible}) eligible
    ),
    links AS MATERIALIZED (
      SELECT al.source_id AS session_id, al.target_id AS branch_id
      FROM artifact_links al
      INNER JOIN artifacts session_artifact
        ON session_artifact.id = al.source_id
        AND session_artifact.organization_id = ${organizationId}::uuid
        AND session_artifact.type = ${ArtifactType.SESSION}::"ArtifactType"
      INNER JOIN session_detail sd ON sd.artifact_id = session_artifact.id
      INNER JOIN divisor_branches ON divisor_branches.id = al.target_id
      INNER JOIN artifacts target
        ON target.id = al.target_id
        AND target.organization_id = ${organizationId}::uuid
        AND target.type = ${ArtifactType.BRANCH}::"ArtifactType"
      WHERE al.organization_id = ${organizationId}::uuid
        AND al.link_type = ${LinkType.RelatesTo}::"LinkType"
        AND ${branchAnalyticsSessionLinkKindSql()}
        AND ${activeWriteBranchParticipationSql()}
      GROUP BY al.source_id, al.target_id
    )
    SELECT
      session_id,
      (COUNT(*) FILTER (WHERE branch_id = ANY(${cohort}::uuid[])))::float8
        / COUNT(*) AS share
    FROM links
    GROUP BY session_id
    HAVING COUNT(*) FILTER (WHERE branch_id = ANY(${cohort}::uuid[])) > 0`;
}

/** The exact read: every event of every session, each cut into its slice. */
export function costSlicesFromEventsSql(
  sessions: CostSessions,
  plan: SlicePlan
): Prisma.Sql {
  const edges = [...plan.boundaries];
  const lowerBound = plan.unboundedBelow
    ? Prisma.sql`TRUE`
    : Prisma.sql`event.event_created_at >= ${edges[0] ?? "-infinity"}::timestamp`;
  return Prisma.sql`
    WITH session_shares AS MATERIALIZED (
      SELECT unnest(${sessions.ids}::uuid[]) AS session_id,
        unnest(${sessions.shares}::float8[]) AS share
    ),
    per_session AS (
      SELECT
        session_shares.share,
        usable.slice,
        SUM(event.estimated_cost::float8) FILTER (WHERE usable.ok) AS spend,
        COUNT(*) FILTER (WHERE usable.ok) AS included,
        COUNT(*) FILTER (WHERE NOT usable.ok) AS unusable
      FROM session_shares
      INNER JOIN agent_session_token_events event
        ON event.agent_session_id = session_shares.session_id
        AND ${lowerBound}
        AND event.event_created_at < ${edges.at(-1) ?? "infinity"}::timestamp
      CROSS JOIN LATERAL (
        SELECT COALESCE(event.estimated_cost >= 0, FALSE) AS ok,
        width_bucket(event.event_created_at, ${edges}::timestamp[]) AS slice
      ) usable
      GROUP BY session_shares.session_id, session_shares.share, usable.slice
    )
    SELECT slice::int, SUM(share * spend) AS spend,
      SUM(included)::int AS included, SUM(unusable)::int AS unusable
    FROM per_session
    GROUP BY slice
    UNION ALL
    SELECT ${HOLDS_EVENTS_SLICE}, 0::float8,
      (EXISTS (
        SELECT 1 FROM session_shares
        INNER JOIN agent_session_token_events held
          ON held.agent_session_id = session_shares.session_id
      ))::int, 0`;
}

/**
 * Whole days from the daily rollup; the days an edge falls inside, from the
 * source events as of the rollup's own instant. The caller has established the
 * rollup is fresh and complete for these sessions.
 */
export function costSlicesFromRollupSql(
  organizationId: string,
  sessions: CostSessions,
  plan: SlicePlan,
  asOf: Date
): Prisma.Sql {
  const edges = [...plan.boundaries];
  const splitDays = [...plan.splitDays];
  const firstDay = new Date(
    Math.floor(Date.parse(edges[0] ?? "1970-01-01T00:00:00.000Z") / DAY_MS) *
      DAY_MS
  );
  const lowerBound = plan.unboundedBelow
    ? Prisma.sql`TRUE`
    : Prisma.sql`rollup.bucket_start >= ${firstDay}`;
  return Prisma.sql`
    WITH session_shares AS MATERIALIZED (
      SELECT unnest(${sessions.ids}::uuid[]) AS session_id,
        unnest(${sessions.shares}::float8[]) AS share
    ),
    whole_days AS (
      SELECT
        session_shares.share,
        placed.slice,
        SUM(day.cost::float8) AS spend,
        SUM(day.priced) AS included,
        SUM(day.events - day.priced) AS unusable
      FROM session_shares
      CROSS JOIN LATERAL (
        SELECT
          rollup.bucket_start,
          MAX(rollup.estimated_cost) AS cost,
          MAX(rollup.estimated_cost_event_count) AS priced,
          MAX(rollup.event_count) AS events
        FROM branch_analytics_session_rollups rollup
        WHERE rollup.organization_id = ${organizationId}::uuid
          AND rollup.session_artifact_id = session_shares.session_id
          AND rollup.source = ${BRANCH_ANALYTICS_ROLLUP_SOURCE}
          AND ${lowerBound}
          AND rollup.bucket_start < ${edges.at(-1) ?? "infinity"}::timestamp
          AND NOT (rollup.bucket_start = ANY(${splitDays}::timestamp[]))
        GROUP BY rollup.bucket_start
      ) day
      CROSS JOIN LATERAL (
        SELECT width_bucket(day.bucket_start, ${edges}::timestamp[]) AS slice
      ) placed
      GROUP BY session_shares.session_id, session_shares.share, placed.slice
    ),
    split_days AS (
      SELECT
        session_shares.share,
        placed.slice,
        SUM(edge_event.estimated_cost::float8) FILTER (
          WHERE edge_event.estimated_cost IS NOT NULL
        ) AS spend,
        COUNT(edge_event.estimated_cost) AS included,
        COUNT(*) FILTER (WHERE edge_event.estimated_cost IS NULL) AS unusable
      FROM session_shares
      CROSS JOIN unnest(${splitDays}::timestamp[]) AS split(day)
      CROSS JOIN LATERAL (
        SELECT event.estimated_cost, event.event_created_at
        FROM agent_session_token_events event
        WHERE event.agent_session_id = session_shares.session_id
          AND event.event_created_at >= split.day
          AND event.event_created_at < split.day + INTERVAL '1 day'
          AND ${branchSessionTokenEventInScopeSql(asOf)}
        -- Keeps the planner from flattening this into a merge join over every event.
        OFFSET 0
      ) edge_event
      CROSS JOIN LATERAL (
        SELECT width_bucket(edge_event.event_created_at, ${edges}::timestamp[]) AS slice
      ) placed
      GROUP BY session_shares.session_id, session_shares.share, placed.slice
    ),
    placed_slices AS (
      SELECT * FROM whole_days
      UNION ALL
      SELECT * FROM split_days
    )
    SELECT slice::int, SUM(share * spend) AS spend,
      SUM(included)::int AS included, SUM(unusable)::int AS unusable
    FROM placed_slices
    GROUP BY slice
    UNION ALL
    SELECT ${HOLDS_EVENTS_SLICE}, 0::float8,
      (EXISTS (
        SELECT 1 FROM session_shares
        INNER JOIN branch_analytics_session_rollups held
          ON held.session_artifact_id = session_shares.session_id
          AND held.organization_id = ${organizationId}::uuid
          AND held.source = ${BRANCH_ANALYTICS_ROLLUP_SOURCE}
          AND held.event_count > 0
      ))::int, 0`;
}
