/**
 * ISS-9831 — resolving a `/branches` date window against DAILY rollup buckets.
 *
 * The rollup used to be grained per session LIFETIME, so the read refused every
 * window outright: a lifetime total cannot be apportioned to a window that cuts
 * through a session. `upsertBranchAnalyticsSessionRollups` now groups by
 * `date_trunc('day', event_created_at)`, so a window is answerable as the whole
 * daily buckets it covers plus, for the days it only partly covers, a bounded
 * read of the source events themselves.
 *
 * Measured over 7 days of production (2026-09-11): of 743 windowed `GET
 * /branches` requests, 742 carry `startDate=…T00:00:00.000Z` and
 * `endDate=…T23:59:59.999Z`, which land exactly on daily bucket edges and need
 * NO source read. The partial-day arms exist for
 * `packages/app/branches/lib/approved-branch-cohort.ts`, which builds its bounds
 * from an arbitrary instant.
 */
import { Prisma } from "@repo/database";
import {
  BRANCH_ANALYTICS_ROLLUP_SOURCE,
  type BranchAnalyticsRollupDateWindow,
} from "./branch-analytics-rollup-contract";
import { branchSessionTokenEventInScopeSql } from "./branch-analytics-rollup-sql";

export type BranchAnalyticsRollupWindowPlan = {
  /** Inclusive floor on `bucket_start`. Null leaves the window open below. */
  wholeBucketStart: Date | null;
  /** Exclusive ceiling on `bucket_start`. Null leaves the window open above. */
  wholeBucketEndExclusive: Date | null;
  /** The part of the first day the window starts inside of, if any. */
  headRange: { startInclusive: Date; endExclusive: Date } | null;
  /** The part of the last day the window ends inside of, if any. */
  tailRange: { startInclusive: Date; endInclusive: Date } | null;
};

/**
 * Split a requested window into whole daily buckets plus its partial edge days.
 *
 * Returns `undefined` when the rollup cannot beat the fallback: an inverted
 * window, or one so narrow that no whole day sits inside it. Answering that case
 * from here would run the fallback's own aggregate and report it as a rollup
 * hit, so the caller refuses instead and the real fallback runs. `undefined`
 * rather than `null` so it is the same absent-plan the unwindowed read passes
 * on, and one guard in the caller covers both.
 */
export function planBranchAnalyticsRollupWindow(
  dateWindow: BranchAnalyticsRollupDateWindow
): BranchAnalyticsRollupWindowPlan | undefined {
  const { startDate, endDate } = dateWindow;
  if (startDate && endDate && endDate.getTime() < startDate.getTime()) {
    return;
  }
  const head = resolveWindowHead(startDate);
  const tail = resolveWindowTail(endDate);
  if (
    head.wholeBucketStart &&
    tail.wholeBucketEndExclusive &&
    tail.wholeBucketEndExclusive.getTime() <= head.wholeBucketStart.getTime()
  ) {
    return;
  }
  return {
    wholeBucketStart: head.wholeBucketStart,
    wholeBucketEndExclusive: tail.wholeBucketEndExclusive,
    headRange: head.headRange,
    tailRange: tail.tailRange,
  };
}

/**
 * The deduplicated per-bucket rows a windowed or unwindowed read aggregates.
 *
 * One rollup row exists per (session x branch x participation x source) and all
 * of them carry the same session totals for their bucket, so the inner grouping
 * collapses them to one row per (session, bucket) before anything is summed.
 */
export function branchAnalyticsRollupBucketPartsSql(
  organizationId: string,
  plan: BranchAnalyticsRollupWindowPlan | undefined
): Prisma.Sql {
  return Prisma.sql`
    SELECT
      rollup.session_artifact_id AS "agentSessionId",
      MAX(rollup.input_tokens) AS input_tokens,
      MAX(rollup.output_tokens) AS output_tokens,
      MAX(rollup.cache_read_tokens) AS cache_read_tokens,
      MAX(rollup.cache_write_tokens) AS cache_write_tokens,
      MAX(rollup.estimated_cost) AS estimated_cost,
      MIN(rollup.min_input_tokens) AS min_input_tokens,
      MIN(rollup.min_output_tokens) AS min_output_tokens,
      MIN(rollup.min_cache_read_tokens) AS min_cache_read_tokens,
      MIN(rollup.min_cache_write_tokens) AS min_cache_write_tokens,
      MIN(rollup.min_estimated_cost) AS min_estimated_cost,
      MAX(rollup.estimated_cost_event_count) AS estimated_cost_event_count,
      MAX(rollup.event_count) AS event_count
    FROM requested_sessions requested
    JOIN branch_analytics_session_rollups rollup
      ON rollup.session_artifact_id = requested.id
    WHERE rollup.organization_id = ${organizationId}::uuid
      AND rollup.source = ${BRANCH_ANALYTICS_ROLLUP_SOURCE}
      ${
        plan?.wholeBucketStart
          ? Prisma.sql`AND rollup.bucket_start >= ${plan.wholeBucketStart}`
          : Prisma.empty
      }
      ${
        plan?.wholeBucketEndExclusive
          ? Prisma.sql`AND rollup.bucket_start < ${plan.wholeBucketEndExclusive}`
          : Prisma.empty
      }
    GROUP BY rollup.session_artifact_id, rollup.bucket_start
  `;
}

