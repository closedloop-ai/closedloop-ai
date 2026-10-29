import { INSIGHTS_USER_BREAKDOWN_ROW_CAP } from "@closedloop-ai/loops-api/insights";
import type {
  CategoryBucket,
  TimeSeries,
  TimeSeriesSeries,
} from "@repo/api/src/types/insights";
import { labelize } from "@repo/api/src/utils/string";
import { Prisma, withDb } from "@repo/database";
import { SESSIONS_SURFACE_DATE_FIELD } from "@/app/agent-sessions/service/session-date-field";
import { toNumber } from "@/lib/prisma-number";
import { displayUserName } from "@/lib/user-display-name";
import { eachDayKey, runDailyBucketedQuery } from "../lib/daily-buckets";
import { bucketByLabelCounts } from "./buckets";
import type { SessionsWindow } from "./period";
import {
  type InsightsScopeContext,
  sessionScope,
  sessionScopeSql,
} from "./scope";

const MS_PER_SECOND = 1000;

/**
 * The two agent charts (agentsByStatus / agentsByType) rolled up in the DB
 * (FEA-2955). Each session's `agents` JSON array is unnested and grouped by the
 * raw status/type in Postgres — mirroring desktop's two `agent.groupBy()` calls
 * — so only one already-counted row per distinct value crosses the wire, rather
 * than materializing every session row and reducing the JSON arrays in JS.
 *
 * FEA-3638 (Tier-2 round-trip collapse): both charts read the SAME unnest of the
 * SAME session window, so they are rolled up in ONE DB round-trip — a single
 * scan whose derived `status`/`type` bucket columns are aggregated with `GROUP BY
 * GROUPING SETS` — instead of two separate `withDb` calls. That drops one
 * concurrent connection off the agents endpoint's fan-out against the max:20
 * Vercel pool (relieving the acquire-timeout queue-wait that surfaced as the
 * dashboard hang). The per-element bucketing (the "unknown" fallback for a
 * missing/blank/non-string value), the labelize + collision-merge, and the
 * org/period scope predicate are all identical to the prior per-field query, so
 * both charts are byte-for-byte unchanged.
 */
