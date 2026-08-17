import {
  AGENT_FAILED_STATUS_TERMS,
  AGENT_SUCCESS_STATUS_TERMS,
} from "@repo/api/src/agent-session-status";
import { labelize } from "@repo/api/src/utils/string";
import type {
  AgentPipelineEdge,
  AgentPipelineNode,
  AgentsInsightsResponse,
  DeliveryInsightsResponse,
  InsightsPeriod,
  KpiStat,
  UtilizationInsightsResponse,
} from "@closedloop-ai/loops-api/insights";
import { InsightsSection, KpiFormat, kpi } from "@closedloop-ai/loops-api/insights";
import { addStorageTokenCounts } from "../cost/token-counts.js";
import { PrState } from "../enrichment/types.js";
import {
  localDay,
  localHour,
  numberOrZero as num,
  tokenCountValue,
  toolInvocationPredicate,
} from "./db-helpers.js";
import { computeDelivery } from "./local-insights-delivery.js";
import { eachDay, type Range, resolveRange } from "./local-insights-range.js";
import { buildModelSeries, gapFilledSeries } from "./local-insights-series.js";
import { computeLocalSpendByOutcome } from "./local-insights-spend.js";
import { buildUtilizationTileAvailability } from "./local-insights-tiles.js";
import { currentWindowSpendScopeSql } from "./local-insights-window-sql.js";
import {
  excludeNonDeliveryOnlyArtifacts,
  resolveNonDeliveryOnlyArtifactIds,
} from "./non-delivery-artifacts.js";
import type { DesktopPrisma } from "./prisma-client.js";
import { allocateRoundedUsdValues } from "./usd-allocation.js";

/*
 * ISS-5938: every RAW aggregate in this module is dispatched through
 * `prisma.read` — the round-robin pool of `query_only` reader connections —
 * rather than the writer-bound `prisma.client`, so a dashboard load no longer
 * serializes against the write queue that owns sync durability (and no longer
 * delays the first-launch backfill or a live import). Each read is dispatched
 * SEPARATELY so the pool can genuinely fan the `Promise.all` groups out across
 * connections; see `local-insights-delivery.ts` for why they are deliberately
 * not gathered into one reader `$transaction`.
 *
 * The TYPED delegate reads (`agent.groupBy`, `session.groupBy`) deliberately
 * STAY on `prisma.client` — FEA-2211 (see session-count.ts): the libSQL
 * community adapter zeroes a model-delegate aggregate on the `query_only`
 * reader connections in PACKAGED builds while behaving correctly in the clean
 * test env, so moving one to the pool would pass every test and empty the chart
 * in production. Same split, and same reason, as the sibling
 * `dashboard-queries.ts` module note. Converting them to raw `GROUP BY` on the
 * pool is the eventual fix FEA-2211 itself points at; until then this is
 * residual, not a settled boundary.
 */

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
// re-injections, stdout echoes, and teammate messages are excluded; FEA-3124
// ruling 2026-07-16: typed slash commands including /exit//quit DO count —
// the mechanical human record; all five harness parsers emit these messages).
// `session_analytics.is_human` remains the ingest-time SESSION classification
// (see upsertSessionAnalyticsRollupBatch in session-analytics-rollup.ts) but no longer
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
// JSON guards mirror the rollup SQL (session-analytics-rollup.ts): the json_each argument
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
// `session_turn_bucket` at ingest (`rebuildSessionTurnBuckets`, turn-buckets.ts):
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
  section: typeof InsightsSection.Delivery,
  period: InsightsPeriod,
  now?: Date
): Promise<DeliveryInsightsResponse>;
export function computeLocalInsights(
  prisma: DesktopPrisma,
  section: typeof InsightsSection.Utilization,
  period: InsightsPeriod,
  now?: Date
): Promise<UtilizationInsightsResponse>;
export function computeLocalInsights(
  prisma: DesktopPrisma,
  section: typeof InsightsSection.Agents,
  period: InsightsPeriod,
  now?: Date
): Promise<AgentsInsightsResponse>;
export function computeLocalInsights(
  prisma: DesktopPrisma,
  section: InsightsSection,
  period: InsightsPeriod,
  now?: Date
): Promise<LocalInsightsResponse>;
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