/**
 * The partial edge days, aggregated straight from the source events.
 *
 * Pinned to the rollup's own `asOf` through the shared in-scope predicate, so
 * the two halves of one answer describe a single instant. Without that the edge
 * days would carry events newer than every whole bucket and the total would
 * reconcile against no clock at all.
 *
 * Bounded by construction: at most two ranges of under a day each, and the
 * `(agent_session_id, event_created_at)` index serves both as range scans.
 */
export function branchAnalyticsRollupEdgePartsSql(
  organizationId: string,
  plan: BranchAnalyticsRollupWindowPlan,
  asOf: Date
): Prisma.Sql {
  const ranges: Prisma.Sql[] = [];
  if (plan.headRange) {
    ranges.push(
      Prisma.sql`(
        event.event_created_at >= ${plan.headRange.startInclusive}
        AND event.event_created_at < ${plan.headRange.endExclusive}
      )`
    );
  }
  if (plan.tailRange) {
    ranges.push(
      Prisma.sql`(
        event.event_created_at >= ${plan.tailRange.startInclusive}
        AND event.event_created_at <= ${plan.tailRange.endInclusive}
      )`
    );
  }
  if (ranges.length === 0) {
    return Prisma.empty;
  }
  return Prisma.sql`
    UNION ALL
    SELECT
      event.agent_session_id AS "agentSessionId",
      SUM(event.input_tokens)::bigint AS input_tokens,
      SUM(event.output_tokens)::bigint AS output_tokens,
      SUM(event.cache_read_tokens)::bigint AS cache_read_tokens,
      SUM(event.cache_write_tokens)::bigint AS cache_write_tokens,
      SUM(event.estimated_cost) AS estimated_cost,
      MIN(event.input_tokens)::bigint AS min_input_tokens,
      MIN(event.output_tokens)::bigint AS min_output_tokens,
      MIN(event.cache_read_tokens)::bigint AS min_cache_read_tokens,
      MIN(event.cache_write_tokens)::bigint AS min_cache_write_tokens,
      MIN(event.estimated_cost) AS min_estimated_cost,
      COUNT(event.estimated_cost)::int AS estimated_cost_event_count,
      COUNT(*)::int AS event_count
    FROM requested_sessions requested
    JOIN agent_session_token_events event
      ON event.agent_session_id = requested.id
    JOIN session_detail session
      ON session.artifact_id = requested.id
    JOIN artifacts artifact
      ON artifact.id = session.artifact_id
    WHERE artifact.organization_id = ${organizationId}::uuid
      AND ${branchSessionTokenEventInScopeSql(asOf)}
      AND (${Prisma.join(ranges, " OR ")})
    GROUP BY event.agent_session_id
  `;
}

function resolveWindowHead(startDate: Date | undefined): {
  wholeBucketStart: Date | null;
  headRange: BranchAnalyticsRollupWindowPlan["headRange"];
} {
  if (!startDate) {
    return { wholeBucketStart: null, headRange: null };
  }
  const dayFloor = utcDayFloor(startDate);
  if (dayFloor.getTime() === startDate.getTime()) {
    return { wholeBucketStart: dayFloor, headRange: null };
  }
  const wholeBucketStart = utcNextDay(dayFloor);
  return {
    wholeBucketStart,
    headRange: { startInclusive: startDate, endExclusive: wholeBucketStart },
  };
}

function resolveWindowTail(endDate: Date | undefined): {
  wholeBucketEndExclusive: Date | null;
  tailRange: BranchAnalyticsRollupWindowPlan["tailRange"];
} {
  if (!endDate) {
    return { wholeBucketEndExclusive: null, tailRange: null };
  }
  const dayFloor = utcDayFloor(endDate);
  const nextDay = utcNextDay(dayFloor);
  if (endDate.getTime() + EVENT_CREATED_AT_TICK_MS >= nextDay.getTime()) {
    return { wholeBucketEndExclusive: nextDay, tailRange: null };
  }
  return {
    wholeBucketEndExclusive: dayFloor,
    tailRange: { startInclusive: dayFloor, endInclusive: endDate },
  };
}

function utcDayFloor(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())
  );
}

function utcNextDay(dayFloor: Date): Date {
  return new Date(dayFloor.getTime() + DAY_MS);
}

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * The smallest gap `agent_session_token_events.event_created_at` can represent.
 * The column is `TIMESTAMP(3)` and a JS `Date` bound is millisecond-precision
 * too, so `…T23:59:59.999Z` IS the last instant of its day and that day's whole
 * bucket answers the window exactly.
 *
 * This is the ONE place the column's precision is assumed, and the direction of
 * a wrong assumption is an OVER-count — a wider column would put events between
 * `.999` and midnight inside the bucket while the caller's `<= endDate` excludes
 * them. `branch-analytics-rollup.integration.test.ts` pins it against a real
 * Postgres by writing an event at a sub-millisecond offset.
 */
const EVENT_CREATED_AT_TICK_MS = 1;
