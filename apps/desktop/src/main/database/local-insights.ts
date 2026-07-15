import type {
  AgentsInsightsResponse,
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
  kpi,
  lifespanHistogram,
  pctDelta,
  ttmHistogram,
} from "@closedloop-ai/loops-api/insights";
import { median } from "@repo/api/src/utils/math";
import { labelize } from "@repo/api/src/utils/string";
import { PrState } from "../enrichment/types.js";
import {
  addStorageTokenCounts,
  readStorageTokenCount,
} from "../token-counts.js";
import {
  createdArtifactLinksSubquery,
  formatLocalDayKey,
  localDay,
  localHour,
} from "./db-helpers.js";
import type { DesktopPrisma } from "./prisma-client.js";

const MS_PER_DAY = 86_400_000;
const TREND_LOOKBACK_DAYS = 90;
const MAX_MODEL_SERIES = 6;

// FEA-2486: PR throughput split. "agent" = the PR has session PR-creation
// evidence (a relation='created' artifact link); "manual" = no such evidence —
// which includes genuinely hand-raised PRs AND PRs raised outside captured
// sessions (other machines, bots, cloud loops).
const PR_TREND_SERIES: TimeSeriesSeries[] = [
  { key: "agent", label: "Agent-raised" },
  { key: "manual", label: "Manual/untracked" },
];

// --- Human/Agent TURN attribution (activity heatmap + autonomy trend) ---------
//
// PM ruling 2026-07-10 (FEA-2641 Fix 4): the heatmap and autonomy trend chart
// conversational TURNS attributed by their OWN role, not event density gated
// by the per-session `is_human` flag. Session-level splitting painted a
// steered session's entire autonomous stretch as Human — one overnight /build
// run the user typed two prompts into showed as 24/7 Human activity. Per-turn
// attribution gives each series its literal meaning: a Human cell is an hour
// the human actually typed; everything the agent did — including a human
// session's autonomous overnight stretches and spawned-subagent work — paints
// Agent at the hours it actually ran.
//
// Source: sessions.metadata $.messages (role + timestamp per parsed message),
// the same transcript-first source that feeds the is_human rollup.
// role:"human" is already evidence-exact at parse time (FEA-2641: wake-up
// re-injections, stdout echoes, teammate messages, and non-steering commands
// like /exit are excluded; all five harness parsers emit these messages).
// `session_analytics.is_human` remains the ingest-time SESSION classification
// (see upsertSessionAnalyticsRollupBatch in write-core.ts) but no longer
// feeds these two charts.
//
// Headless kickoffs are NOT human: a role:"human" turn in a session launched
// programmatically — cron-scheduled code reviews, fleet/workflow agents,
// scripted `claude -p` / `codex exec` runs — was not typed at a keyboard, so
// it counts as an Agent turn. Two harness-stamped vocabularies identify
// headless launches (census over the local corpus, 2026-07-10):
//   - Claude entrypoint: "sdk-cli" (headless SDK path; 990 sessions) vs
//     "cli" (interactive; 141) — nothing else in the wild.
//   - Codex session_meta.originator (stored as the entrypoint since
//     DATA_REVISION 13): "codex_exec" / "claude-codex-exec" (scripted; 1,092
//     rollouts) vs "codex-tui" / "codex_cli_rs" / "codex_vscode"
//     (interactive; 455) — no interactive value contains "exec".
// Hence LIKE 'sdk%' OR LIKE '%exec%'. The check is positive-evidence only:
// an absent entrypoint, "cli", tui/vscode values, or a legacy harness
// fallback (e.g. plain "codex") stays interactive, so genuine typed prompts
// are never demoted by missing data.
//
// JSON guards mirror the rollup SQL (write-core.ts): the json_each argument
// is NULLed via nested CASE unless metadata is valid JSON whose $.messages is
// an array (json_each over NULL yields no rows), and json_extract is gated
// behind `m.type = 'object'` — CASE, not AND, because CASE evaluation order
// is a language guarantee while AND terms may be reordered — so malformed
// metadata or a primitive array element can never raise "malformed JSON" and
// abort the query. A turn timestamp outside the rendered day axis simply
// doesn't match a column. FEA-3059: this turn source is scanned per bounded
// session-id batch (turnsByRoleForIds + forEachTurnsChunk below), not over the
// whole window at once, so json_each never materializes the full corpus.

