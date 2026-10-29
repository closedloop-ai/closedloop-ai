import { Prisma, withDb } from "@repo/database";
import type { TokenTotals } from "@/app/insights/token-derivations";
import { runDailyBucketedQuery } from "../lib/daily-buckets";
import type { ModelUsageDayRow } from "./model-series";
import {
  type InsightsScopeContext,
  sessionScope,
  sessionScopeSql,
} from "./scope";

/**
 * Where clause shared by the token-usage aggregations: rows whose owning session
 * is in scope and started within [start, end]. Keep in lockstep with the raw-SQL
 * mirror in {@link fetchModelUsageRows} (see {@link sessionScopeSql}).
 */
function tokenUsageScope(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Prisma.AgentSessionTokenUsageWhereInput {
  return {
    session: {
      ...sessionScope(ctx),
      sessionStartedAt: { gte: start, lte: end },
    },
  };
}

/**
 * Token-column totals for the KPI row and the token-distribution donut, summed
 * in Postgres rather than by materializing every agentSessionTokenUsage row (one
 * per session×model — unbounded for the "all" period, which starts at the epoch)
 * and reducing in JS. Token columns are BigInt (int8); the insights surfaces work
 * in JS numbers (exact up to Number.MAX_SAFE_INTEGER), so narrow the sums at this
 * boundary, matching the prior per-row Number() cast.
 */
export async function fetchTokenTotals(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Promise<TokenTotals> {
  const { _sum } = await withDb((db) =>
    db.agentSessionTokenUsage.aggregate({
      where: tokenUsageScope(ctx, start, end),
      _sum: {
        inputTokens: true,
        outputTokens: true,
        cacheReadTokens: true,
        cacheWriteTokens: true,
      },
    })
  );
  return {
    inputTokens: Number(_sum.inputTokens ?? 0),
    outputTokens: Number(_sum.outputTokens ?? 0),
    cacheReadTokens: Number(_sum.cacheReadTokens ?? 0),
    cacheWriteTokens: Number(_sum.cacheWriteTokens ?? 0),
  };
}

/**
 * Per-day per-model spend over the trend window, date-bucketed in Postgres so
 * only one aggregate row per (day, model) crosses the wire instead of every
 * token row. Mirrors {@link fetchEventVolume}, but buckets `session_started_at`
 * in the requester's timezone (FEA-2745): the column is a tz-naive `timestamp`
 * holding the UTC wall-clock, so `AT TIME ZONE 'UTC'` reinterprets it as an
 * instant and `AT TIME ZONE ${zone}` shifts it to the local calendar day. A UTC
 * zone round-trips to the original wall-clock, matching makeDayKey(undefined)'s
 * legacy UTC bucketing. estimatedCost sums to float8 (USD); the series rounds to
 * cents once at emit time.
 */
export async function fetchModelUsageRows(
  ctx: InsightsScopeContext,
  trendStart: Date,
  end: Date,
  timeZone?: string
): Promise<{ rows: ModelUsageDayRow[]; bucketZone: string }> {
  const runQuery = (zone: string | undefined) =>
    withDb((db) =>
      db.$queryRaw<
        { day: string; model: string; cost: number; tokens: number }[]
      >(
        Prisma.sql`
          SELECT
            to_char(
              date_trunc(
                'day',
                (s.session_started_at AT TIME ZONE 'UTC') AT TIME ZONE ${zone ?? "UTC"}
              ),
              'YYYY-MM-DD'
            ) AS day,
            tu.model AS model,
            SUM(tu.estimated_cost)::float8 AS cost,
            -- FEA-3497: total token volume for the dollar/count usage toggle.
            -- Sums input + output + cache read/write so the usage view reflects
            -- real work done (cache-heavy harnesses move huge volume cheaply).
            -- float8 keeps the driver yielding plain numbers, matching cost.
            SUM(
              tu.input_tokens + tu.output_tokens
              + tu.cache_read_tokens + tu.cache_write_tokens
            )::float8 AS tokens
          FROM agent_session_token_usage tu
          JOIN session_detail s ON s.artifact_id = tu.agent_session_id
          JOIN artifacts a ON a.id = s.artifact_id
          WHERE s.session_started_at >= ${trendStart}
            AND s.session_started_at <= ${end}
            AND (${sessionScopeSql(ctx)})
          GROUP BY day, tu.model
          -- ISS-8052: the emitted row order is USER-VISIBLE. stackModelSeries
          -- inserts these rows into a plain object in arrival order and
          -- JSON.stringify preserves insertion order, so an unordered GROUP BY
          -- serializes the same numbers under a different key order whenever the
          -- planner switches between a sorted aggregate and a HashAggregate.
          -- Order by the grouping keys so the bytes are a property of the data.
          ORDER BY day, tu.model
        `
      )
    );

  // Bucket in the requester's timezone, degrading to UTC when the PG server's
  // tzdata rejects it (see runDailyBucketedQuery). `bucketZone` is the zone the
  // rows were actually keyed in — `timeZone` on the happy path, "UTC" when it's
  // unset or the tzdata-skew fallback fires — so the caller enumerates chart day
  // keys in the same zone (otherwise UTC row keys wouldn't match local-zone point
  // keys near day boundaries and spend would be dropped or misattributed).
  const { rows: raw, bucketedZone } = await runDailyBucketedQuery(
    timeZone,
    runQuery
  );
  const bucketZone = bucketedZone ?? "UTC";

  return {
    bucketZone,
    rows: raw.map((row) => ({
      day: row.day,
      model: row.model,
      cost: Number(row.cost),
      tokens: Number(row.tokens),
    })),
  };
}
