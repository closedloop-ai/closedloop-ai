import type {
  AgentsInsightsResponse,
  CategoryBucket,
  DeliveryInsightsResponse,
  InsightsPeriod,
  KpiStat,
  TimeSeries,
  TimeSeriesSeries,
  UtilizationInsightsResponse,
} from "@closedloop-ai/loops-api/insights";
import {
  InsightsPeriod as InsightsPeriodValues,
  InsightsSection,
  KpiFormat,
} from "@closedloop-ai/loops-api/insights";
import {
  addStorageTokenCounts,
  readStorageTokenCount,
} from "../token-counts.js";
import type { DesktopPrisma } from "./prisma-client.js";

const MS_PER_DAY = 86_400_000;
const TREND_LOOKBACK_DAYS = 90;
const MAX_MODEL_SERIES = 6;
const LABEL_SEPARATOR_PATTERN = /[-_:]/;

// --- "Human" session classification (activity heatmap Human/Agent split) ------
//
// The SINGLE definition of a "human-interactive" session, factored out so the
// rule lives in one place and is easy to tune as the product definition firms
// up. The activity heatmap splits event density into Human vs Agent by this
// rule; "agent" is simply its complement (headless/`-p` runs and spawned
// sub-agents).
//
// Current rule: a session is human-interactive iff the human took at least
// HUMAN_TURN_THRESHOLD turns — i.e. the human STEERED it (the initial prompt
// PLUS at least one more turn). A single-prompt run (`-p`/headless, or an
// autonomous/spawned sub-agent) counts as agent. The shared ActivityHeatmap
// contract describes this loosely as "submitted a user prompt"; the operational
// bar here is the stricter "steered" reading. If the product definition changes
// (e.g. one prompt = human), adjust HUMAN_TURN_THRESHOLD and the contract doc
// together — this is the only place the SQL encodes it.
// FEA-2038: the human/agent session classification (HUMAN_TURN_THRESHOLD, the
// user/prompt turn predicate, and the metadata fallback) now lives at INGEST in
// `session_analytics.is_human` (see upsertSessionAnalyticsRollup in sqlite.ts).
// The insights queries read the precomputed flag/counts instead of re-deriving
// them per page load, so the on-the-fly classification SQL was removed here.

type LocalInsightsResponse =
  | DeliveryInsightsResponse
  | UtilizationInsightsResponse
  | AgentsInsightsResponse;

/**
 * Local-database Insights backend for the desktop shell. Computes the same
 * shaped section responses the cloud `apps/api` returns, but against the
 * in-process SQLite database (the user's own data). Desktop is always personal
 * scope and returns the same response shape as the web Insights backend.
 */
export function computeLocalInsights(
  prisma: DesktopPrisma,
  section: InsightsSection,
  period: InsightsPeriod,
  now: Date = new Date()
): Promise<LocalInsightsResponse> {
  const range = resolveRange(period, now);
  if (section === InsightsSection.Agents) {
    return computeAgents(prisma, range);
  }
  if (section === InsightsSection.Utilization) {
    return computeUtilization(prisma, range);
  }
  return computeDelivery(prisma, range);
}

type Range = {
  startIso: string;
  endIso: string;
  trendStartIso: string;
  priorStartIso: string;
};