async function computeAgents(
  prisma: DesktopPrisma,
  range: Range
): Promise<AgentsInsightsResponse> {
  // token_usage has no Prisma relation to sessions (no DB FK — see schema), and
  // this is a COUNT(DISTINCT)/SUM aggregate over the join, so it stays raw.
  //
  // FEA-3487: fold the pre-compaction `baseline_*` totals into every token SUM
  // (input/output/cache_read/cache_write AND the derived input+output `tokens`),
  // mirroring the session_analytics rollup (session-analytics-rollup.ts) and the FEA-3317
  // sync-source fold. The sibling cost KPI is already priced on the EFFECTIVE
  // total (currentWindowCostSql sums cost_usd_estimated, which prices
  // current + baseline), so without this fold a Claude-Code context-compacted
  // session reports full incurred cost against a post-compaction token subset —
  // the two disagree in one dashboard and the AI-Impact card's Tokens-per-KLOC
  // numerator undercounts (and diverges from cloud, which folds baseline into
  // its synced tokens). `baseline_*` is NOT NULL DEFAULT 0, so the inner
  // COALESCE is defensive and the fold reduces to current-only for
  // never-compacted rows.
  const totals = await prisma.read((reader) =>
    reader.$queryRawUnsafe<
      {
        input_tokens: bigint;
        output_tokens: bigint;
        cache_read_tokens: bigint;
        cache_write_tokens: bigint;
        tokens: bigint;
        models: bigint;
      }[]
    >(
      `SELECT COALESCE(SUM(COALESCE(t.input_tokens, 0) + COALESCE(t.baseline_input, 0)), 0) AS input_tokens,
              COALESCE(SUM(COALESCE(t.output_tokens, 0) + COALESCE(t.baseline_output, 0)), 0) AS output_tokens,
              COALESCE(SUM(COALESCE(t.cache_read_tokens, 0) + COALESCE(t.baseline_cache_read, 0)), 0) AS cache_read_tokens,
              COALESCE(SUM(COALESCE(t.cache_write_tokens, 0) + COALESCE(t.baseline_cache_write, 0)), 0) AS cache_write_tokens,
              COALESCE(SUM(COALESCE(t.input_tokens, 0) + COALESCE(t.baseline_input, 0)
                         + COALESCE(t.output_tokens, 0) + COALESCE(t.baseline_output, 0)), 0) AS tokens,
              COUNT(DISTINCT t.model) AS models
       FROM token_usage t
       JOIN sessions s ON s.id = t.session_id
       WHERE s.started_at IS NOT NULL
         AND s.started_at BETWEEN $1 AND $2
         AND t.model IS NOT NULL`,
      range.startIso,
      range.endIso
    )
  );
  // `tools` / `toolUsage` aggregate over `events`, which has no Prisma relation
  // to `sessions` (events can predate their session) — raw. `agentsByStatus` /
  // `agentsByType` ARE typed: agents reach sessions via the real `session`
  // relation, so the date filter is a relation-where and the COUNT is a groupBy.
  const [tools, toolUsage, agentsByStatus, agentsByType] = await Promise.all([
    prisma.read((reader) =>
      reader.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT COUNT(*) AS n
       FROM events e
       JOIN sessions s ON s.id = e.session_id
       WHERE ${toolInvocationPredicate("e.tool_name")}
         AND s.started_at IS NOT NULL
         AND s.started_at BETWEEN $1 AND $2`,
        range.startIso,
        range.endIso
      )
    ),
    prisma.read((reader) =>
      reader.$queryRawUnsafe<{ tool_name: string; n: bigint }[]>(
        `SELECT e.tool_name AS tool_name, COUNT(*) AS n
         FROM events e
         JOIN sessions s ON s.id = e.session_id
         WHERE ${toolInvocationPredicate("e.tool_name")}
           AND s.started_at IS NOT NULL
           AND s.started_at BETWEEN $1 AND $2
         GROUP BY e.tool_name
         ORDER BY n DESC, e.tool_name ASC
         LIMIT 20`,
        range.startIso,
        range.endIso
      )
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
  // Aggregate agent-pipeline graph (FEA-3537): nodes by agent/subagent type,
  // edges by parent→child hand-off (agents.parent_agent_id self-join, the same
  // linkage getWorkflowData uses). Status is matched with the shared success/
  // failure term set (LIKE) so it survives harness-specific variants; the terms
  // are fixed constants (no injection risk). Blank type collapses to "unknown"
  // for both node and edge endpoints so every edge source/target has a matching
  // node (a "main" source with no "main" node would crash the d3 graph),
  // matching the cloud rollup.
  const statusLike = (col: string, terms: readonly string[]) =>
    terms.map((term) => `lower(${col}) LIKE '%${term}%'`).join(" OR ");
  const [agentPipelineNodeRows, agentPipelineEdgeRows] = await Promise.all([
    prisma.read((reader) =>
      reader.$queryRawUnsafe<
        {
          subagent_type: string;
          total: bigint;
          completed: bigint;
          errors: bigint;
          sessions: bigint;
          avg_duration: number | null;
        }[]
      >(
        `SELECT
           COALESCE(NULLIF(TRIM(a.subagent_type), ''), NULLIF(TRIM(a.type), ''), 'unknown') AS subagent_type,
           COUNT(*) AS total,
           SUM(CASE WHEN (${statusLike("a.status", AGENT_SUCCESS_STATUS_TERMS)}) THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN (${statusLike("a.status", AGENT_FAILED_STATUS_TERMS)}) THEN 1 ELSE 0 END) AS errors,
           COUNT(DISTINCT a.session_id) AS sessions,
           AVG(
             CASE
               WHEN a.started_at IS NOT NULL AND COALESCE(a.ended_at, a.updated_at) IS NOT NULL
               THEN unixepoch(COALESCE(a.ended_at, a.updated_at), 'subsec') - unixepoch(a.started_at, 'subsec')
               ELSE NULL
             END
           ) AS avg_duration
         FROM agents a
         JOIN sessions s ON s.id = a.session_id
         WHERE s.started_at IS NOT NULL
           AND s.started_at BETWEEN $1 AND $2
         GROUP BY subagent_type
         ORDER BY total DESC
         LIMIT 50`,
        range.startIso,
        range.endIso
      )
    ),
    prisma.read((reader) =>
      reader.$queryRawUnsafe<
        { source: string; target: string; weight: bigint }[]
      >(
        `SELECT
           COALESCE(NULLIF(TRIM(p.subagent_type), ''), NULLIF(TRIM(p.type), ''), 'unknown') AS source,
           COALESCE(NULLIF(TRIM(c.subagent_type), ''), NULLIF(TRIM(c.type), ''), 'unknown') AS target,
           COUNT(*) AS weight
         FROM agents c
         JOIN agents p ON c.parent_agent_id = p.id
         JOIN sessions s ON s.id = c.session_id
         WHERE s.started_at IS NOT NULL
           AND s.started_at BETWEEN $1 AND $2
         GROUP BY source, target
         ORDER BY weight DESC
         LIMIT 50`,
        range.startIso,
        range.endIso
      )
    ),
  ]);
  const agentPipelineNodes: AgentPipelineNode[] = agentPipelineNodeRows.map(
    (row) => {
      const completed = num(row.completed);
      const errors = num(row.errors);
      const finished = completed + errors;
      return {
        subagentType: row.subagent_type,
        total: num(row.total),
        completed,
        errors,
        sessions: num(row.sessions),
        // An unfinished type reads as 100% (no failures yet), matching cloud.
        successRate: finished > 0 ? (completed / finished) * 100 : 100,
        avgDuration: row.avg_duration == null ? null : row.avg_duration,
        trend: [],
      };
    }
  );
  const agentPipelineEdges: AgentPipelineEdge[] = agentPipelineEdgeRows.map(
    (row) => ({
      source: row.source,
      target: row.target,
      weight: num(row.weight),
    })
  );
  const toolsOverTime = await prisma.read((reader) =>
    reader.$queryRawUnsafe<DayCount[]>(
      `-- ISS-5493: shares toolInvocationPredicate with the tools KPI and
       -- toolUsage above and with the analytics byTool breakdown, so all four
       -- report the same corpus. See that helper for why NULL alone was wrong.
       SELECT ${localDay("s.started_at")} AS day,
              COUNT(*) AS n
       FROM events e
       JOIN sessions s ON s.id = e.session_id
       WHERE ${toolInvocationPredicate("e.tool_name")}
         AND s.started_at IS NOT NULL
         AND s.started_at BETWEEN $1 AND $2
       GROUP BY day`,
      range.trendStartIso,
      range.endIso
    )
  );
  // FEA-2331: the model charts measure estimated SPEND (USD), not token volume.
  // Token-share-by-model is misleading for cache-heavy harnesses — Claude Code's
  // prompt-cache reuse pushes ~all real token volume into cache_read_tokens
  // (excluded from input+output), so a low-cache tool can outrank it on tokens
  // while costing far less. Cost is cache-neutral, so it reflects where the money
  // actually goes. `cost_usd_estimated` is a REAL column → driver yields a float,
  // so these stay plain numbers (NOT the safe-integer token helpers). NULL costs
  // COALESCE to 0 (treated as $0) rather than dropping the row.
  // One statement owns both grouped buckets and their direct-SUM target, so a
  // concurrent ingest cannot land between two reads and be assigned as a
  // residual to a stale model set.
  const modelSpendRows = await prisma.read((reader) =>
    reader.$queryRawUnsafe<{ model: string; total: number; value: number }[]>(
      `WITH scopedModelSpend AS (
         SELECT t.model AS model, t.cost_usd_estimated AS cost
         ${currentWindowSpendScopeSql}
           AND t.model IS NOT NULL
       ), modelSpendTotal AS (
         SELECT COALESCE(SUM(cost), 0) AS total
         FROM scopedModelSpend
       )
       SELECT spend.model AS model,
              COALESCE(SUM(spend.cost), 0) AS value,
              totals.total AS total
       FROM scopedModelSpend spend
       CROSS JOIN modelSpendTotal totals
       GROUP BY spend.model, totals.total
       ORDER BY COALESCE(SUM(spend.cost), 0) DESC`,
      range.startIso,
      range.endIso
    )
  );
  const overTime = await prisma.read((reader) =>
    reader.$queryRawUnsafe<
      {
        day: string;
        model: string;
        value: number;
        tokens: number | bigint;
      }[]
    >(
      // FEA-3497: alongside per-(day, model) spend, sum total token volume (input +
      // output + cache read/write) so the shared Model Usage chart can toggle
      // between $ and #. Mirrors the cloud `fetchModelUsageRows` token semantics and
      // day bucketing so web and desktop compute usage the same. Desktop additionally
      // folds the `baseline_*` columns exactly as the KPI totals above do (191-196):
      // for a compacted Claude/Codex session the effective per-model totals live in
      // current + baseline, so summing only the current columns would under-report
      // `#` usage and disagree with the Tokens/Cache KPIs and priced spend on any
      // model/day with nonzero baselines. Cloud has no compaction baselines, so this
      // fold is desktop-only. `cost_usd_estimated` is a REAL column (float); the token
      // columns are integers, so their SUM stays whole and is read via `num` at build.
      `SELECT ${localDay("s.started_at")} AS day,
              t.model AS model,
              COALESCE(SUM(t.cost_usd_estimated), 0) AS value,
              COALESCE(
                SUM(
                  COALESCE(t.input_tokens, 0) + COALESCE(t.baseline_input, 0)
                  + COALESCE(t.output_tokens, 0) + COALESCE(t.baseline_output, 0)
                  + COALESCE(t.cache_read_tokens, 0) + COALESCE(t.baseline_cache_read, 0)
                  + COALESCE(t.cache_write_tokens, 0) + COALESCE(t.baseline_cache_write, 0)
                ),
                0
              ) AS tokens
       FROM token_usage t
       JOIN sessions s ON s.id = t.session_id
       WHERE s.started_at BETWEEN $1 AND $2 AND t.model IS NOT NULL
       GROUP BY day, t.model`,
      range.trendStartIso,
      range.endIso
    )
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
  const autonomyRows = await prisma.read((reader) =>
    reader.$queryRawUnsafe<{ day: string; agent: bigint; total: bigint }[]>(
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
    )
  );
  const autonomy = autonomyRows.map((r) => {
    const total = num(r.total);
    return {
      day: r.day,
      median: total > 0 ? (100.0 * num(r.agent)) / total : 0,
    };
  });

  const row = totals[0];
  const inputTokens = tokenCountValue(
    row?.input_tokens,
    "insights.agents.input_tokens"
  );
  const outputTokens = tokenCountValue(
    row?.output_tokens,
    "insights.agents.output_tokens"
  );
  const cacheReadTokens = tokenCountValue(
    row?.cache_read_tokens,
    "insights.agents.cache_read_tokens"
  );
  const cacheWriteTokens = tokenCountValue(
    row?.cache_write_tokens,
    "insights.agents.cache_write_tokens"
  );
  const cacheTokens = addStorageTokenCounts(
    cacheReadTokens,
    cacheWriteTokens,
    "insights.agents.cache_tokens"
  );
  // ISS-4463: same spend basis as the model breakdown, split by the originating
  // session's lifecycle outcome. Owned by its own module so this file (over the
  // size ceiling, shrink-only) does not grow.
  const spendByOutcome = await computeLocalSpendByOutcome(
    prisma,
    currentWindowSpendScopeSql,
    range.startIso,
    range.endIso,
    allocateRoundedUsdValues
  );
  const roundedBreakdown = allocateRoundedUsdValues(
    Object.fromEntries(
      modelSpendRows.map((item) => [item.model, num(item.value)])
    ),
    num(modelSpendRows[0]?.total)
  );
  const kpis: KpiStat[] = [
    kpi(
      "tokens",
      "Tokens",
      tokenCountValue(row?.tokens, "insights.agents.tokens"),
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

  // Spend + token series share the same top-N models so the shared chart's $/#
  // toggle only swaps y-values (FEA-3497).
  const modelSeries = buildModelSeries(overTime, range);

  return {
    kpis,
    charts: {
      modelUsageOverTime: modelSeries.spend,
      modelTokensOverTime: modelSeries.tokens,
      autonomyTrend: gapFilledSeries(
        new Map(autonomy.map((r) => [r.day, num(r.median)])),
        range,
        { key: "autonomy", label: "Autonomy" },
        null
      ),
      modelBreakdown: modelSpendRows.map((r) => ({
        key: r.model,
        label: r.model,
        // USD spend (float), allocated to cents — NOT a token count.
        value: roundedBreakdown[r.model] ?? 0,
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
      agentPipeline: {
        nodes: agentPipelineNodes,
        edges: agentPipelineEdges,
      },
      spendByOutcome,
    },
  };
}

async function computeUtilization(
  prisma: DesktopPrisma,
  range: Range
): Promise<UtilizationInsightsResponse> {
  // FILTER aggregate + a correlated COUNT subquery over `events` (no session
  // relation) — no typed-delegate form, stays raw.
  const totals = await prisma.read((reader) =>
    reader.$queryRawUnsafe<
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
    )
  );
  const perDay = await prisma.read((reader) =>
    reader.$queryRawUnsafe<DayCount[]>(
      `SELECT ${localDay("started_at")} AS day, COUNT(*) AS n
       FROM sessions
       WHERE started_at BETWEEN $1 AND $2
       GROUP BY day`,
      range.trendStartIso,
      range.endIso
    )
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
  const eventsPerDay = await prisma.read((reader) =>
    reader.$queryRawUnsafe<DayCount[]>(
      `SELECT ${localDay("e.created_at")} AS day,
              COUNT(*) AS n
       FROM events e
       JOIN sessions s ON s.id = e.session_id
       WHERE e.created_at IS NOT NULL
         AND e.created_at BETWEEN $1 AND $2
       GROUP BY day`,
      range.trendStartIso,
      range.endIso
    )
  );
  const eventsByType = await prisma.read((reader) =>
    reader.$queryRawUnsafe<{ event_type: string; n: bigint }[]>(
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
    )
  );
  // Typed: sessions.status is a plain column; the date filter is a column range.
  const sessionsByStatus = await prisma.client.session.groupBy({
    by: ["status"],
    where: { startedAt: { gte: range.startIso, lte: range.endIso } },
    _count: { _all: true },
  });
  // ISS-5936: resolve the delivery-population gate once for the section, the
  // same way computeDelivery does — one gated statement here versus its seven,
  // but one shared resolve-then-render definition of what the gate means.
  // ISS-5938: it resolves on the reader pool with the aggregate it gates, not on
  // the writer — it is a whole-corpus `session_artifact_links` aggregate, exactly
  // the read this section moved off `prisma.client`. Its own contract is typed on
  // `DesktopPrismaReader` so both dispatch paths are accepted.
  const nonDeliveryOnlyIds = await prisma.read((reader) =>
    resolveNonDeliveryOnlyArtifactIds(reader)
  );
  // FEA-2951: the "Review backlog" KPI (kpi:backlog) approximates the shared
  // tile's documented population — "Open PRs awaiting review". This is a
  // desktop-local APPROXIMATION of, not an exact match for, the web/cloud
  // `fetchReviewQueue` backlog, which counts OPEN, non-merged PRs whose
  // `reviewDecision IS NULL` (ISS-4629 scoped it to OPEN + `merged_at IS NULL`;
  // it is no longer `reviewDecision IS NULL regardless of pr_state`). Desktop has
  // no per-PR review-decision signal (the `artifacts` table only carries
  // `pr_state`), so the two populations still legitimately diverge: an open PR
  // that already has a decision counts here but not on web (web can exclude it,
  // desktop cannot). FEA-3455: this KPI's tile is Unavailable under personal
  // scope (see the tileAvailability map below), so the value is retained for
  // peers that read it but is not rendered.
  //
  // Count only PRs we positively know are open (LOWER(pr_state) = PrState.Open,
  // same casing guard as the merge-rate KPI, FEA-2486) plus un-enriched rows
  // (pr_state IS NULL) as the intended fallback. We deliberately avoid
  // `NOT IN ('merged','closed')`: that would fabricate "open" for any
  // future/unknown lifecycle value, inflating the KPI. Since PLN-1535 M5 the
  // column has no writer, so every row takes the NULL arm; the guard stays for
  // whatever fills it next. Unknown non-null states stay OUT of the backlog —
  // indeterminate, per the rest of the desktop lifecycle code.
  const reviewBacklog = await prisma.read((reader) =>
    reader.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*) AS n
       FROM artifacts
       WHERE kind = 'pull_request'
         -- ISS-5764: a PR this corpus only ever NAMED in prose is not in its
         -- review backlog. Without this gate every prose-mentioned PR lands in
         -- the un-enriched pr_state IS NULL fallback arm below and is counted
         -- as an open PR awaiting review (measured: 29 -> 52 on the golden
         -- corpus). Same delivery-population gate the capture/merge KPIs use.
         AND ${excludeNonDeliveryOnlyArtifacts("artifacts.id", nonDeliveryOnlyIds)}
         AND COALESCE(observed_at, created_at) IS NOT NULL
         AND (LOWER(pr_state) = '${PrState.Open}' OR pr_state IS NULL)`
    )
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
  const heatmapRows = await prisma.read((reader) =>
    reader.$queryRawUnsafe<
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
    )
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
    // FEA-3455: desktop is always personal scope, so mirror cloud's personal-
    // scope `buildUtilizationTileAvailability({ isOrg: false })` — the review
    // backlog KPI, reviewQueue and reviewerLoad are org-only and Unavailable
    // here. The local store has no per-PR review-decision signal, so those
    // review distributions can't be sourced; `reviewQueue` is emitted empty
    // (below) instead of the fabricated {captured, changes:0, approved:0}
    // placeholder. The `backlog` KPI value is retained as the documented
    // open-PR approximation (FEA-2951) — its tile is Unavailable, so it is not
    // rendered, but the value stays for any peer that reads it.
    tileAvailability: buildUtilizationTileAvailability(),
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
      // FEA-3455: no local review-decision signal to source the real cloud
      // distribution (`fetchReviewQueueBuckets` groups by reviewDecision), and
      // the tile is Unavailable under personal scope — so emit empty rather than
      // the fabricated {captured, changes:0, approved:0} placeholder.
      reviewQueue: [],
    },
  };
}

// A `localDay()`-bucketed COUNT row, shared by the three per-day trend reads.
type DayCount = { day: string; n: bigint };
