/**
 * Desktop-local Agents Insights section.
 *
 * Split out of `local-insights.ts` — which was approaching the file-size ceiling
 * — rather than grown into it, the same seam `local-insights-delivery.ts`,
 * `local-insights-spend.ts`, `local-insights-loc.ts` and
 * `local-insights-series.ts` already use: this module owns ONE Insights section,
 * its aggregate reads and the KPI/chart derivation over them.
 *
 * ISS-5938: each RAW aggregate is dispatched through `prisma.read` — the
 * round-robin pool of `query_only` reader connections — not the writer-bound
 * `prisma.client`, so a dashboard load does not serialize against the write
 * queue that owns sync durability. The TYPED delegate reads (`agent.groupBy`)
 * deliberately stay on `prisma.client` per FEA-2211; see the `local-insights.ts`
 * module header for that split and why it is residual rather than settled.
 */

import type {
  AgentPipelineEdge,
  AgentPipelineNode,
  AgentsInsightsResponse,
  KpiStat,
} from "@closedloop-ai/loops-api/insights";
import { KpiFormat, kpi } from "@closedloop-ai/loops-api/insights";
import {
  AGENT_FAILED_STATUS_TERMS,
  AGENT_SUCCESS_STATUS_TERMS,
} from "@repo/api/src/agent-session-status";
import { labelize } from "@repo/api/src/utils/string";
import { SESSIONS_ANALYTICS_DATE_WINDOW_FIELD } from "../../shared/session-date-window-contract.js";
import {
  sessionDateWindowNotNullSql,
  sessionDateWindowTsExpr,
} from "../agent-sync/session-date-window.js";
import { addStorageTokenCounts } from "../cost/token-counts.js";
import {
  type DayCount,
  localDay,
  numberOrZero as num,
  tokenCountValue,
  toolInvocationPredicate,
} from "./db-helpers.js";
import { windowPopulationField } from "./local-insights-population.js";
import type { Range } from "./local-insights-range.js";
import { buildModelSeries, gapFilledSeries } from "./local-insights-series.js";
import { computeLocalSpendByOutcome } from "./local-insights-spend.js";
import { currentWindowSpendScopeSql } from "./local-insights-window-sql.js";
import type { DesktopPrisma } from "./prisma-client.js";
import {
  allocateModelSpendBuckets,
  allocateRoundedUsdValues,
} from "./usd-allocation.js";

/**
 * The Agents section of local Insights for `range`.
 *
 * The daily autonomy trend here and the activity heatmap in
 * `local-insights-utilization.ts` share one turn-attribution ruling; it is
 * documented once in the `local-insights.ts` module header rather than restated
 * in either consumer.
 */
