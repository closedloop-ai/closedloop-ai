import type {
  TimeSeries,
  TimeSeriesSeries,
} from "@repo/api/src/types/insights";
import { Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { eachDayKey, runDailyBucketedQuery } from "../lib/daily-buckets";
import { type InsightsScopeContext, sessionScopeSql } from "./scope";

type FrustrationDayRow = {
  day: string;
  // Sum + count of the SCOPED (Me/Team/Org) scored sessions in this day's
  // bucket, so the per-day mean reflects the requested view. Null/0 when the
  // scope contributed no scored session on a day the org population still did.
  total: number;
  sessions: number;
  // The org population's MAX single-session raw within this day's bucket
  // (UNSCOPED by Me/Team). MAX-of-per-day-orgDayMax over the window is the org
  // population's observed max raw signal (the [0, max] normalization basis) —
  // computed in the same grouped query so it can never disagree with the per-day
  // means.
  orgDayMax: number;
};

/**
 * FEA-4022 (PLN-1481): daily MEAN session frustration, NORMALIZED 0–100 against
 * the org POPULATION's observed MAX single-session raw signal over the same
 * window.
 *
 * The persisted `frustration_raw` is deliberately unbounded and org-scoped, so a
 * fixed 0..100 mapping can't be frozen on the row — the population max drifts as
 * more sessions land (fluctuates on small data, stabilizes after a few hundred).
 * So we aggregate per-day SUM/COUNT/MAX raw in ONE query (each SessionDetail is
 * one row keyed by artifact_id — no linkage fan-out, so a session counts once),
 * take the population max as MAX(dayMax) across the window, then map each day's
 * MEAN raw to round(dayMean / populationMax * 100) in JS. A day mean can never
 * exceed the max single-session raw, so the normalized value stays within
 * [0, 100]. NULL-raw rows (unscored / org opted-out sessions) are excluded from
 * every aggregate so they never dilute the mean or the normalization basis.
 *
 * Returns undefined when no session in the window carries a raw signal (nothing
 * to show / population max is 0) so the caller omits the chart entirely.
 */
async function fetchFrustrationTrend(
  ctx: InsightsScopeContext,
  trendStart: Date,
  end: Date
): Promise<TimeSeries | undefined> {
  const runQuery = (timeZone: string | undefined) => {
    const dayExpr = timeZone
      ? Prisma.sql`date_trunc('day', (s.session_started_at AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone})`
      : Prisma.sql`date_trunc('day', s.session_started_at)`;
    // FEA-4022 (T16): the per-day MEAN is scoped to the requested view (Me /
    // Team / Org), but the normalization DENOMINATOR (`orgDayMax`) is the org
    // population's max single-session raw over the same window, independent of
    // the Me/Team scope — the contract normalizes every scope against the org
    // population, so a user's raw of 5 reads the same whether viewed as Me or
    // Org. A per-day scoped mean can never exceed the org population max, so the
    // normalized value stays within [0, 100].
    return withDb((db) =>
      db.$queryRaw<FrustrationDayRow[]>(
        Prisma.sql`
          SELECT
            to_char(${dayExpr}, 'YYYY-MM-DD') AS day,
            SUM(s.frustration_raw) FILTER (WHERE ${sessionScopeSql(ctx)})::float8 AS total,
            COUNT(*) FILTER (WHERE ${sessionScopeSql(ctx)})::int AS sessions,
            MAX(s.frustration_raw)::float8 AS "orgDayMax"
          FROM session_detail s
          JOIN artifacts a ON a.id = s.artifact_id
          WHERE s.session_started_at >= ${trendStart}
            AND s.session_started_at <= ${end}
            AND s.frustration_raw IS NOT NULL
            AND a.organization_id = ${ctx.organizationId}::uuid
          GROUP BY day
        `
      )
    );
  };

  const { rows, bucketedZone } = await runDailyBucketedQuery(
    ctx.timeZone,
    runQuery
  );
  // Population basis: the org's observed MAX single-session raw over the window
  // (MAX of each day's org-wide MAX), independent of the Me/Team scope.
  let populationMax = 0;
  // Only days with at least one SCOPED scored session get a mean; a day with no
  // scored sessions in the selected scope is a genuine gap.
  const meanByDay = new Map<string, number>();
  for (const row of rows) {
    const dayMax = Number(row.orgDayMax);
    if (dayMax > populationMax) {
      populationMax = dayMax;
    }
    const sessions = Number(row.sessions);
    if (sessions <= 0) {
      continue;
    }
    meanByDay.set(row.day, Number(row.total) / sessions);
  }
  // Omit the chart when either (a) the org population has no scored session to
  // normalize against, or (b) the SELECTED scope (Me / Team, incl. Team with no
  // teamId → scope predicate is `false`) contributed no scored session — a chart
  // that is null on every day is "no data for your scope", not a curve, so omit
  // it rather than render an all-gap axis.
  if (populationMax <= 0 || meanByDay.size === 0) {
    return;
  }
  const series: TimeSeriesSeries = {
    key: "frustration",
    label: "Frustration",
  };
  const points = eachDayKey(trendStart, end, bucketedZone).map((date) => {
    const mean = meanByDay.get(date);
    // FEA-4022 (T17): a day with no scored sessions is a GAP (null), not a
    // measured calm zero. `TimeSeriesPoint.values` reserves null for "no
    // activity" so the chart renders a break instead of a false calm floor
    // (mirrors the autonomy series' null-gap convention).
    const normalized =
      mean === undefined ? null : Math.round((mean / populationMax) * 100);
    return { date, values: { [series.key]: normalized } };
  });
  return { series: [series], points };
}

/**
 * FEA-4022 (T15): fail-open wrapper around the frustration trend aggregate. The
 * trend is one widget on the all-or-nothing Agents response — its extra grouped
 * query must never cascade a failure to the other widgets. On any error the
 * chart is omitted (the empty state), and the failure is logged server-side for
 * diagnosis rather than turned into a page-wide 500.
 */
export async function fetchFrustrationTrendSafe(
  ctx: InsightsScopeContext,
  trendStart: Date,
  end: Date
): Promise<TimeSeries | undefined> {
  try {
    return await fetchFrustrationTrend(ctx, trendStart, end);
  } catch (error) {
    log.error("insights: frustration trend query failed; omitting chart", {
      organizationId: ctx.organizationId,
      scope: ctx.scope,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
}