export async function fetchAgentBuckets(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Promise<{ byStatus: CategoryBucket[]; byType: CategoryBucket[] }> {
  const rows = await withDb((db) =>
    db.$queryRaw<{ field: "status" | "type"; bucket: string; n: number }[]>(
      // One scan of the unnested agents; each element contributes a `status_bucket`
      // and a `type_bucket` (the same "unknown" fallback as before). GROUPING SETS
      // ((status_bucket), (type_bucket)) then rolls up each field independently in a
      // single pass: a status-grouping row has type_bucket NULL and vice-versa, so
      // GROUPING() tags which field the row belongs to and COALESCE picks the
      // non-null bucket value. The derived bucket columns are never NULL (the CASE
      // always yields a string), so the disambiguation is unambiguous.
      Prisma.sql`
        SELECT
          CASE WHEN GROUPING(status_bucket) = 0 THEN 'status' ELSE 'type' END AS field,
          COALESCE(status_bucket, type_bucket) AS bucket,
          COUNT(*)::int AS n
        FROM (
          SELECT
            CASE
              WHEN jsonb_typeof(elem -> 'status') = 'string'
                AND btrim(elem ->> 'status') <> ''
              THEN elem ->> 'status'
              ELSE 'unknown'
            END AS status_bucket,
            CASE
              WHEN jsonb_typeof(elem -> 'type') = 'string'
                AND btrim(elem ->> 'type') <> ''
              THEN elem ->> 'type'
              ELSE 'unknown'
            END AS type_bucket
          FROM session_detail s
          JOIN artifacts a ON a.id = s.artifact_id
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(s.agents) = 'array' THEN s.agents
              ELSE '[]'::jsonb
            END
          ) AS elem
          WHERE s.session_started_at >= ${start}
            AND s.session_started_at <= ${end}
            AND jsonb_typeof(elem) = 'object'
            AND (${sessionScopeSql(ctx)})
        ) unnested
        GROUP BY GROUPING SETS ((status_bucket), (type_bucket))
      `
    )
  );
  const bucketsFor = (field: "status" | "type"): CategoryBucket[] =>
    bucketByLabelCounts(
      rows
        .filter((row) => row.field === field)
        .map((row) => ({ label: labelize(row.bucket), value: row.n }))
    );
  return { byStatus: bucketsFor("status"), byType: bucketsFor("type") };
}

/**
 * Single-scan DB rollup of the SessionDetail rows in range: the session count
 * (KPI), summed runtime in ms, and the per-status breakdown — all pure
 * aggregates the DB computes so the (epoch-start, potentially unbounded) row set
 * is never materialized. Runtime mirrors the prior per-row reducer: open
 * sessions (no `session_ended_at`) and any negative span contribute 0 via
 * GREATEST/the NULL-swallowing SUM. Status labels are humanized and merged,
 * matching the prior in-JS bucketing of `labelize(status || "unknown")`.
 */
export async function fetchSessionRollup(
  ctx: InsightsScopeContext,
  window: SessionsWindow
): Promise<{
  sessionCount: number;
  runtimeMs: number;
  statusBuckets: CategoryBucket[];
}> {
  const rows = await withDb((db) =>
    db.$queryRaw<
      { status: string | null; n: number; runtimeSeconds: number | null }[]
    >(
      Prisma.sql`
        SELECT
          a.status AS status,
          COUNT(*)::int AS n,
          COALESCE(
            SUM(
              GREATEST(
                EXTRACT(EPOCH FROM (s.session_ended_at - s.session_started_at)),
                0
              )
            ),
            0
          ) AS "runtimeSeconds"
        FROM session_detail s
        JOIN artifacts a ON a.id = s.artifact_id
        WHERE ${sessionWindowSql(window)}
          AND (${sessionScopeSql(ctx)})
        GROUP BY a.status
      `
    )
  );
  let sessionCount = 0;
  let runtimeSeconds = 0;
  for (const row of rows) {
    sessionCount += row.n;
    runtimeSeconds += Number(row.runtimeSeconds ?? 0);
  }
  const statusBuckets = bucketByLabelCounts(
    rows.map((row) => ({
      label: labelize(row.status || "unknown"),
      value: row.n,
    }))
  );
  return {
    sessionCount,
    runtimeMs: Math.round(runtimeSeconds * MS_PER_SECOND),
    statusBuckets,
  };
}

/**
 * Per-user session counts for the org "user breakdown" chart ("Sessions by
 * operator"), grouped in the DB by the session's creator (`a.created_by_id`,
 * ISS-12251 D-4) and joined to that user for the display label. Creator-less
 * sessions (creator deleted → created_by_id nulled) are excluded, mirroring the
 * prior JS reducer.
 *
 * ISS-8052: the sort is TOTAL, not just `n DESC`. Equal counts fell through to
 * the arrival order of an unordered `GROUP BY`, which decides both this array's
 * serialized order (it reaches the byte-compared Layer 5.3 fixture) and — under
 * the `INSIGHTS_USER_BREAKDOWN_ROW_CAP` limit — WHICH tied users are shown at all. `u.email` is the stable
 * human-meaningful tiebreak; `a.created_by_id` after it makes the ordering total
 * without relying on email uniqueness.
 */
export async function fetchUserBreakdown(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Promise<CategoryBucket[]> {
  const rows = await withDb((db) =>
    db.$queryRaw<
      {
        userId: string;
        firstName: string | null;
        lastName: string | null;
        email: string;
        n: number;
      }[]
    >(
      Prisma.sql`
        SELECT
          a.created_by_id AS "userId",
          u.first_name AS "firstName",
          u.last_name AS "lastName",
          u.email AS email,
          COUNT(*)::int AS n
        FROM session_detail s
        JOIN artifacts a ON a.id = s.artifact_id
        JOIN users u ON u.id = a.created_by_id
        -- Deliberately NOT aligned (ISS-10541). ISS-10604's ruling scoped the
        -- alignment to the Sessions count, the cost, and the day series under
        -- them; a per-user decomposition is none of those, it has no desktop
        -- analogue to stay in parity with, and the LIMIT below means its rows
        -- never summed to the tile anyway. Moving it would be an unstated
        -- population change on an org-visible chart with nothing asserting it.
        WHERE s.session_started_at >= ${start}
          AND s.session_started_at <= ${end}
          AND a.created_by_id IS NOT NULL
          AND (${sessionScopeSql(ctx)})
        GROUP BY a.created_by_id, u.first_name, u.last_name, u.email
        ORDER BY n DESC, u.email ASC, a.created_by_id ASC
        LIMIT ${INSIGHTS_USER_BREAKDOWN_ROW_CAP}
      `
    )
  );
  return rows.map((row) => ({
    key: row.userId,
    label: displayUserName({
      firstName: row.firstName,
      lastName: row.lastName,
      email: row.email,
    }),
    value: row.n,
  }));
}

/**
 * Shared scaffolding for a daily `session_detail` aggregate over the trend
 * window, date-bucketed in Postgres so only one already-bucketed row per day
 * crosses the wire (mirrors {@link fetchEventVolume}). `session_started_at` is a
 * `timestamp` (no tz) that stores the UTC wall-clock; truncating it directly
 * yields UTC day keys. When a requester timezone is set (FEA-2745) the instant
 * is reinterpreted as UTC and converted into that zone before truncation so the
 * bucket matches the local calendar day the JS `makeDayKey` would assign — the
 * explicit `AT TIME ZONE 'UTC'` anchor keeps the round-trip independent of the
 * connection's TimeZone. {@link fetchSessionActivity} and
 * {@link fetchToolRunsByDay} differ only in the aggregate expression and the
 * series key/label, so both delegate here rather than duplicating the
 * retry/bucketing logic.
 */
async function fetchDailySessionSeries(
  ctx: InsightsScopeContext,
  trendStart: Date,
  end: Date,
  opts: {
    aggregateExpr: Prisma.Sql;
    seriesKey: string;
    seriesLabel: string;
    /**
     * ISS-10604: the column this series both WINDOWS and BUCKETS on — one
     * value for both, because a row admitted by the window and bucketed by a
     * different column lands on a day the chart's own axis may not cover.
     * Per-caller rather than off the context: only the Sessions series moves
     * with the Sessions KPI it sits under, and the tool-runs series that shares
     * this scaffolding is deliberately left on session start.
     */
    windowColumn: Prisma.Sql;
  }
): Promise<TimeSeries> {
  const runQuery = (timeZone: string | undefined) => {
    const dayExpr = timeZone
      ? Prisma.sql`date_trunc('day', (${opts.windowColumn} AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone})`
      : Prisma.sql`date_trunc('day', ${opts.windowColumn})`;
    return withDb((db) =>
      db.$queryRaw<{ day: string; n: number }[]>(
        Prisma.sql`
          SELECT
            to_char(${dayExpr}, 'YYYY-MM-DD') AS day,
            ${opts.aggregateExpr} AS n
          FROM session_detail s
          JOIN artifacts a ON a.id = s.artifact_id
          WHERE ${opts.windowColumn} >= ${trendStart}
            AND ${opts.windowColumn} <= ${end}
            AND (${sessionScopeSql(ctx)})
          GROUP BY day
        `
      )
    );
  };

  // Bucket in `ctx.timeZone`, degrading to UTC when the PG server's tzdata
  // rejects it (see runDailyBucketedQuery). `bucketedZone` then labels the point
  // enumeration in the SAME zone the DB actually bucketed in.
  const { rows, bucketedZone } = await runDailyBucketedQuery(
    ctx.timeZone,
    runQuery
  );
  const counts = new Map(rows.map((row) => [row.day, row.n]));
  const series: TimeSeriesSeries = {
    key: opts.seriesKey,
    label: opts.seriesLabel,
  };
  const points = eachDayKey(trendStart, end, bucketedZone).map((date) => ({
    date,
    values: { [series.key]: counts.get(date) ?? 0 },
  }));
  return { series: [series], points };
}

/**
 * Daily session-activity volume — one row per session, counted per day.
 *
 * ISS-10541: LAST ACTIVITY, not session start. Both the window and the day
 * bucket come from {@link sessionWindowColumn}, so this series and the Sessions
 * KPI it is drawn under measure one population.
 */
export function fetchSessionActivity(
  ctx: InsightsScopeContext,
  trendStart: Date,
  end: Date
): Promise<TimeSeries> {
  return fetchDailySessionSeries(ctx, trendStart, end, {
    aggregateExpr: Prisma.sql`COUNT(*)::int`,
    seriesKey: "sessions",
    seriesLabel: "Sessions",
    // Moves with the Sessions KPI this series is drawn under (ISS-10604).
    windowColumn: sessionWindowColumn(),
  });
}

export function countSessions(
  ctx: InsightsScopeContext,
  start: Date | null,
  end: Date
): Promise<number> {
  if (!start) {
    return Promise.resolve(0);
  }
  return withDb((db) =>
    db.sessionDetail.count({
      where: {
        ...sessionScope(ctx),
        ...sessionWindowWhere({ start, end }),
      },
    })
  );
}

/**
 * Daily tool-run totals over the trend window, summed in Postgres so only one
 * already-bucketed row per day crosses the wire (mirrors
 * {@link fetchSessionActivity}) instead of materializing every session row and
 * reducing in JS. Buckets `session_started_at` — a tz-naive `timestamp` holding
 * the UTC wall-clock — in the requester's timezone (FEA-2745, FEA-2956): the
 * explicit `AT TIME ZONE 'UTC'` anchor reinterprets it as an instant and
 * `AT TIME ZONE ${zone}` shifts it to the local calendar day, matching the JS
 * `makeDayKey` bucketing. `tool_use_count` is an `Int`, so `SUM(...)::int`
 * keeps the driver yielding plain numbers.
 */
export function fetchToolRunsByDay(
  ctx: InsightsScopeContext,
  trendStart: Date,
  end: Date
): Promise<TimeSeries> {
  return fetchDailySessionSeries(ctx, trendStart, end, {
    aggregateExpr: Prisma.sql`SUM(s.tool_use_count)::int`,
    seriesKey: "tool-runs",
    seriesLabel: "Tool runs",
    // Deliberately NOT aligned: tool runs are not drawn beside a moved card,
    // and ISS-10604's ruling scoped the alignment to the Sessions count, the
    // cost, and the day series under them.
    windowColumn: Prisma.sql`s.session_started_at`,
  });
}

export async function sumSessionCost(
  ctx: InsightsScopeContext,
  window: SessionsWindow
): Promise<number> {
  const result = await withDb((db) =>
    db.sessionDetail.aggregate({
      _sum: { estimatedCost: true },
      where: {
        ...sessionScope(ctx),
        ...sessionWindowWhere(window),
      },
    })
  );
  return toNumber(result._sum.estimatedCost);
}

export async function sumToolRuns(
  ctx: InsightsScopeContext,
  start: Date | null,
  end: Date
): Promise<number> {
  if (!start) {
    return 0;
  }
  const result = await withDb((db) =>
    db.sessionDetail.aggregate({
      _sum: { toolUseCount: true },
      where: {
        ...sessionScope(ctx),
        // ISS-10541: `lte`, the same inclusive bound `fetchToolRunsByDay`'s raw
        // SQL uses (`<= ${end}`). The COLUMN here stays `sessionStartedAt` —
        // ISS-10604's ruling leaves tool runs on session start — but the two
        // tool-runs reads share that column, so an exclusive bound here alone
        // dropped a session started exactly at `stableUtcDayEnd` out of the KPI
        // while the chart beneath it kept the row.
        sessionStartedAt: { gte: start, lte: end },
      },
    })
  );
  return result._sum.toolUseCount ?? 0;
}

/**
 * ISS-10604, made unconditional by ISS-10541 — the SQL column this read's date
 * range is compared against.
 *
 * `session_detail` stores both timestamps, and which one a window uses decides
 * the POPULATION, not just the ordering: a session that started before the
 * range and was last active inside it satisfies `last_activity_at` and not
 * `session_started_at`. ISS-10604 shipped the alignment behind
 * `sessions-analytics-activity-window`; with the flag default-off the dashboard
 * tile counted 1,399 against the Sessions list's 1,290 for one week, which is
 * the defect ISS-10541 exists to remove. The cohort is retired: there is no
 * second basis left for these reads to be on, so nothing resolves a field and
 * no viewer can be served the old one.
 *
 * This function governs the dashboard rollup, not every unrelated reporting
 * reader; those readers retain their own explicit window predicates.
 */
function sessionWindowColumn(): Prisma.Sql {
  return Prisma.sql`s.last_activity_at`;
}

/**
 * The Prisma delegate field for {@link sessionWindowColumn}'s column, on the
 * SAME bound the raw SQL uses.
 *
 * ISS-10541: `lte`, not `lt`. `resolvePeriodRange` ends the window at
 * `stableUtcDayEnd` — 23:59:59.999Z, the last representable instant, i.e. a
 * deliberately INCLUSIVE bound (packages/loops-api/src/stable-utc-window.ts) —
 * and `fetchSessionRollup` honours it with `<= ${end}`. An exclusive bound here
 * dropped a session last active exactly at that instant out of the cost sum and
 * out of `countSessions` while the rendered Sessions KPI counted it, so the two
 * tiles priced different cohorts at the window edge and the WoW delta's
 * numerator and denominator were computed on two different boundary
 * conventions. Aligning the COLUMN without aligning the BOUND leaves the same
 * class of disagreement this ticket exists to remove.
 */
function sessionWindowWhere(
  window: SessionsWindow
): Prisma.SessionDetailWhereInput {
  if (!(window.start || window.end)) {
    return {};
  }
  return {
    [SESSIONS_SURFACE_DATE_FIELD]: {
      ...(window.start ? { gte: window.start } : {}),
      ...(window.end ? { lte: window.end } : {}),
    },
  };
}

/**
 * The raw-SQL twin of {@link sessionWindowWhere}. ISS-12263: an absent bound
 * emits no comparison, as the Sessions list's `applyDateFilter` does, so the
 * all-time rollup counts a session last active after today's UTC end.
 */
function sessionWindowSql(window: SessionsWindow): Prisma.Sql {
  const lower = window.start
    ? Prisma.sql`${sessionWindowColumn()} >= ${window.start}`
    : Prisma.sql`TRUE`;
  const upper = window.end
    ? Prisma.sql`${sessionWindowColumn()} <= ${window.end}`
    : Prisma.sql`TRUE`;
  return Prisma.sql`${lower} AND ${upper}`;
}