// FEA-3132: the per-turn source that fed the heatmap + autonomy trend is no
// longer computed on the read path. Turns are materialized into
// `session_turn_bucket` at ingest (`rebuildSessionTurnBuckets`, write-core.ts):
// one row per (session, message `$.timestamp`, resolved `turn_kind`), where
// turn_kind pre-resolves the old role+headless predicate. Both reads now GROUP
// BY that indexed table, so a dashboard load never json_each-expands `$.messages`
// again. The former json_each helpers (turnsByRoleForIds / forEachTurnsChunk /
// windowSessionIds / HUMAN_TURN_PREDICATE / AGENT_TURN_PREDICATE / TURNS_SCAN_CHUNK)
// are gone.

type LocalInsightsResponse =
  | DeliveryInsightsResponse
  | UtilizationInsightsResponse
  | AgentsInsightsResponse;

/**
 * Local-database Insights backend for the desktop shell. Computes the same
 * shaped section responses the cloud `apps/api` returns, but against the
 * in-process SQLite database (the user's own data). Desktop is always personal
 * scope and returns the same response shape as the web Insights backend.
 *
 * Timezone contract (FEA-2430): timestamps are STORED as UTC ISO strings; every
 * day/hour bucket this module emits for display converts to the user's LOCAL
 * timezone via localDay()/localHour() in SQL and formatLocalDayKey()/eachDay()
 * in JS — the two sides must stay in lockstep (matching keys) or charts silently
 * drop data. Window BOUNDARIES stay rolling UTC instants (resolveRange); only
 * bucket labels are local. This restores the pre-SQLite-migration behavior
 * (Postgres bucketed AT TIME ZONE; FEA-1459's port made buckets UTC). The
 * desktop main process runs on the user's machine, so 'localtime' == the
 * user's OS timezone, DST handled per-date by the OS tz database.
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
    `SELECT ${localDay("s.started_at")} AS day,
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
  // FEA-2331: the model charts measure estimated SPEND (USD), not token volume.
  // Token-share-by-model is misleading for cache-heavy harnesses — Claude Code's
  // prompt-cache reuse pushes ~all real token volume into cache_read_tokens
  // (excluded from input+output), so a low-cache tool can outrank it on tokens
  // while costing far less. Cost is cache-neutral, so it reflects where the money
  // actually goes. `cost_usd_estimated` is a REAL column → driver yields a float,
  // so these stay plain numbers (NOT the safe-integer token helpers). NULL costs
  // COALESCE to 0 (treated as $0) rather than dropping the row.
  const breakdown = await prisma.client.$queryRawUnsafe<
    { model: string; value: number }[]
  >(
    `SELECT t.model AS model, COALESCE(SUM(t.cost_usd_estimated), 0) AS value
     FROM token_usage t
     JOIN sessions s ON s.id = t.session_id
     WHERE s.started_at BETWEEN $1 AND $2 AND t.model IS NOT NULL
     GROUP BY t.model
     ORDER BY COALESCE(SUM(t.cost_usd_estimated), 0) DESC`,
    range.startIso,
    range.endIso
  );
  const overTime = await prisma.client.$queryRawUnsafe<
    {
      day: string;
      model: string;
      value: number;
    }[]
  >(
    `SELECT ${localDay("s.started_at")} AS day,
            t.model AS model,
            COALESCE(SUM(t.cost_usd_estimated), 0) AS value
     FROM token_usage t
     JOIN sessions s ON s.id = t.session_id
     WHERE s.started_at BETWEEN $1 AND $2 AND t.model IS NOT NULL
     GROUP BY day, t.model`,
    range.trendStartIso,
    range.endIso
  );
  // Daily autonomy index (0 manual → 100 agentic): the share of the day's
  // parsed conversational turns that were the agent's (role:"assistant") vs
  // the human's (role:"human"), from the SAME turn source as the activity
  // heatmap (TURNS_BY_ROLE_SOURCE) so the trend line and the heatmap split
  // always agree. Turn-based per the FEA-2641 Fix 4 PM ruling — a
  // human-steered session's autonomous stretches score agentic on the days
  // they ran instead of inheriting the session's Human flag. Harness-agnostic
  // because every parser emits role-tagged messages (unlike the abandoned
  // events-corpus turn ratio, which went flat for harnesses whose events
  // carry no "assistant" type).
  // FEA-3059: bounded-scan autonomy. Sum per-day agent/total turn counts across
  // session-id batches, then compute the ratio once — identical to the old
  // single-pass `100.0 * agentFilter / NULLIF(total,0)` but the json_each scan
  // never exceeds TURNS_SCAN_CHUNK sessions.
  // FEA-3132: read the pre-materialized `session_turn_bucket` (built at ingest by
  // rebuildSessionTurnBuckets) instead of json_each-expanding `$.messages` every
  // load. `turn_kind` already encodes the role+headless predicate; SUM(turn_count)
  // reproduces the old COUNT(*). Window on the SESSION's started_at (matching the
  // old windowSessionIds), bucket the raw UTC ts to local at read time.
  const autonomyRows = await prisma.client.$queryRawUnsafe<
    { day: string; agent: bigint; total: bigint }[]
  >(
    `SELECT ${localDay("b.ts")} AS day,
            SUM(CASE WHEN b.turn_kind = 'agent' THEN b.turn_count ELSE 0 END) AS agent,
            SUM(b.turn_count) AS total
     FROM session_turn_bucket b
     JOIN sessions s ON s.id = b.session_id
     WHERE s.started_at IS NOT NULL AND s.started_at BETWEEN $1 AND $2
     GROUP BY day
     HAVING day IS NOT NULL`,
    range.trendStartIso,
    range.endIso
  );
  const autonomy = autonomyRows.map((r) => {
    const total = num(r.total);
    return {
      day: r.day,
      median: total > 0 ? (100.0 * num(r.agent)) / total : 0,
    };
  });

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
        // USD spend (float), rounded to cents — NOT a token count.
        value: roundUsd(num(r.value)),
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
    `SELECT ${localDay("started_at")} AS day, COUNT(*) AS n
     FROM sessions
     WHERE started_at BETWEEN $1 AND $2
     GROUP BY day`,
    range.trendStartIso,
    range.endIso
  );
  // FEA-3091: scope the events-per-day series by the EVENT time
  // (e.created_at), not by the parent session's started_at. The bucket key is
  // localDay(e.created_at), and web's fetchEventVolume filters
  // `e.event_created_at BETWEEN trendStart AND end`, so filtering on the
  // session's start window here counted a different population: a session that
  // began before trendStart but kept emitting events inside the window was
  // counted on web yet fully excluded on desktop, depressing the left edge and
  // diverging the totals. The JOIN to sessions is retained (parity with the
  // sibling event queries — only events tied to a captured session count), but
  // the window predicate now matches the bucket field and the web series.
  const eventsPerDay = await prisma.client.$queryRawUnsafe<
    { day: string; n: bigint }[]
  >(
    `SELECT ${localDay("e.created_at")} AS day,
            COUNT(*) AS n
     FROM events e
     JOIN sessions s ON s.id = e.session_id
     WHERE e.created_at IS NOT NULL
       AND e.created_at BETWEEN $1 AND $2
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
  // FEA-2951: the "Review backlog" KPI (kpi:backlog) approximates the shared
  // tile's documented population — "Open PRs awaiting review". This is a
  // desktop-local APPROXIMATION of, not an exact match for, the web/cloud
  // `countReviewBacklog`, which counts PRs whose `reviewDecision IS NULL`
  // regardless of pr_state. Desktop has no per-PR review-decision signal (the
  // `artifacts` table only carries `pr_state`), so the two populations
  // legitimately diverge in two known ways: a merged/closed PR that never got a
  // decision counts toward web's backlog but not this one, and an open PR that
  // already has a decision counts here but not on web. The all-captured
  // `backlog` count above (which still feeds the reviewQueue "Captured locally"
  // bar) includes already-merged/closed PRs, so on a busy repo it reads in the
  // hundreds while web reads a handful — hence the narrower open-PR filter here.
  //
  // Count only PRs we positively know are open (LOWER(pr_state) = PrState.Open,
  // same casing guard as the merge-rate KPI, FEA-2486) plus un-enriched rows
  // (pr_state IS NULL) as the intended fallback. We deliberately avoid
  // `NOT IN ('merged','closed')`: that would fabricate "open" for any
  // future/unknown lifecycle value (e.g. a `draft` state written by a newer
  // enricher), inflating the KPI. Unknown non-null states stay OUT of the
  // backlog — left indeterminate, consistent with the rest of the desktop
  // lifecycle code — rather than being counted as open.
  const reviewBacklog = await prisma.client.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*) AS n
     FROM artifacts
     WHERE kind = 'pull_request'
       AND COALESCE(observed_at, created_at) IS NOT NULL
       AND (LOWER(pr_state) = '${PrState.Open}' OR pr_state IS NULL)`
  );
  // Hour×day TURN density, split into Human vs Agent per turn via
  // TURNS_BY_ROLE_SOURCE (PM ruling 2026-07-10, FEA-2641 Fix 4): each parsed
  // message buckets at its own local hour under its own role, so Human cells
  // appear only at hours with genuine typed prompts and a steered session's
  // autonomous stretches paint Agent. The events corpus no longer feeds this
  // chart.
  // FEA-3059: bounded-scan activity heatmap. Sum per-(day, hour) human/agent
  // turn counts across session-id batches — identical rows to the old
  // single-pass query, but json_each never exceeds TURNS_SCAN_CHUNK sessions.
  // FEA-2210: the heatmap follows the capped trend window (min(period, 90d)),
  // NOT the full selected window (for "all", range.startIso is the epoch, which
  // would render ~20k day-columns and break the grid).
  // FEA-3132: read the pre-materialized `session_turn_bucket` (see the autonomy
  // trend above) instead of json_each-expanding `$.messages` every load.
  const heatmapRows = await prisma.client.$queryRawUnsafe<
    { day: string; hour: bigint; human: bigint; agent: bigint }[]
  >(
    `SELECT ${localDay("b.ts")} AS day,
            ${localHour("b.ts")} AS hour,
            SUM(CASE WHEN b.turn_kind = 'human' THEN b.turn_count ELSE 0 END) AS human,
            SUM(CASE WHEN b.turn_kind = 'agent' THEN b.turn_count ELSE 0 END) AS agent
     FROM session_turn_bucket b
     JOIN sessions s ON s.id = b.session_id
     WHERE s.started_at IS NOT NULL AND s.started_at BETWEEN $1 AND $2
     GROUP BY day, hour
     HAVING day IS NOT NULL`,
    range.trendStartIso,
    range.endIso
  );
  // Match SQLite's `GROUP BY day, hour` output order (sorted by the group key)
  // so the emitted `cells` array is byte-identical to the prior query — the
  // golden depends on it.
  const heatmap = heatmapRows
    .map((r) => ({
      day: r.day,
      hour: num(r.hour),
      human: num(r.human),
      agent: num(r.agent),
    }))
    .sort((a, b) => {
      if (a.day !== b.day) {
        return a.day < b.day ? -1 : 1;
      }
      return a.hour - b.hour;
    });

  const row = totals[0];
  const capturedPrCount = num(backlog[0]?.n);
  const reviewBacklogCount = num(reviewBacklog[0]?.n);
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
      reviewBacklogCount,
      KpiFormat.Number,
      "open PRs awaiting review"
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
        // Capped trend window (see the heatmap query above) so the column axis
        // never exceeds 90 days — matches the "Last 90 days (max)" caption.
        days: eachDay(range.trendStartIso, range.endIso),
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
    earliestRow,
  ] = await Promise.all([
    prisma.client.$queryRawUnsafe<
      { n: bigint; merged: bigint; decided: bigint; merged_authored: bigint }[]
    >(
      // FEA-2038: captured PRs in window + how many are merged, for a real
      // merge rate (replaces a hardcoded 100). FEA-2486: pr_state is written
      // lowercase (PrState, enrichment/types.ts); the previous uppercase
      // 'MERGED' comparison matched zero rows on real stores. LOWER() guards
      // against any legacy row with different casing.
      //
      // FEA-2942: merge rate is taken over DECIDED PRs (merged + closed), not
      // all captured PRs. A still-open PR has not reached a terminal state, so
      // counting it in the denominator conflates "not merged yet" with "won't
      // merge" and understates the rate (a window full of in-flight PRs read as
      // failures). `pr_state` for open PRs is refreshed toward its terminal
      // value by the enrichment sweep (enrichment-runner.ts re-polls non-final
      // PR artifacts via the local `gh` CLI), so `decided` grows as PRs land.
      // `n` (total captured), `merged`, and `decided` all count every captured
      // PR in the window (no created-link gate) — they back the "Captured PRs"
      // KPI, the capture-count charts, and the merge-rate KPI, which
      // intentionally rate the whole captured population.
      //
      // FEA-2995: `merged_authored` is the AUTHORED-only merged count that
      // backs the shared AI-Impact card's "Cost per merged PR" denominator
      // (`mergedCount` KPI below). Unlike `merged`, it inner-gates on the
      // relation='created' links — the SAME created-vs-referenced gate the
      // prByRepo breakdown (FEA-2862) and the trend `agent_n` use — so
      // reference-only PRs (competitor repos scanned via `gh api`, CI `uses:`
      // refs, test fixtures; relation='referenced'/'workspace') are excluded.
      // This matches cloud's denominator (countMergedPrsInRange counts only
      // authored pullRequestDetail rows), keeping cost-per-merged-PR
      // reconciled across surfaces. The created-links subquery is DISTINCT per
      // artifact, so this LEFT JOIN cannot fan out and leaves `n`/`merged`/
      // `decided` unchanged.
      `SELECT COUNT(*) AS n,
                SUM(CASE WHEN LOWER(pr_state) = '${PrState.Merged}' THEN 1 ELSE 0 END) AS merged,
                SUM(CASE WHEN LOWER(pr_state) IN ('${PrState.Merged}', '${PrState.Closed}') THEN 1 ELSE 0 END) AS decided,
                SUM(CASE WHEN LOWER(pr_state) = '${PrState.Merged}' AND cl.artifact_id IS NOT NULL THEN 1 ELSE 0 END) AS merged_authored
       FROM artifacts
       LEFT JOIN ${createdArtifactLinksSubquery()} cl
         ON cl.artifact_id = artifacts.id
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
    prisma.client.$queryRawUnsafe<
      { day: string; n: bigint; agent_n: bigint }[]
    >(
      // FEA-2486: agent_n counts PRs with session PR-creation evidence
      // (relation 'created' from a pr-create tool output). DISTINCT collapses
      // multi-session created links so one PR can never fan out to >1.
      `SELECT ${localDay("COALESCE(observed_at, created_at)")} AS day,
              COUNT(*) AS n,
              SUM(CASE WHEN cl.artifact_id IS NOT NULL THEN 1 ELSE 0 END) AS agent_n
       FROM artifacts
       LEFT JOIN ${createdArtifactLinksSubquery()} cl
         ON cl.artifact_id = artifacts.id
       WHERE kind = 'pull_request'
         AND COALESCE(observed_at, created_at) BETWEEN $1 AND $2
       GROUP BY day`,
      range.trendStartIso,
      range.endIso
    ),
    prisma.client.$queryRawUnsafe<{ repo: string; n: bigint }[]>(
      // FEA-2862: "Merged PRs by repository" must count only PRs the user
      // actually merged in-session — not reference-only artifacts (competitor
      // repos scanned read-only via `gh api`, CI `uses:` refs, unit-test
      // fixture repos), which land in `artifacts` as relation='referenced'/
      // 'workspace' and skew this breakdown with repos the user never opened a
      // PR against. Gate on BOTH signals the sibling queries already use:
      // (a) authored in-session — inner-join the DISTINCT relation='created'
      // links (same created-vs-referenced distinction as the trend query above
      // and the latency created_rank below), and (b) genuinely merged —
      // LOWER(pr_state)='merged' (same casing guard as the merge-rate KPI), so
      // the chart data matches its title.
      `SELECT COALESCE(a.repo_full_name, 'Unknown') AS repo,
              COUNT(*) AS n
       FROM artifacts a
       JOIN ${createdArtifactLinksSubquery()} cl
         ON cl.artifact_id = a.id
       WHERE a.kind = 'pull_request'
         AND LOWER(a.pr_state) = '${PrState.Merged}'
         AND COALESCE(a.observed_at, a.created_at) BETWEEN $1 AND $2
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
    prisma.client.$queryRawUnsafe<
      { loc: bigint; enriched: bigint; day: string }[]
    >(
      // FEA-2038: per-PR LOC (lines added + removed) for captured PRs, with the
      // bucket day — powers the "KLOC captured" + "Median PR size" KPIs and the
      // KLOC-over-time trend. FEA-2159: an un-enriched PR (NULL lines_added AND
      // lines_removed — size not yet fetched) folds into KLOC as 0 via COALESCE,
      // which leaves the KLOC total/trend unchanged (0 adds nothing).
      // FEA-2868: `enriched` flags PRs whose size IS known so the median can be
      // taken over enriched PRs ONLY — folding un-enriched PRs in as 0 was
      // dragging the Delivery median toward 0. A row is LOC-enriched only when
      // BOTH line counts are present, matching `isLocEnrichedRow`
      // (branch-analytics-projection.ts) — hence AND, not OR. A genuinely empty
      // enriched PR still has enriched=1 and counts as a real 0.
      //
      // NOTE: this INTENTIONALLY diverges from the Branches-list median in
      // `projectBranchAnalytics` (branch-analytics-projection.ts), which medians
      // over ALL merged single-PR branches and folds a missing line total in as 0
      // (FEA-2159, guarded by test/e2e/branches-median-pr-size.spec.ts) rather
      // than excluding un-enriched rows. The two medians therefore do NOT match:
      // this PR fixes the Delivery dashboard's un-enriched 0-padding without
      // touching the Branches page's deliberate include-as-0 behavior.
      `SELECT COALESCE(lines_added, 0) + COALESCE(lines_removed, 0) AS loc,
              CASE WHEN lines_added IS NOT NULL AND lines_removed IS NOT NULL
                   THEN 1 ELSE 0 END AS enriched,
              ${localDay("COALESCE(observed_at, created_at)")} AS day
       FROM artifacts
       WHERE kind = 'pull_request'
         AND COALESCE(observed_at, created_at) BETWEEN $1 AND $2`,
      range.startIso,
      range.endIso
    ),
    // FEA-2346: total estimated AI spend over the window, from token_usage ⋈
    // sessions — the same source the Agents model-spend charts use, so the two
    // KPIs cannot drift (previously read session_analytics.est_cost, which was
    // stale when the rollup lagged or missing when session_analytics rows were
    // absent).
    prisma.client.$queryRawUnsafe<{ cost: number }[]>(
      `SELECT COALESCE(SUM(t.cost_usd_estimated), 0) AS cost
         FROM token_usage t
         JOIN sessions s ON s.id = t.session_id
         WHERE s.started_at IS NOT NULL
           AND s.started_at BETWEEN $1 AND $2`,
      range.startIso,
      range.endIso
    ),
    // FEA-2346: prior-window cost, so the Cost / KLOC / PR-size KPIs show a
    // real period-over-period delta instead of "unknown".
    prisma.client.$queryRawUnsafe<{ cost: number }[]>(
      `SELECT COALESCE(SUM(t.cost_usd_estimated), 0) AS cost
         FROM token_usage t
         JOIN sessions s ON s.id = t.session_id
         WHERE s.started_at IS NOT NULL
           AND s.started_at >= $1 AND s.started_at < $2`,
      range.priorStartIso,
      range.startIso
    ),
    prisma.client.$queryRawUnsafe<{ loc: bigint; enriched: bigint }[]>(
      // FEA-2159: prior-window per-PR LOC for the PR-size / KLOC period deltas.
      // FEA-2868: carries the same `enriched` flag as the current window (BOTH
      // line counts present — AND, matching isLocEnrichedRow) so the prior median
      // is likewise taken over enriched PRs only — the median delta then compares
      // like with like (both windows exclude unknown-size PRs).
      `SELECT COALESCE(lines_added, 0) + COALESCE(lines_removed, 0) AS loc,
              CASE WHEN lines_added IS NOT NULL AND lines_removed IS NOT NULL
                   THEN 1 ELSE 0 END AS enriched
         FROM artifacts
         WHERE kind = 'pull_request'
           AND COALESCE(observed_at, created_at) >= $1
           AND COALESCE(observed_at, created_at) < $2`,
      range.priorStartIso,
      range.startIso
    ),
    // FEA-2210: earliest relevant record across the tables that feed the delta
    // KPIs (captured PRs + per-session cost). Powers the uniform "full prior
    // period" rule — a period-over-period delta is only shown when local
    // history reaches back to (or before) the prior window's start; otherwise
    // it is hidden rather than reported as a misleading +100% off an empty
    // prior window.
    prisma.client.$queryRawUnsafe<{ earliest: string | null }[]>(
      `SELECT MIN(ts) AS earliest FROM (
         SELECT MIN(COALESCE(observed_at, created_at)) AS ts
           FROM artifacts WHERE kind = 'pull_request'
         UNION ALL
         SELECT MIN(started_at) AS ts
           FROM session_analytics WHERE started_at IS NOT NULL
       )`
    ),
  ]);

  const captured = num(current[0]?.n);
  const priorCaptured = num(prior[0]?.n);
  // Raw captured merged count (every relation, no created-link gate). Feeds the
  // merge-rate denominator pairing below ONLY — NOT the "mergedCount" KPI, which
  // now emits `authoredMergedCount` (see FEA-2995 note). Named `rawMergedCount`
  // so it isn't mistaken for the KPI of the same key.
  const rawMergedCount = num(current[0]?.merged);
  // FEA-2995: authored-only merged count for the AI-Impact card's
  // "Cost per merged PR" denominator (`mergedCount` KPI). Gated on the
  // created-artifact links so reference-only merged PRs don't inflate the
  // denominator and diverge from cloud. The merge-rate below intentionally
  // stays over the whole captured population (`rawMergedCount`/`decidedCount`).
  const authoredMergedCount = num(current[0]?.merged_authored);
  // FEA-2942: denominator = DECIDED PRs (merged + closed), excluding still-open
  // ones. 0 decided PRs → 0 (no terminal outcome to rate yet), matching the
  // prior empty-window behavior.
  const decidedCount = num(current[0]?.decided);
  const mergeRate =
    decidedCount > 0 ? Math.round((rawMergedCount / decidedCount) * 100) : 0;
  const latencies = latencyRows
    .map((row) => num(row.latency_ms))
    .filter((value) => value >= 0);
  const trendByDay = new Map(
    trend.map((row) => [
      row.day,
      { total: num(row.n), agent: num(row.agent_n) },
    ])
  );
  const totalCost = num(costRow[0]?.cost);

  // FEA-2038: PR-size / KLOC metrics from captured-PR LOC. KLOC sums over ALL
  // captured PRs (un-enriched fold in as 0). FEA-2868: the median is taken over
  // ENRICHED PRs only (size known) — un-enriched PRs have unknown size and their
  // 0-padding was dragging the median to 0.
  const locValues = locRows
    .map((row) => num(row.loc))
    .filter((value) => value >= 0);
  const totalLoc = locValues.reduce((sum, value) => sum + value, 0);
  const klocCaptured = Math.round(totalLoc / 100) / 10;
  const enrichedLocValues = locRows
    .filter((row) => num(row.enriched) === 1)
    .map((row) => num(row.loc))
    .filter((value) => value >= 0);
  // FEA-2923: when NO captured PR in the window is LOC-enriched (all sizes
  // unknown), there is nothing to take a median over — emit `null` so the KPI
  // renders `—` (formatKpiValue) instead of a misleading 0. `null` (not a
  // non-finite number) keeps the value JSON-serializable on the cloud path and
  // matches the `KpiStat.value: number | null` contract. The Branches list
  // stays all-time + include-as-0 by design; this only stops the delivery
  // dashboard from reporting a fabricated 0 for an empty window.
  const medianPrSize: number | null =
    enrichedLocValues.length > 0 ? (median(enrichedLocValues) ?? 0) : null;
  // Prior-window equivalents for period-over-period deltas.
  const priorCost = num(priorCostRow[0]?.cost);
  const priorLocValues = priorLocRows
    .map((row) => num(row.loc))
    .filter((value) => value >= 0);
  const priorKloc =
    Math.round(priorLocValues.reduce((sum, value) => sum + value, 0) / 100) /
    10;
  // FEA-2868 (thread 1): keep the prior median NULLABLE. When the prior window
  // has no enriched PRs (only un-enriched or none), median() returns null and we
  // must NOT coerce it to 0 — a 0 baseline would surface a bogus +100% PR-size
  // delta for any current enriched PR size even though there is no real prior
  // baseline to compare against. A null prior median suppresses the delta below
  // (treated as no-prior-baseline), same as hasFullPriorPeriod being false.
  const priorMedianPrSize = median(
    priorLocRows
      .filter((row) => num(row.enriched) === 1)
      .map((row) => num(row.loc))
      .filter((value) => value >= 0)
  );
  // FEA-2210: uniform calendar rule — only surface a period-over-period delta
  // when the local DB holds a FULL prior period to compare against (earliest
  // relevant record on or before the prior window's start). For the "all" range
  // priorStartIso is the epoch, so this is naturally false (no comparison), and
  // a brand-new install with no history is likewise not comparable. When not
  // comparable the delta is null, which the dashboard renders as a hidden chip
  // rather than a misleading +100%.
  const earliestRecordIso = earliestRow[0]?.earliest ?? null;
  const hasFullPriorPeriod =
    earliestRecordIso !== null && earliestRecordIso <= range.priorStartIso;
  const reportDelta = (current: number, prior: number): number | null =>
    hasFullPriorPeriod ? pctDelta(current, prior) : null;
  // FEA-2868 (thread 1): the PR-size delta additionally requires a non-empty
  // prior ENRICHED population. When the prior window medians to null (no
  // enriched PRs), there is no real baseline — suppress the delta even if
  // hasFullPriorPeriod is true, rather than reporting a spurious +100% off a
  // fabricated 0 prior median.
  const reportPrSizeDelta = (current: number | null): number | null =>
    current === null || priorMedianPrSize === null
      ? null
      : reportDelta(current, priorMedianPrSize);
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
        reportDelta(captured, priorCaptured)
      ),
      // FEA-2946: surface-agnostic MERGED-PR count the shared AI-Impact card reads
      // as its "Cost per merged PR" denominator. Desktop's visible `merged` tile
      // above deliberately carries CAPTURED PRs (all states), so the card cannot
      // divide by it and stay consistent with cloud, whose `merged` KPI IS the
      // merged count. Both surfaces now expose this dedicated key with identical
      // (merged) semantics. Flagged `internal` (mirrors the delivery-kpis
      // registry's MergedCount entry): response-only, backs no tile, so it
      // renders nothing on its own.
      //
      // FEA-2995: use the AUTHORED-only merged count (`authoredMergedCount`,
      // gated on created-artifact links) rather than the raw captured `merged`,
      // so this denominator counts only genuinely-authored merged PRs — the
      // same population cloud's countMergedPrsInRange counts. Counting every
      // merged `pull_request` artifact (including reference-only PRs) inflated
      // the denominator and understated cost-per-merged-PR versus cloud.
      kpi(
        "mergedCount",
        "Merged PRs",
        authoredMergedCount,
        KpiFormat.Number,
        "PRs merged in range",
        null,
        true
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
        reportDelta(klocCaptured, priorKloc)
      ),
      kpi(
        "cost",
        "Cost",
        totalCost,
        KpiFormat.Currency,
        "estimated AI spend in window",
        reportDelta(totalCost, priorCost)
      ),
      kpi(
        "merge-rate",
        "Merge rate",
        mergeRate,
        KpiFormat.Percent,
        "of decided PRs (merged or closed)"
      ),
      kpi(
        "pr-size",
        "Median PR size",
        medianPrSize,
        KpiFormat.Number,
        "median lines changed per captured PR",
        reportPrSizeDelta(medianPrSize)
      ),
    ],
    charts: {
      prTrend: prSplitSeries(trendByDay, range),
      klocTrend: gapFilledSeries(klocByDay, range, {
        key: "kloc",
        label: "KLOC captured",
      }),
      prByRepo: repoBuckets.map((row) => ({
        key: row.repo,
        label: row.repo,
        value: num(row.n),
      })),
      meanTimeToMerge: ttmHistogram(latencies),
      prByState: [
        { key: "captured", label: "Captured locally", value: captured },
      ],
      branchLifespan: lifespanHistogram(latencies),
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
  rows: Array<{ day: string; model: string; value: number }>,
  range: Range
): TimeSeries {
  // FEA-2331: values are USD spend (float), so accumulate with plain numeric
  // addition — the storage-token helpers reject fractional values by design.
  const totalsByModel = new Map<string, number>();
  for (const r of rows) {
    totalsByModel.set(
      r.model,
      (totalsByModel.get(r.model) ?? 0) + num(r.value)
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
    day[key] = (day[key] ?? 0) + num(r.value);
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
    values: roundUsdValues(byDay.get(date) ?? {}),
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

// FEA-2486: two declared series (agent/manual) plus an UNDECLARED "merged"
// total key. The kpi:merged sparkline reads values.merged directly, while the
// bar/heatmap renderers sum only DECLARED series — the total key must stay out
// of `series` or those variants would double-count.
function prSplitSeries(
  countsByDay: Map<string, { total: number; agent: number }>,
  range: Range
): TimeSeries {
  const points = eachDay(range.trendStartIso, range.endIso).map((date) => {
    const counts = countsByDay.get(date);
    const total = counts?.total ?? 0;
    const agent = counts?.agent ?? 0;
    return {
      date,
      values: { agent, manual: total - agent, merged: total },
    };
  });
  return { series: PR_TREND_SERIES, points };
}

function resolveRange(period: InsightsPeriod, now: Date): Range {
  const endIso = now.toISOString();
  // FEA-2210: the trend sparklines + activity heatmap follow the selected
  // period but are capped at TREND_LOOKBACK_DAYS (90) so long ranges — and
  // "all" — stay readable (the all-time corpus paints an unreadable ~200-column
  // heatmap). KPI totals below still use the full, uncapped selected window.
  const trendDays =
    period === InsightsPeriodValues.All
      ? TREND_LOOKBACK_DAYS
      : Math.min(Number(period), TREND_LOOKBACK_DAYS);
  const trendStartIso = new Date(
    now.getTime() - trendDays * MS_PER_DAY
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
  // FEA-2430: local calendar days (was UTC). Floor both ends to LOCAL midnight
  // and advance with local setDate so DST-transition days (23h/25h) still
  // yield exactly one label each.
  const cursor = new Date(startIso);
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(endIso);
  end.setHours(0, 0, 0, 0);
  while (cursor.getTime() <= end.getTime()) {
    // FEA-2430: LOCAL yyyy-MM-dd key matching the localDay() SQL buckets — the
    // two must stay in lockstep (see timezone contract above).
    keys.push(formatLocalDayKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
}

function num(value: number | bigint | string | null | undefined): number {
  // Prisma's raw read path can surface SQLite INTEGER aggregates (COUNT/SUM)
  // as `bigint`; Number() coerces every form to the JS number the contract uses.
  return value == null ? 0 : Number(value);
}

// FEA-2331: round a USD spend value to whole cents so the float-summed model
// spend doesn't leak binary-floating-point noise (e.g. 5016.609999998) across
// the IPC/contract boundary. Cents precision is plenty for a share chart.
function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundUsdValues(
  values: Record<string, number>
): Record<string, number> {
  const rounded: Record<string, number> = {};
  for (const [key, value] of Object.entries(values)) {
    rounded[key] = roundUsd(value);
  }
  return rounded;
}

function token(value: unknown, fieldName: string): number {
  return readStorageTokenCount(value, fieldName);
}