export async function computeAgents(
  prisma: DesktopPrisma,
  range: Range
): Promise<AgentsInsightsResponse> {
  // ISS-10541: this section windows on SESSION START, not on the range's field.
  //
  // ISS-10604 pointed these reads at `range.dateWindowField` so the Agents token
  // totals and the Agents spend stayed one corpus priced two ways (#7549 review,
  // whitlockk). That only took effect on the flag-ON path, and the PostHog key was
  // never created, so it never shipped. Retiring the cohort would have made it
  // every viewer's default while the CLOUD twins stayed on session start —
  // `token-queries.ts` (`sessionStartedAt`) and `agents-spend.ts`
  // (`s.session_started_at`) — forking four token KPIs and three spend charts
  // across two shells that draw one tile.
  //
  // ISS-10604's recorded scope settles which side moves: it aligns "the
  // dashboard's session count, its cost and the day series under them" and names
  // AGENTS-SPEND among the reads left alone. So this section keeps the analytics
  // basis on both shells, while the Delivery cost KPI the ruling does name moves
  // on both. The Delivery-cost/Agents-token split that leaves is the ruling's
  // own consequence, and it is now identical on web and desktop.
  const windowTs = sessionDateWindowTsExpr(
    SESSIONS_ANALYTICS_DATE_WINDOW_FIELD
  );
  const windowNotNull = sessionDateWindowNotNullSql(
    SESSIONS_ANALYTICS_DATE_WINDOW_FIELD
  );
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
       WHERE ${windowNotNull}
         AND ${windowTs} BETWEEN $1 AND $2
         AND t.model IS NOT NULL`,
      range.startIso,
      range.endIso
    )
  );
  // `toolUsage` aggregates over `events`, which has no Prisma relation to
  // `sessions` (events can predate their session) — raw. `agentsByStatus` /
  // `agentsByType` ARE typed: agents reach sessions via the real `session`
  // relation, so the date filter is a relation-where and the COUNT is a groupBy.
  //
  // `total` is the "Tool runs" KPI AND, since ISS-9842, the denominator the
  // "Tool usage share" ring divides every slice by; `categories` is how many
  // tool groups exist, so the ring can say how many tools its "Other" slice
  // folds. Both are unpartitioned windows over the GROUPED result, which SQLite
  // evaluates AFTER `GROUP BY` and BEFORE `ORDER BY`/`LIMIT`, so they cover
  // EVERY tool group — not just the 20 this breakdown keeps. Summing the
  // returned rows instead would silently truncate at the LIMIT.
  // `toolInvocationPredicate` gates the total and the groups alike, so NULL and
  // empty tool names cannot open a hole in one side only. Carrying the KPI on this read is also what keeps the bars from summing
  // to more than the total above them: separately dispatched reads are never
  // snapshot-consistent.
  const [toolUsage, agentsByStatus, agentsByType] = await Promise.all([
    prisma.read((reader) =>
      reader.$queryRawUnsafe<
        { tool_name: string; n: bigint; total: bigint; categories: bigint }[]
      >(
        `SELECT e.tool_name AS tool_name,
                COUNT(*) AS n,
                SUM(COUNT(*)) OVER () AS total,
                COUNT(*) OVER () AS categories
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
      range.elapsedEndIso
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
         ${currentWindowSpendScopeSql(SESSIONS_ANALYTICS_DATE_WINDOW_FIELD)}
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
      // between $ and #. Mirrors the cloud `fetchModelUsageRows` token semantics.
      // Its day bucketing no longer matches while the ISS-10604 alignment is ON:
      // cloud's `token-queries.ts` still buckets `session_started_at`, and this
      // follows the spend breakdown it shares a chart with rather than splitting
      // one chart across two columns. Desktop additionally
      // folds the `baseline_*` columns exactly as the KPI totals above do (191-196):
      // for a compacted Claude/Codex session the effective per-model totals live in
      // current + baseline, so summing only the current columns would under-report
      // `#` usage and disagree with the Tokens/Cache KPIs and priced spend on any
      // model/day with nonzero baselines. Cloud has no compaction baselines, so this
      // fold is desktop-only. `cost_usd_estimated` is a REAL column (float); the token
      // columns are integers, so their SUM stays whole and is read via `num` at build.
      `SELECT ${localDay(windowTs)} AS day,
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
       WHERE ${windowNotNull}
         AND ${windowTs} BETWEEN $1 AND $2 AND t.model IS NOT NULL
       GROUP BY day, t.model`,
      range.trendStartIso,
      range.elapsedEndIso
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
      range.elapsedEndIso
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
    currentWindowSpendScopeSql(SESSIONS_ANALYTICS_DATE_WINDOW_FIELD),
    range.startIso,
    range.endIso,
    allocateRoundedUsdValues
  );
  // ISS-7580: sanitizing the buckets and their conservation target is one
  // decision with two different right answers, so it lives beside the allocator
  // rather than as two inline coercions here.
  const roundedBreakdown = allocateModelSpendBuckets(modelSpendRows);
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
      // Carried identically on every `toolUsage` row; absent (no rows at all)
      // means no tool invocations in range, which reads 0.
      num(toolUsage[0]?.total),
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
        ...windowPopulationField(row),
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