async function computeAgents(
  prisma: DesktopPrisma,
  range: Range
): Promise<AgentsInsightsResponse> {
  // token_usage has no Prisma relation to sessions (no DB FK — see schema), and
  // this is a COUNT(DISTINCT)/SUM aggregate over the join, so it stays raw.
  const totals = await prisma.client.$queryRawUnsafe<
    {
      input_tokens: bigint;
      output_tokens: bigint;
      cache_read_tokens: bigint;
      cache_write_tokens: bigint;
      tokens: bigint;
      models: bigint;
    }[]
  >(
    `SELECT COALESCE(SUM(t.input_tokens), 0) AS input_tokens,
            COALESCE(SUM(t.output_tokens), 0) AS output_tokens,
            COALESCE(SUM(t.cache_read_tokens), 0) AS cache_read_tokens,
            COALESCE(SUM(t.cache_write_tokens), 0) AS cache_write_tokens,
            COALESCE(SUM(t.input_tokens + t.output_tokens), 0) AS tokens,
            COUNT(DISTINCT t.model) AS models
     FROM token_usage t
     JOIN sessions s ON s.id = t.session_id
     WHERE s.started_at IS NOT NULL
       AND s.started_at BETWEEN $1 AND $2
       AND t.model IS NOT NULL`,
    range.startIso,
    range.endIso
  );
  // `tools` / `toolUsage` aggregate over `events`, which has no Prisma relation
  // to `sessions` (events can predate their session) — raw. `agentsByStatus` /
  // `agentsByType` ARE typed: agents reach sessions via the real `session`
  // relation, so the date filter is a relation-where and the COUNT is a groupBy.
  const [tools, toolUsage, agentsByStatus, agentsByType] = await Promise.all([
    prisma.client.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*) AS n
     FROM events e
     JOIN sessions s ON s.id = e.session_id
     WHERE e.tool_name IS NOT NULL
       AND s.started_at IS NOT NULL
       AND s.started_at BETWEEN $1 AND $2`,
      range.startIso,
      range.endIso
    ),
    prisma.client.$queryRawUnsafe<{ tool_name: string; n: bigint }[]>(
      `SELECT e.tool_name AS tool_name, COUNT(*) AS n
       FROM events e
       JOIN sessions s ON s.id = e.session_id
       WHERE e.tool_name IS NOT NULL
         AND s.started_at IS NOT NULL
         AND s.started_at BETWEEN $1 AND $2
       GROUP BY e.tool_name
       ORDER BY n DESC, e.tool_name ASC
       LIMIT 20`,
      range.startIso,
      range.endIso
    ),
    prisma.client.agent.groupBy({
      by: ["status"],
      where: {
        session: { startedAt: { gte: range.startIso, lte: range.endIso } },
      },
      _count: { _all: true },
    }),
    prisma.client.agent.groupBy({
      by: ["type"],
      where: {
        session: { startedAt: { gte: range.startIso, lte: range.endIso } },
      },
      _count: { _all: true },
    }),
  ]);
  const toolsOverTime = await prisma.client.$queryRawUnsafe<
    { day: string; n: bigint }[]
  >(
    `SELECT substr(s.started_at,1,10) AS day,
            COUNT(*) AS n
     FROM events e
     JOIN sessions s ON s.id = e.session_id
     WHERE e.tool_name IS NOT NULL
       AND s.started_at IS NOT NULL
       AND s.started_at BETWEEN $1 AND $2
     GROUP BY day`,
    range.trendStartIso,
    range.endIso
  );
  const breakdown = await prisma.client.$queryRawUnsafe<
    { model: string; value: bigint }[]
  >(
    // Parity: Postgres returned value as ::text and ORDER BY value DESC sorted
    // it LEXICALLY ("800" > "5500"). The golden encodes that text ordering, so
    // sort by the text form of the sum to reproduce it exactly.
    `SELECT t.model AS model, SUM(t.input_tokens + t.output_tokens) AS value
     FROM token_usage t
     JOIN sessions s ON s.id = t.session_id
     WHERE s.started_at BETWEEN $1 AND $2 AND t.model IS NOT NULL
     GROUP BY t.model
     ORDER BY CAST(SUM(t.input_tokens + t.output_tokens) AS TEXT) DESC`,
    range.startIso,
    range.endIso
  );
  const overTime = await prisma.client.$queryRawUnsafe<
    {
      day: string;
      model: string;
      value: bigint;
    }[]
  >(
    `SELECT substr(s.started_at,1,10) AS day,
            t.model AS model,
            SUM(t.input_tokens + t.output_tokens) AS value
     FROM token_usage t
     JOIN sessions s ON s.id = t.session_id
     WHERE s.started_at BETWEEN $1 AND $2 AND t.model IS NOT NULL
     GROUP BY day, t.model`,
    range.trendStartIso,
    range.endIso
  );
  // Daily median session-autonomy index (0 manual → 100 agentic). Per session:
  // share of conversational turns that were the agent's (assistant turns) vs the
  // human's (user/prompt turns) — more agent turns per human turn ⇒ more
  // autonomous. SQL-derived index; distinct from the read-time detail score.
  // FEA-2038: autonomy-over-time now pulls from the SAME source as the activity
  // heatmap — events joined to the precomputed per-session `is_human` flag. Per
  // day it is the share of event activity that came from agent (non-human-steered)
  // sessions (0 = all human-steered, 100 = all agentic), so the trend line and the
  // heatmap's Human/Agent split always agree. (The old per-session assistant/human
  // turn ratio went flat at 0 for harnesses whose events carry no "assistant"
  // type; the is_human classification is harness-agnostic.)
  const autonomy = await prisma.client.$queryRawUnsafe<
    { day: string; median: number }[]
  >(
    `SELECT substr(e.created_at, 1, 10) AS day,
            100.0 * SUM(CASE WHEN sa.is_human = 0 THEN 1 ELSE 0 END)
              / NULLIF(COUNT(*), 0) AS median
     FROM events e
     JOIN session_analytics sa ON sa.session_id = e.session_id
     WHERE sa.started_at IS NOT NULL
       AND sa.started_at BETWEEN $1 AND $2
       AND e.created_at IS NOT NULL
     GROUP BY day`,
    range.trendStartIso,
    range.endIso
  );

  const row = totals[0];
  const inputTokens = token(row?.input_tokens, "insights.agents.input_tokens");
  const outputTokens = token(
    row?.output_tokens,
    "insights.agents.output_tokens"
  );
  const cacheReadTokens = token(
    row?.cache_read_tokens,
    "insights.agents.cache_read_tokens"
  );
  const cacheWriteTokens = token(
    row?.cache_write_tokens,
    "insights.agents.cache_write_tokens"
  );
  const cacheTokens = addStorageTokenCounts(
    cacheReadTokens,
    cacheWriteTokens,
    "insights.agents.cache_tokens"
  );
  const kpis: KpiStat[] = [
    kpi(
      "tokens",
      "Tokens",
      token(row?.tokens, "insights.agents.tokens"),
      KpiFormat.Tokens,
      "consumed in range"
    ),
    kpi(
      "input-tokens",
      "Input tokens",
      inputTokens,
      KpiFormat.Tokens,
      "prompt tokens"
    ),
    kpi(
      "output-tokens",
      "Output tokens",
      outputTokens,
      KpiFormat.Tokens,
      "completion tokens"
    ),
    kpi(
      "cache-tokens",
      "Cache saved",
      cacheTokens,
      KpiFormat.Tokens,
      "cache read/write tokens"
    ),
    kpi(
      "models",
      "Models in use",
      num(row?.models),
      KpiFormat.Number,
      "distinct models"
    ),
    kpi(
      "tool-runs",
      "Tool runs",
      num(tools[0]?.n),
      KpiFormat.Number,
      "tool invocations"
    ),
  ];

  return {
    kpis,
    charts: {
      modelUsageOverTime: buildModelSeries(overTime, range),
      autonomyTrend: gapFilledSeries(
        new Map(autonomy.map((r) => [r.day, num(r.median)])),
        range,
        { key: "autonomy", label: "Autonomy" }
      ),
      modelBreakdown: breakdown.map((r) => ({
        key: r.model,
        label: r.model,
        value: token(r.value, "insights.agents.model_tokens"),
      })),
      tokenDistribution: [
        { key: "input", label: "Input", value: inputTokens },
        { key: "output", label: "Output", value: outputTokens },
        { key: "cache-read", label: "Cache read", value: cacheReadTokens },
        { key: "cache-write", label: "Cache write", value: cacheWriteTokens },
      ],
      toolUsage: toolUsage.map((row) => ({
        key: row.tool_name,
        label: row.tool_name,
        value: num(row.n),
      })),
      // Typed agent.groupBy returns `_count._all` (a number); the SQL's
      // `ORDER BY n DESC` is reproduced by sorting the groups in JS.
      agentsByStatus: [...agentsByStatus]
        .sort((a, b) => b._count._all - a._count._all)
        .map((g) => ({
          key: g.status,
          label: labelize(g.status),
          value: num(g._count._all),
        })),
      agentsByType: [...agentsByType]
        .sort((a, b) => b._count._all - a._count._all)
        .map((g) => ({
          // a.type is nullable; mirror the SQL's COALESCE(type, 'unknown').
          key: g.type ?? "unknown",
          label: labelize(g.type ?? "unknown"),
          value: num(g._count._all),
        })),
      toolRunsOverTime: gapFilledSeries(
        new Map(toolsOverTime.map((row) => [row.day, num(row.n)])),
        range,
        { key: "tool-runs", label: "Tool runs" }
      ),
    },
  };
}

async function computeUtilization(
  prisma: DesktopPrisma,
  range: Range
): Promise<UtilizationInsightsResponse> {
  // FILTER aggregate + a correlated COUNT subquery over `events` (no session
  // relation) — no typed-delegate form, stays raw.
  const totals = await prisma.client.$queryRawUnsafe<
    {
      sessions: bigint;
      runtime_ms: number;
      events: bigint;
    }[]
  >(
    `SELECT COUNT(*) AS sessions,
            COALESCE(SUM(
              (unixepoch(s.ended_at, 'subsec') - unixepoch(s.started_at, 'subsec')) * 1000
            ) FILTER (
              WHERE s.ended_at IS NOT NULL
                AND s.ended_at > s.started_at
            ), 0) AS runtime_ms,
            (
              SELECT COUNT(*)
              FROM events e
              JOIN sessions es ON es.id = e.session_id
              WHERE es.started_at IS NOT NULL
                AND es.started_at BETWEEN $1 AND $2
            ) AS events
     FROM sessions s
     WHERE s.started_at IS NOT NULL AND s.started_at BETWEEN $1 AND $2`,
    range.startIso,
    range.endIso
  );
  const perDay = await prisma.client.$queryRawUnsafe<
    { day: string; n: bigint }[]
  >(
    `SELECT substr(started_at,1,10) AS day, COUNT(*) AS n
     FROM sessions
     WHERE started_at BETWEEN $1 AND $2
     GROUP BY day`,
    range.trendStartIso,
    range.endIso
  );
  const eventsPerDay = await prisma.client.$queryRawUnsafe<
    { day: string; n: bigint }[]
  >(
    `SELECT substr(e.created_at,1,10) AS day,
            COUNT(*) AS n
     FROM events e
     JOIN sessions s ON s.id = e.session_id
     WHERE e.created_at IS NOT NULL
       AND s.started_at IS NOT NULL
       AND s.started_at BETWEEN $1 AND $2
     GROUP BY day`,
    range.trendStartIso,
    range.endIso
  );
  const eventsByType = await prisma.client.$queryRawUnsafe<
    { event_type: string; n: bigint }[]
  >(
    `SELECT e.event_type AS event_type, COUNT(*) AS n
     FROM events e
     JOIN sessions s ON s.id = e.session_id
     WHERE s.started_at IS NOT NULL
       AND s.started_at BETWEEN $1 AND $2
     GROUP BY e.event_type
     ORDER BY n DESC
     LIMIT 12`,
    range.startIso,
    range.endIso
  );
  // Typed: sessions.status is a plain column; the date filter is a column range.
  const sessionsByStatus = await prisma.client.session.groupBy({
    by: ["status"],
    where: { startedAt: { gte: range.startIso, lte: range.endIso } },
    _count: { _all: true },
  });
  // COALESCE(observed_at, created_at) over two columns has no typed-where form.
  const backlog = await prisma.client.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*) AS n
     FROM artifacts
     WHERE kind = 'pull_request'
       AND COALESCE(observed_at, created_at) IS NOT NULL`
  );
  // Hour×day event density, split by session mode (Human vs Agent). The
  // per-session binary classification rule lives in one place —
  // {@link humanSessionClassificationSql} / {@link HUMAN_TURN_THRESHOLD}.
  const heatmap = await prisma.client.$queryRawUnsafe<
    {
      day: string;
      hour: bigint;
      human: bigint;
      agent: bigint;
    }[]
  >(
    // FEA-2038: the per-session human/agent classification is precomputed at
    // ingest in `session_analytics.is_human` (mirrors humanSessionClassificationSql
    // / HUMAN_TURN_THRESHOLD), so this no longer re-scans the events corpus to
    // count human turns — it just buckets events by hour and splits on the stored
    // flag.
    `SELECT substr(e.created_at,1,10) AS day,
            CAST(strftime('%H', e.created_at) AS INTEGER) AS hour,
            COUNT(*) FILTER (WHERE sa.is_human = 1) AS human,
            COUNT(*) FILTER (WHERE sa.is_human = 0) AS agent
     FROM events e
     JOIN session_analytics sa ON sa.session_id = e.session_id
     WHERE sa.started_at IS NOT NULL
       AND sa.started_at BETWEEN $1 AND $2
       AND e.created_at IS NOT NULL
     GROUP BY day, hour`,
    range.startIso,
    range.endIso
  );

  const row = totals[0];
  const capturedPrCount = num(backlog[0]?.n);
  const kpis: KpiStat[] = [
    kpi(
      "sessions",
      "Sessions",
      num(row?.sessions),
      KpiFormat.Number,
      "agent sessions run"
    ),
    kpi(
      "runtime",
      "Agent runtime",
      num(row?.runtime_ms),
      KpiFormat.Duration,
      "hours of agent execution"
    ),
    kpi(
      "backlog",
      "Review backlog",
      capturedPrCount,
      KpiFormat.Number,
      "captured PRs"
    ),
    kpi(
      "events",
      "Events",
      num(row?.events),
      KpiFormat.Number,
      "captured local events"
    ),
  ];

  const activity = new Map(perDay.map((r) => [r.day, num(r.n)]));
  const eventVolume = new Map(eventsPerDay.map((r) => [r.day, num(r.n)]));
  return {
    kpis,
    charts: {
      eventActivity: gapFilledSeries(activity, range, {
        key: "sessions",
        label: "Sessions",
      }),
      eventVolume: gapFilledSeries(eventVolume, range, {
        key: "events",
        label: "Events",
      }),
      activityHeatmap: {
        days: eachDay(range.startIso, range.endIso),
        cells: heatmap.map((r) => ({
          day: r.day,
          hour: num(r.hour),
          human: num(r.human),
          agent: num(r.agent),
        })),
      },
      eventsByType: eventsByType.map((row) => ({
        key: row.event_type,
        label: labelize(row.event_type),
        value: num(row.n),
      })),
      // Typed session.groupBy → `_count._all`; sort desc in JS for ORDER BY n DESC.
      sessionsByStatus: [...sessionsByStatus]
        .sort((a, b) => b._count._all - a._count._all)
        .map((g) => ({
          key: g.status,
          label: labelize(g.status),
          value: num(g._count._all),
        })),
      reviewQueue: [
        {
          key: "captured",
          label: "Captured locally",
          value: capturedPrCount,
        },
        { key: "changes", label: "Changes requested", value: 0 },
        { key: "approved", label: "Approved", value: 0 },
      ],
    },
  };
}

