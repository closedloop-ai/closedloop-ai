import type {
  CategoryBucket,
  TimeSeries,
  TimeSeriesSeries,
} from "@repo/api/src/types/insights";
import { labelize } from "@repo/api/src/utils/string";
import { Prisma, withDb } from "@repo/database";
import { canonicalizeTimeZone } from "@/lib/date-only";
import { toNumber } from "@/lib/prisma-number";
import { eachDayKey, runDailyBucketedQuery } from "../lib/daily-buckets";
import { bucketByLabelCounts } from "./buckets";
import { type InsightsScopeContext, sessionScopeSql } from "./scope";

export async function countEvents(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Promise<number> {
  const [row] = await withDb((db) =>
    db.$queryRaw<{ n: bigint }[]>(Prisma.sql`
      ${scopedEventSessionsSql(ctx, start)}
      SELECT COALESCE(SUM(e.n), 0)::bigint AS n
      FROM scoped_event_sessions s
      CROSS JOIN LATERAL (
        SELECT COUNT(*) AS n
        FROM agent_session_events
        WHERE agent_session_id = s.artifact_id
          AND event_created_at >= ${start}
          AND event_created_at <= ${end}
      ) e
    `)
  );
  return toNumber(row.n);
}

/**
 * Captured-event count grouped by type, aggregated in the DB. Preserves the
 * prior in-JS behavior: labels are humanized and buckets that collapse to the
 * same label are merged, sorted by descending count.
 *
 * No LIMIT, by design (ISS-9842): the "Events by type" ring divides every slice
 * by the sum of the buckets it receives, so this array must BE the population.
 * A cap here would reintroduce that defect for the cloud ring; the desktop
 * Local twin caps at 12 and carries `population` on each bucket instead.
 */
export async function fetchEventTypeBuckets(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Promise<CategoryBucket[]> {
  const rows = await withDb((db) =>
    db.$queryRaw<{ eventType: string; n: bigint }[]>(Prisma.sql`
      ${scopedEventSessionsSql(ctx, start)}
      SELECT e.event_type AS "eventType", SUM(e.n)::bigint AS n
      FROM scoped_event_sessions s
      CROSS JOIN LATERAL (
        SELECT event_type, COUNT(*) AS n
        FROM agent_session_events
        WHERE agent_session_id = s.artifact_id
          AND event_created_at >= ${start}
          AND event_created_at <= ${end}
        GROUP BY event_type
      ) e
      GROUP BY e.event_type
    `)
  );
  return bucketByLabelCounts(
    rows.map((row) => ({
      label: labelize(row.eventType),
      value: toNumber(row.n),
    }))
  );
}

/**
 * Tool invocation count grouped by toolName, aggregated in the DB. Null
 * toolNames (non-tool events) are excluded, matching the prior JS filter.
 *
 * No LIMIT, by design (ISS-9842): the "Tool usage share" ring divides every
 * slice by the sum of the buckets it receives, so this array must BE the
 * population. A cap here would reintroduce that defect for the cloud ring; the
 * desktop Local twin caps at 20 and carries `population` on each bucket instead.
 */
export async function fetchToolUsageBuckets(
  ctx: InsightsScopeContext,
  start: Date,
  end: Date
): Promise<CategoryBucket[]> {
  const rows = await withDb((db) =>
    db.$queryRaw<{ toolName: string; n: bigint }[]>(Prisma.sql`
      ${scopedEventSessionsSql(ctx, start)}
      SELECT e.tool_name AS "toolName", SUM(e.n)::bigint AS n
      FROM scoped_event_sessions s
      CROSS JOIN LATERAL (
        SELECT tool_name, COUNT(*) AS n
        FROM agent_session_events
        WHERE agent_session_id = s.artifact_id
          AND event_created_at >= ${start}
          AND event_created_at <= ${end}
          AND tool_name IS NOT NULL
        GROUP BY tool_name
      ) e
      GROUP BY e.tool_name
    `)
  );
  return bucketByLabelCounts(
    rows
      .filter(
        (row): row is typeof row & { toolName: string } => row.toolName !== null
      )
      .map((row) => ({ label: row.toolName, value: toNumber(row.n) }))
  );
}

/**
 * Daily event volume over the trend window. date_trunc + COUNT(*) runs in
 * Postgres so only one already-bucketed row per day crosses the wire, instead
 * of every agentSessionEvent. `event_created_at` is a `timestamp` (no tz) that
 * stores the UTC wall-clock. FEA-2881: to bucket on the viewer's local calendar
 * day (matching the sibling Event activity chart and the desktop path, which
 * uses localDay()), reinterpret that wall-clock as UTC then convert it into
 * `timeZone` before truncating. `timeZone` must be a canonical IANA zone name:
 * the validator canonicalizes offset-style inputs (`+01:00`) to `Etc/GMT±N`
 * because PG's `AT TIME ZONE 'text'` mis-signs bare offsets relative to Intl
 * (FEA-2881 review). We re-canonicalize defensively here so a direct caller
 * can't slip an offset into the SQL; a zone that can't be canonicalized falls
 * back to legacy UTC bucketing. The name is bound as a parameter, so the
 * round-trip is per-request and independent of the connection's TimeZone.
 * FEA-3465: a canonical zone the PG server's tzdata rejects (version skew, which
 * canonicalizeTimeZone doesn't catch) likewise degrades to UTC — via the shared
 * {@link runDailyBucketedQuery} its sibling daily series already use — rather
 * than 500ing the whole utilization endpoint.
 */
export async function fetchEventVolume(
  ctx: InsightsScopeContext,
  trendStart: Date,
  end: Date,
  timeZone?: string
): Promise<TimeSeries> {
  const canonicalZone = timeZone ? canonicalizeTimeZone(timeZone) : null;
  const runQuery = (zone: string | undefined) => {
    const dayBucket = zone
      ? Prisma.sql`date_trunc('day', e.event_created_at AT TIME ZONE 'UTC' AT TIME ZONE ${zone}::text)`
      : Prisma.sql`date_trunc('day', e.event_created_at)`;
    return withDb((db) =>
      db.$queryRaw<{ day: string; n: number }[]>(
        Prisma.sql`
          ${scopedEventSessionsSql(ctx, trendStart)}
          SELECT e.day, SUM(e.n)::int AS n
          FROM scoped_event_sessions s
          CROSS JOIN LATERAL (
            SELECT
              to_char(${dayBucket}, 'YYYY-MM-DD') AS day,
              COUNT(*)::int AS n
            FROM agent_session_events e
            WHERE e.agent_session_id = s.artifact_id
              AND e.event_created_at >= ${trendStart}
              AND e.event_created_at <= ${end}
            GROUP BY day
          ) e
          GROUP BY e.day
        `
      )
    );
  };
  // Bucket in the canonical zone, degrading to UTC when the PG server's tzdata
  // rejects it (FEA-3465 — see runDailyBucketedQuery). `bucketedZone` then labels
  // the point enumeration in the SAME zone the DB actually bucketed in.
  const { rows, bucketedZone } = await runDailyBucketedQuery(
    canonicalZone ?? undefined,
    runQuery
  );
  const counts = new Map(rows.map((row) => [row.day, row.n]));
  const series: TimeSeriesSeries = { key: "events", label: "Events" };
  // Label the enumerated day keys with the same zone the SQL bucket used
  // (canonical zone normally, UTC on the tzdata-skew fallback), so JS-labeled
  // keys and SQL-bucketed rows land on identical dates.
  const points = eachDayKey(trendStart, end, bucketedZone).map((date) => ({
    date,
    values: { [series.key]: counts.get(date) ?? 0 },
  }));
  return { series: [series], points };
}

/** Scope before touching the high-volume event table; aggregate each indexed
 * session range before combining it. A broad event-time scan otherwise reads
 * other tenants' events before the organization join can discard them.
 *
 * `last_activity_at` is maintained as GREATEST(itself, MAX(event_created_at))
 * in the same transaction that writes the events (`persistSessionChildren`),
 * so a session whose last activity precedes `activeSince` holds no event at or
 * after it. Bounding here keeps the per-session probes to the window's sessions
 * instead of the org's whole history (#8602 review). */
function scopedEventSessionsSql(
  ctx: InsightsScopeContext,
  activeSince: Date
): Prisma.Sql {
  return Prisma.sql`WITH scoped_event_sessions AS MATERIALIZED (
    SELECT s.artifact_id
    FROM session_detail s
    JOIN artifacts a ON a.id = s.artifact_id
    WHERE (${sessionScopeSql(ctx)})
      AND s.last_activity_at >= ${activeSince}
  )`;
}