async function computeDelivery(
  prisma: DesktopPrisma,
  range: Range
): Promise<DeliveryInsightsResponse> {
  // Every delivery read aggregates `artifacts` on `COALESCE(observed_at,
  // created_at)` (a two-column coalesce with no typed-where form), or uses a
  // strftime day-bucket / ROW_NUMBER window / SUM — none has a clean typed
  // delegate, so they run raw on the single client.
  const [
    current,
    prior,
    trend,
    repoBuckets,
    latencyRows,
    locRows,
    costRow,
    priorCostRow,
    priorLocRows,
  ] = await Promise.all([
    prisma.client.$queryRawUnsafe<{ n: bigint; merged: bigint }[]>(
      // FEA-2038: captured PRs in window + how many are MERGED, for a real
      // merge rate (replaces a hardcoded 100). pr_state is uppercase
      // ('MERGED'), matching the branch projection's classification.
      `SELECT COUNT(*) AS n,
                SUM(CASE WHEN pr_state = 'MERGED' THEN 1 ELSE 0 END) AS merged
       FROM artifacts
       WHERE kind = 'pull_request'
         AND COALESCE(observed_at, created_at) BETWEEN $1 AND $2`,
      range.startIso,
      range.endIso
    ),
    prisma.client.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*) AS n
       FROM artifacts
       WHERE kind = 'pull_request'
         AND COALESCE(observed_at, created_at) >= $1
         AND COALESCE(observed_at, created_at) < $2`,
      range.priorStartIso,
      range.startIso
    ),
    prisma.client.$queryRawUnsafe<{ day: string; n: bigint }[]>(
      `SELECT substr(COALESCE(observed_at, created_at),1,10) AS day,
              COUNT(*) AS n
       FROM artifacts
       WHERE kind = 'pull_request'
         AND COALESCE(observed_at, created_at) BETWEEN $1 AND $2
       GROUP BY day`,
      range.trendStartIso,
      range.endIso
    ),
    prisma.client.$queryRawUnsafe<{ repo: string; n: bigint }[]>(
      `SELECT COALESCE(repo_full_name, 'Unknown') AS repo,
              COUNT(*) AS n
       FROM artifacts
       WHERE kind = 'pull_request'
         AND COALESCE(observed_at, created_at) BETWEEN $1 AND $2
       GROUP BY repo
       ORDER BY n DESC`,
      range.startIso,
      range.endIso
    ),
    prisma.client.$queryRawUnsafe<{ latency_ms: number }[]>(
      // FEA-1899: a PR artifact can link to multiple sessions (created +
      // referenced), so DISTINCT ON (a.id) collapses to ONE latency row per PR —
      // matching the old single-session-per-PR-row behavior. We prefer the
      // session that CREATED the PR (relation='created'), then the earliest, so
      // sessions that merely referenced a PR URL don't skew the percentile.
      // SQLite has no DISTINCT ON: a windowed ROW_NUMBER over the same
      // (PARTITION BY a.id ORDER BY <created-first, earliest-start>) tiebreak
      // keeps exactly one row per PR artifact (rn = 1), matching Postgres.
      `SELECT latency_ms FROM (
         SELECT latency_ms,
           ROW_NUMBER() OVER (
             PARTITION BY artifact_id
             ORDER BY created_rank, started_at ASC
           ) AS rn
         FROM (
           SELECT a.id AS artifact_id,
             (unixepoch(COALESCE(a.observed_at, a.created_at), 'subsec')
               - unixepoch(s.started_at, 'subsec')) * 1000 AS latency_ms,
             CASE WHEN sal.relation = 'created' THEN 0 ELSE 1 END AS created_rank,
             s.started_at AS started_at
           FROM artifacts a
           JOIN session_artifact_links sal ON sal.artifact_id = a.id
           JOIN sessions s ON s.id = sal.session_id
           WHERE a.kind = 'pull_request'
             AND s.started_at IS NOT NULL
             AND COALESCE(a.observed_at, a.created_at) BETWEEN $1 AND $2
             AND COALESCE(a.observed_at, a.created_at) >= s.started_at
         ) ranked
       ) one_per_pr
       WHERE rn = 1`,
      range.startIso,
      range.endIso
    ),
    prisma.client.$queryRawUnsafe<{ loc: bigint; day: string }[]>(
      // FEA-2038: per-PR LOC (lines added + removed) for captured PRs, with the
      // bucket day — powers the "KLOC captured" + "Median PR size" KPIs and the
      // KLOC-over-time trend. NULL lines_added = un-enriched PR; excluded so the
      // median/total reflect only PRs whose size we actually know.
      `SELECT COALESCE(lines_added, 0) + COALESCE(lines_removed, 0) AS loc,
              substr(COALESCE(observed_at, created_at), 1, 10) AS day
       FROM artifacts
       WHERE kind = 'pull_request'
         AND COALESCE(observed_at, created_at) BETWEEN $1 AND $2
         AND lines_added IS NOT NULL`,
      range.startIso,
      range.endIso
    ),
    // FEA-2038: total estimated AI spend over the window, from the per-session
    // analytics rollup (est_cost is summed from token_usage.cost_usd_estimated
    // at ingest). Powers the delivery "Cost" KPI.
    prisma.client.$queryRawUnsafe<{ cost: number }[]>(
      `SELECT COALESCE(SUM(est_cost), 0) AS cost
         FROM session_analytics
         WHERE started_at IS NOT NULL
           AND started_at BETWEEN $1 AND $2`,
      range.startIso,
      range.endIso
    ),
    // FEA-2038: prior-window cost + LOC, so the Cost / KLOC / PR-size KPIs show
    // a real period-over-period delta instead of "unknown".
    prisma.client.$queryRawUnsafe<{ cost: number }[]>(
      `SELECT COALESCE(SUM(est_cost), 0) AS cost
         FROM session_analytics
         WHERE started_at IS NOT NULL
           AND started_at >= $1 AND started_at < $2`,
      range.priorStartIso,
      range.startIso
    ),
    prisma.client.$queryRawUnsafe<{ loc: bigint }[]>(
      `SELECT COALESCE(lines_added, 0) + COALESCE(lines_removed, 0) AS loc
         FROM artifacts
         WHERE kind = 'pull_request'
           AND COALESCE(observed_at, created_at) >= $1
           AND COALESCE(observed_at, created_at) < $2
           AND lines_added IS NOT NULL`,
      range.priorStartIso,
      range.startIso
    ),
  ]);

  const captured = num(current[0]?.n);
  const priorCaptured = num(prior[0]?.n);
  const mergedCount = num(current[0]?.merged);
  const mergeRate =
    captured > 0 ? Math.round((mergedCount / captured) * 100) : 0;
  const latencies = latencyRows
    .map((row) => num(row.latency_ms))
    .filter((value) => value >= 0);
  const trendByDay = new Map(trend.map((row) => [row.day, num(row.n)]));
  const totalCost = num(costRow[0]?.cost);

  // FEA-2038: PR-size / KLOC metrics from captured-PR LOC.
  const locValues = locRows
    .map((row) => num(row.loc))
    .filter((value) => value >= 0);
  const totalLoc = locValues.reduce((sum, value) => sum + value, 0);
  const klocCaptured = Math.round(totalLoc / 100) / 10;
  const medianPrSize = median(locValues) ?? 0;
  // Prior-window equivalents for period-over-period deltas.
  const priorCost = num(priorCostRow[0]?.cost);
  const priorLocValues = priorLocRows
    .map((row) => num(row.loc))
    .filter((value) => value >= 0);
  const priorKloc =
    Math.round(priorLocValues.reduce((sum, value) => sum + value, 0) / 100) /
    10;
  const priorMedianPrSize = median(priorLocValues) ?? 0;
  const klocByDay = new Map<string, number>();
  for (const row of locRows) {
    klocByDay.set(row.day, (klocByDay.get(row.day) ?? 0) + num(row.loc) / 1000);
  }

  return {
    kpis: [
      kpi(
        "merged",
        "Captured PRs",
        captured,
        KpiFormat.Number,
        "PRs found in local sessions",
        pctDelta(captured, priorCaptured)
      ),
      kpi(
        "ttm",
        "Median time to PR",
        median(latencies) ?? 0,
        KpiFormat.Duration,
        "session start → PR"
      ),
      kpi(
        "kloc",
        "KLOC captured",
        klocCaptured,
        KpiFormat.Number,
        "thousands of lines changed in captured PRs",
        pctDelta(klocCaptured, priorKloc)
      ),
      kpi(
        "cost",
        "Cost",
        totalCost,
        KpiFormat.Currency,
        "estimated AI spend in window",
        pctDelta(totalCost, priorCost)
      ),
      kpi(
        "merge-rate",
        "Merge rate",
        mergeRate,
        KpiFormat.Percent,
        "of captured PRs"
      ),
      kpi(
        "pr-size",
        "Median PR size",
        medianPrSize,
        KpiFormat.Number,
        "median lines changed per captured PR",
        pctDelta(medianPrSize, priorMedianPrSize)
      ),
    ],
    charts: {
      prTrend: gapFilledSeries(trendByDay, range, {
        key: "merged",
        label: "Captured PRs",
      }),
      klocTrend: gapFilledSeries(klocByDay, range, {
        key: "kloc",
        label: "KLOC captured",
      }),
      prByRepo: repoBuckets.map((row) => ({
        key: row.repo,
        label: row.repo,
        value: num(row.n),
      })),
      meanTimeToMerge: durationHistogram(latencies),
      prByState: [
        { key: "captured", label: "Captured locally", value: captured },
      ],
      branchLifespan: durationHistogram(latencies),
      checkStatus: [
        { key: "captured", label: "Captured locally", value: captured },
      ],
      branchesWithoutPr: [
        { key: "has-pr", label: "Has a pull request", value: captured },
        { key: "no-pr", label: "No pull request", value: 0 },
      ],
    },
  };
}

function buildModelSeries(
  rows: Array<{ day: string; model: string; value: unknown }>,
  range: Range
): TimeSeries {
  const totalsByModel = new Map<string, number>();
  for (const r of rows) {
    totalsByModel.set(
      r.model,
      addStorageTokenCounts(
        totalsByModel.get(r.model) ?? 0,
        r.value,
        "insights.agents.model_series_total"
      )
    );
  }
  const topModels = [...totalsByModel.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_MODEL_SERIES)
    .map(([model]) => model);
  const topSet = new Set(topModels);
  const seriesKey = (model: string) => (topSet.has(model) ? model : "other");

  const byDay = new Map<string, Record<string, number>>();
  let usesOther = false;
  for (const r of rows) {
    const key = seriesKey(r.model);
    if (key === "other") {
      usesOther = true;
    }
    const day = byDay.get(r.day) ?? {};
    day[key] = addStorageTokenCounts(
      day[key] ?? 0,
      r.value,
      "insights.agents.model_series_day"
    );
    byDay.set(r.day, day);
  }

  const series: TimeSeriesSeries[] = topModels.map((model) => ({
    key: model,
    label: model,
  }));
  if (usesOther) {
    series.push({ key: "other", label: "Other" });
  }

  const points = eachDay(range.trendStartIso, range.endIso).map((date) => ({
    date,
    values: byDay.get(date) ?? {},
  }));
  return { series, points };
}

function gapFilledSeries(
  countsByDay: Map<string, number>,
  range: Range,
  series: TimeSeriesSeries
): TimeSeries {
  const points = eachDay(range.trendStartIso, range.endIso).map((date) => ({
    date,
    values: { [series.key]: countsByDay.get(date) ?? 0 },
  }));
  return { series: [series], points };
}

function durationHistogram(values: number[]): CategoryBucket[] {
  const buckets = [
    { key: "under-1h", label: "<1h", min: 0, max: 3_600_000, value: 0 },
    { key: "1-6h", label: "1-6h", min: 3_600_000, max: 21_600_000, value: 0 },
    {
      key: "6-24h",
      label: "6-24h",
      min: 21_600_000,
      max: 86_400_000,
      value: 0,
    },
    {
      key: "1-3d",
      label: "1-3d",
      min: 86_400_000,
      max: 259_200_000,
      value: 0,
    },
    {
      key: "over-3d",
      label: ">3d",
      min: 259_200_000,
      max: Number.POSITIVE_INFINITY,
      value: 0,
    },
  ];

  for (const value of values) {
    const bucket = buckets.find(
      (entry) => value >= entry.min && value < entry.max
    );
    if (bucket) {
      bucket.value++;
    }
  }

  return buckets.map(({ key, label, value }) => ({ key, label, value }));
}

function resolveRange(period: InsightsPeriod, now: Date): Range {
  const endIso = now.toISOString();
  const trendStartIso = new Date(
    now.getTime() - TREND_LOOKBACK_DAYS * MS_PER_DAY
  ).toISOString();
  if (period === InsightsPeriodValues.All) {
    return {
      startIso: new Date(0).toISOString(),
      endIso,
      trendStartIso,
      priorStartIso: new Date(0).toISOString(),
    };
  }
  const days = Number(period);
  const start = new Date(now.getTime() - days * MS_PER_DAY);
  return {
    startIso: start.toISOString(),
    endIso,
    trendStartIso,
    priorStartIso: new Date(start.getTime() - days * MS_PER_DAY).toISOString(),
  };
}

function eachDay(startIso: string, endIso: string): string[] {
  const keys: string[] = [];
  const start = new Date(startIso);
  const cursor = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())
  );
  const end = new Date(endIso);
  const endDay = Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth(),
    end.getUTCDate()
  );
  while (cursor.getTime() <= endDay) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return keys;
}

function kpi(
  key: string,
  label: string,
  value: number,
  format: KpiFormat,
  sub: string,
  deltaPct: number | null = null
): KpiStat {
  return { key, label, value, format, sub, deltaPct };
}

function num(value: number | bigint | string | null | undefined): number {
  // Prisma's raw read path can surface SQLite INTEGER aggregates (COUNT/SUM)
  // as `bigint`; Number() coerces every form to the JS number the contract uses.
  return value == null ? 0 : Number(value);
}

function token(value: unknown, fieldName: string): number {
  return readStorageTokenCount(value, fieldName);
}

function labelize(value: string): string {
  return value
    .split(LABEL_SEPARATOR_PATTERN)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? null);
}

function pctDelta(current: number, prior: number): number | null {
  if (prior === 0) {
    return current === 0 ? null : 100;
  }
  return Math.round(((current - prior) / prior) * 1000) / 10;
}
