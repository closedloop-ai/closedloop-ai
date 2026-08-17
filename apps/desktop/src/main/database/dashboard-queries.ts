import {
  AGENT_FAILED_STATUS_TERMS,
  AGENT_SUCCESS_STATUS_TERMS,
} from "@repo/api/src/agent-session-status";
import type { InsightsPeriod, InsightsSection } from "@closedloop-ai/loops-api/insights";
import type {
  AnalyticsData,
  DashboardCoreFeatures,
  DashboardListWindow,
  DashboardPackSummary,
  DashboardPlanSummary,
  DashboardPullRequestSummary,
  DashboardSkillSummary,
  DashboardSubAgentSummary,
  DashboardSummary,
  DashboardToolSummary,
  TokenAnalytics,
  WorkflowQueryData,
} from "../../shared/agent-db-contract.js";
import {
  buildDashboardPullRequestSql,
  type SqlitePullRequestRow,
} from "./dashboard-pull-request-sql.js";
import {
  SKILL_SUMMARY_SQL,
  type SqliteSkillRow,
} from "./dashboard-skill-sql.js";
import {
  MAX_DASHBOARD_PLAN_PAGE_LIMIT,
  MAX_DASHBOARD_PULL_REQUEST_PAGE_LIMIT,
  TERMINAL_STATUS_SET,
} from "./db-constants.js";
import {
  coerceDashboardListWindow,
  compareIsoDesc,
  compareLastUsedThenName,
  localDay,
  maxIso,
  nonEmptyString,
  packIdFromSkillName,
  titleFromId,
  titleFromPlan,
  tokenCountValue,
  toolInvocationPredicate,
} from "./db-helpers.js";
import { computeLocalInsights } from "./local-insights.js";
import {
  excludeNonDeliveryOnlyArtifacts,
  resolveNonDeliveryOnlyArtifactIds,
} from "./non-delivery-artifacts.js";
import type { DesktopPrisma } from "./prisma-client.js";

// Every dashboard read runs on the single `DesktopPrisma` client — typed
// delegates where there is a clean form, raw `$queryRawUnsafe` for the
// aggregation/window/CTE SQL that has none. `getInsights` delegates to
// `computeLocalInsights(prisma, …)`.
//
// ISS-5938: every RAW read (`$queryRawUnsafe`) dispatches through `prisma.read`
// onto the READER pool — the heavy aggregation/CTE/json scans no longer
// serialize behind (or stall) the writer connection that owns sync durability,
// and they run concurrently over the WAL snapshot (no read-your-writes
// requirement here). TYPED delegate calls (`.count()`, `.aggregate()`,
// `.groupBy()`, the take-10 `findMany`) deliberately STAY on `prisma.client`:
// FEA-2211 (see session-count.ts) documents a libSQL community-adapter quirk
// where the aggregate delegate returns 0 on the `query_only` reader
// connections in PACKAGED builds while behaving correctly in the clean test
// env — so a typed aggregate moved to the pool would pass every test and zero
// the dashboard in production. Raw SQL on the pool is the proven-safe shape
// (the list total has always counted through it).

/**
 * The `events.event_type` the two `getWorkflowData` tool reads scope to.
 * Exported so a test seeds the same value these predicates match rather than
 * repeating the literal (ISS-5493, wongk review).
 */
export const TOOL_INVOCATION_EVENT_TYPE = "PreToolUse";

// Single success-rate FORMULA for the orchestration dashboard, shared by the
// headline `stats.successRate` and every per-type `effectiveness[].successRate`:
// completed over finished (completed + errors), excluding in-flight agents from
// the denominator, defaulting to 100 when nothing has finished yet. Previously
// the per-type rate divided by the full agent count (including running/pending
// agents), so a type with in-flight work reported an artificially low rate that
// contradicted the headline.
//
// ISS-4857: what the two share is the FORMULA, not the POPULATION — this
// comment previously said they "agree", which overclaimed. The headline is an
// all-agent KPI (root agents included, sitting alongside `stats.totalAgents`
// and the session-scoped `avgDurationSec` in the same mixed `stats` block),
// while `effectiveness[]`, the per-type breakdown, and `totalSubagents` count
// subagents only (`parent_agent_id IS NOT NULL OR type = 'subagent'`). So the
// two rates are computed identically but are NOT expected to be equal: a
// session whose root agent succeeded and whose subagents failed reads higher in
// the headline than in the breakdown beneath it. The all-agent scope is the one
// the signed corpus oracle records (`workflow.completed_agents` / `error_agents`
// / `success_rate` in packages/golden-sessions/corpus-expectations.yaml), so
// re-scoping the headline to subagents is an oracle amendment under
// packages/golden-sessions/AGENTS.md, not a local edit here.
function agentSuccessRate(completed: number, errors: number): number {
  const finished = completed + errors;
  return finished > 0 ? (completed / finished) * 100 : 100;
}

// FEA-3722: clamp a caller-supplied finite lookback to a sane whole number of
// days so an untrusted IPC value can't produce a negative/NaN/fractional SQL
// window. All-time (`null`) is handled before this by the caller.
const MAX_LOOKBACK_DAYS = 3650;
function normalizeLookbackDays(days: number): number {
  if (!Number.isFinite(days)) {
    return 30;
  }
  return Math.min(Math.max(1, Math.round(days)), MAX_LOOKBACK_DAYS);
}

// Build a Prisma `status` filter from the shared status vocabulary so agent
// counts classify success/failure identically to the in-memory regexes.
function agentStatusContainsFilter(
  terms: readonly string[]
): { status: { contains: string } }[] {
  return terms.map((term) => ({ status: { contains: term } }));
}

// Build a case-insensitive SQLite predicate over `status` from the same shared
// vocabulary, for the raw aggregation that has no typed equivalent. Terms are
// static constants, so inlining them is injection-safe.
function agentStatusLikePredicate(terms: readonly string[]): string {
  return terms.map((term) => `lower(status) LIKE '%${term}%'`).join(" OR ");
}

export function createSqliteDashboardQueries(prisma: DesktopPrisma) {
  return {
    async getSummary(): Promise<DashboardSummary> {
      const [
        totalSessions,
        activeSessions,
        totalAgents,
        totalEvents,
        distinctEventTypes,
        tokenTotals,
        recentSessions,
      ] = await Promise.all([
        // Typed delegates stay on the writer client — FEA-2211 (module note).
        prisma.client.session.count(),
        prisma.client.session.count({
          where: { status: { notIn: Array.from(TERMINAL_STATUS_SET) } },
        }),
        prisma.client.agent.count(),
        prisma.client.event.count(),
        // COUNT(DISTINCT event_type): event_type is NOT NULL, so one group per
        // distinct value means the group count equals the distinct count.
        prisma.client.event.groupBy({
          by: ["eventType"],
          _count: { _all: true },
        }),
        // SUM(input_tokens + output_tokens): the two model sums are validated
        // and added (the BigInt columns surface via the raw aggregate, coerced
        // to JS numbers at the token() boundary).
        prisma.client.tokenUsage.aggregate({
          _sum: { inputTokens: true, outputTokens: true },
        }),
        prisma.client.session.findMany({
          select: {
            id: true,
            name: true,
            status: true,
            model: true,
            cwd: true,
            startedAt: true,
          },
          orderBy: { startedAt: "desc" },
          take: 10,
        }),
      ]);
      return {
        totalSessions,
        activeSessions,
        totalAgents,
        totalEvents,
        eventTypeCount: distinctEventTypes.length,
        totalTokens:
          tokenCountValue(tokenTotals._sum.inputTokens, "summary.input") +
          tokenCountValue(tokenTotals._sum.outputTokens, "summary.output"),
        recentSessions: recentSessions.map((s) => ({
          id: s.id,
          name: s.name,
          status: s.status,
          model: s.model,
          cwd: s.cwd,
          startedAt: s.startedAt,
        })),
      };
    },
    async getTokenAnalytics(
      now?: Date,
      lookbackDays?: number | null
    ): Promise<TokenAnalytics> {
      // FEA-2345: all three facets (totals, byModel, byDay) source from
      // token_events over one shared window. token_events is @@ignore'd (no
      // Prisma delegate) — all queries stay $queryRawUnsafe.
      // FEA-2430: the window spans calendar days in the user's LOCAL timezone
      // (was UTC), matching the localtime byDay buckets below — edges are local
      // midnight / local end-of-today expressed as UTC instants, so the ISO
      // string comparison against UTC-stored created_at stays valid.
      // FEA-3722: the window honors the caller's selected date range. `undefined`
      // keeps the historical 30-day default (dashboard callers); a positive
      // number sets that rolling window; `null` means all-time (unbounded lower
      // bound), so the Coding Wrap can mirror the top 7d/30d/90d/All selector.
      const DEFAULT_WINDOW_DAYS = 30;
      const isAllTime = lookbackDays === null;
      const windowDays = isAllTime
        ? null
        : normalizeLookbackDays(lookbackDays ?? DEFAULT_WINDOW_DAYS);
      const ref = now ?? new Date();
      const upper = new Date(ref);
      upper.setHours(23, 59, 59, 999);
      const upperIso = upper.toISOString();
      // All-time uses the epoch as an inclusive lower bound so the WINDOW
      // predicate stays a single, parameterized shape for every branch.
      let cutoffIso = new Date(0).toISOString();
      if (windowDays !== null) {
        const cutoff = new Date(ref);
        cutoff.setHours(0, 0, 0, 0);
        cutoff.setDate(cutoff.getDate() - (windowDays - 1));
        cutoffIso = cutoff.toISOString();
      }
      const ISO_GUARD =
        "created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'";
      const WINDOW_PREDICATE = `${ISO_GUARD} AND created_at >= ? AND created_at <= ?`;

      /* All three facets run inside ONE read-scoped `$transaction` so they see a
         single committed snapshot — the exact case
         {@link DesktopPrismaReadClient} documents as the reason that API exists.
         Dispatched as three separate `prisma.read` calls they land on
         INDEPENDENT round-robin reader connections, each taking its own snapshot:
         a `token_events` commit landing between them (the live hook writer is
         always running) is then included by some facets and not others, and the
         headline totals stop reconciling with the byModel and byDay breakdowns
         rendered from the same response — a card that cannot be made to add up.
         Sequential `await`s, not `Promise.all`: an interactive transaction is
         pinned to one connection, so parallel dispatch would only queue on that
         connection's mutex. */
      const { totals, byModel, byDay } = await prisma.read((reader) =>
        reader.$transaction(async (tx) => {
          const totalRows = await tx.$queryRawUnsafe<
            {
              input_tokens: bigint;
              output_tokens: bigint;
              cache_read_tokens: bigint;
              cache_write_tokens: bigint;
            }[]
          >(
            `SELECT
            COALESCE(SUM(input_tokens), 0) as input_tokens,
            COALESCE(SUM(output_tokens), 0) as output_tokens,
            COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
            COALESCE(SUM(cache_write_tokens), 0) as cache_write_tokens
          FROM token_events
          WHERE ${WINDOW_PREDICATE}`,
            cutoffIso,
            upperIso
          );
          const byModelRows = await tx.$queryRawUnsafe<
            {
              model: string;
              input_tokens: bigint;
              output_tokens: bigint;
              sessions: bigint;
              estimated_cost_usd: number;
            }[]
          >(
            `SELECT model,
            SUM(input_tokens) as input_tokens,
            SUM(output_tokens) as output_tokens,
            COUNT(DISTINCT session_id) as sessions,
            COALESCE(SUM(cost_usd_estimated), 0) as estimated_cost_usd
          FROM token_events
          WHERE model IS NOT NULL AND ${WINDOW_PREDICATE}
          GROUP BY model
          ORDER BY COALESCE(SUM(cost_usd_estimated), 0) DESC`,
            cutoffIso,
            upperIso
          );
          const byDayRows = await tx.$queryRawUnsafe<
            {
              day: string;
              input_tokens: bigint;
              output_tokens: bigint;
              estimated_cost_usd: number;
            }[]
          >(
            `SELECT ${localDay("created_at")} as day,
            SUM(input_tokens) as input_tokens,
            SUM(output_tokens) as output_tokens,
            COALESCE(SUM(cost_usd_estimated), 0) as estimated_cost_usd
          FROM token_events
          WHERE ${WINDOW_PREDICATE}
          GROUP BY ${localDay("created_at")}
          ORDER BY day ASC`,
            cutoffIso,
            upperIso
          );
          return {
            totals: totalRows,
            byModel: byModelRows,
            byDay: byDayRows,
          };
        })
      );

      const t = totals[0];
      return {
        totalInputTokens: tokenCountValue(t?.input_tokens, "analytics.input"),
        totalOutputTokens: tokenCountValue(
          t?.output_tokens,
          "analytics.output"
        ),
        totalCacheReadTokens: tokenCountValue(
          t?.cache_read_tokens,
          "analytics.cache_read"
        ),
        totalCacheWriteTokens: tokenCountValue(
          t?.cache_write_tokens,
          "analytics.cache_write"
        ),
        // FEA-3722: report the finite window actually queried; all-time reports
        // 0, the agreed "unbounded" sentinel (the renderer labels the Wrap from
        // the selected date range, so 0 is only a fallback, never shown raw).
        windowDays: windowDays ?? 0,
        byModel: byModel.map((r) => ({
          model: r.model,
          inputTokens: tokenCountValue(r.input_tokens, "analytics.model.input"),
          outputTokens: tokenCountValue(
            r.output_tokens,
            "analytics.model.output"
          ),
          sessions: Number(r.sessions ?? 0),
          estimatedCostUsd:
            Math.round(Number(r.estimated_cost_usd ?? 0) * 100) / 100,
        })),
        byDay: byDay.map((r) => ({
          day: r.day,
          inputTokens: tokenCountValue(r.input_tokens, "analytics.day.input"),
          outputTokens: tokenCountValue(
            r.output_tokens,
            "analytics.day.output"
          ),
          estimatedCostUsd:
            Math.round(Number(r.estimated_cost_usd ?? 0) * 100) / 100,
        })),
      };
    },
    getInsights(section: InsightsSection, period: InsightsPeriod, now?: Date) {
      return computeLocalInsights(prisma, section, period, now);
    },
    async getAnalytics(
      now?: Date,
      lookbackDays?: number | null
    ): Promise<AnalyticsData> {
      // FEA-2430: anchor the dailyEvents window to the caller's `now` (like
      // getTokenAnalytics already does) instead of SQLite's literal 'now', so
      // tests that pass a fixed reference date stay deterministic forever.
      const refIso = (now ?? new Date()).toISOString();
      // FEA-3722: the token facet + tool-usage window honor the caller's
      // selected date range (undefined → 30-day default, `null` → all-time), so
      // the Coding Wrap mirrors the top 7d/30d/90d/All selector. `toolWindow` is
      // the strftime modifier used by the tool-usage query below.
      const toolWindow =
        lookbackDays === null
          ? "-100 years"
          : `-${normalizeLookbackDays(lookbackDays ?? 30)} days`;
      const [
        tokens,
        eventsByType,
        toolUsage,
        dailyEvents,
        sessionsByStatus,
        agentsByStatus,
        agentsByType,
        totalSessions,
        totalAgents,
        totalEvents,
      ] = await Promise.all([
        this.getTokenAnalytics(now, lookbackDays),
        // event_type is NOT NULL, so the typed groupBy's `_count._all`
        // reproduces COUNT(*); the SQL's ORDER BY count DESC is a JS sort.
        // Typed delegates stay on the writer client — FEA-2211 (module note).
        prisma.client.event.groupBy({
          by: ["eventType"],
          _count: { _all: true },
        }),
        // strftime relative-date windows have no typed-delegate form — raw.
        // FEA-2430/FEA-2649: anchored to the caller's `now` (refIso), not
        // SQLite's wall clock, so golden tests can pin the window.
        // FEA-3722: the window is the caller's selected range (`toolWindow`),
        // was a hardcoded -30 days.
        prisma.read((reader) =>
          reader.$queryRawUnsafe<{ tool_name: string; count: bigint }[]>(
            `SELECT tool_name, COUNT(*) as count FROM events WHERE created_at > strftime('%Y-%m-%dT%H:%M:%fZ', $1, '${toolWindow}') AND ${toolInvocationPredicate("tool_name")} GROUP BY tool_name ORDER BY count DESC LIMIT 20`,
            refIso
          )
        ),
        // FEA-2430: bucket daily events by the user's LOCAL day (was UTC per
        // FEA-1459 Fix 6) — every display-facing day bucket converts via
        // 'localtime'; the rolling -365d window filter stays an instant,
        // anchored to the caller's `now`.
        prisma.read((reader) =>
          reader.$queryRawUnsafe<{ date: string; count: bigint }[]>(
            `SELECT ${localDay("created_at")} as date, COUNT(*) as count FROM events WHERE created_at > strftime('%Y-%m-%dT%H:%M:%fZ', $1, '-365 days') GROUP BY ${localDay("created_at")} ORDER BY date ASC`,
            refIso
          )
        ),
        prisma.client.session.groupBy({
          by: ["status"],
          _count: { _all: true },
        }),
        prisma.client.agent.groupBy({
          by: ["status"],
          _count: { _all: true },
        }),
        prisma.client.agent.groupBy({
          by: ["type"],
          _count: { _all: true },
        }),
        prisma.client.session.count(),
        prisma.client.agent.count(),
        prisma.client.event.count(),
      ]);
      return {
        tokens,
        eventsByType: [...eventsByType]
          .sort((a, b) => b._count._all - a._count._all)
          .map((r) => ({
            eventType: r.eventType,
            count: r._count._all,
          })),
        toolUsage: toolUsage.map((r) => ({
          toolName: r.tool_name,
          count: Number(r.count ?? 0),
        })),
        dailyEvents: dailyEvents.map((r) => ({
          date: r.date,
          count: Number(r.count ?? 0),
        })),
        sessionsByStatus: sessionsByStatus.map((r) => ({
          status: r.status,
          count: r._count._all,
        })),
        agentsByStatus: agentsByStatus.map((r) => ({
          status: r.status,
          count: r._count._all,
        })),
        // COALESCE(type, 'unknown') folds the NULL-type group to 'unknown'; the
        // SQL's ORDER BY count DESC is a JS sort.
        agentsByType: [...agentsByType]
          .sort((a, b) => b._count._all - a._count._all)
          .map((r) => ({
            type: r.type ?? "unknown",
            count: r._count._all,
          })),
        totalSessions,
        totalAgents,
        totalEvents,
      };
    },
    async getWorkflowData(now?: Date): Promise<WorkflowQueryData> {
      // FEA-2430/FEA-2649: anchor the tool-transition (-7d) and tool-count
      // (-30d) windows to the caller's `now` instead of SQLite's wall clock —
      // same contract as getTokenAnalytics/getAnalytics, so golden tests can
      // pin the windows. Production passes nothing and keeps real time.
      const refIso = (now ?? new Date()).toISOString();
      // Typed delegates stay on the writer client — FEA-2211 (module note).
      const totalSessions = await prisma.client.session.count();
      const totalAgents = await prisma.client.agent.count();
      const totalSubagents = await prisma.client.agent.count({
        where: { OR: [{ type: "subagent" }, { parentAgentId: { not: null } }] },
      });
      // Classify by the shared status vocabulary (AGENT_*_STATUS_TERMS) so these
      // counts and the per-type aggregate below classify identically to the
      // sessions view: statuses like "success"/"complete"/"done" count as
      // completed and "fail"/"error" as errors, instead of only the exact
      // strings "completed"/"failed".
      // ISS-4857: deliberately NOT filtered to `totalSubagents`' subagent
      // population above — the headline is an all-agent KPI, so it does not
      // reconcile with the subagent-scoped breakdown. See `agentSuccessRate`.
      const completedAgents = await prisma.client.agent.count({
        where: { OR: agentStatusContainsFilter(AGENT_SUCCESS_STATUS_TERMS) },
      });
      const errorAgents = await prisma.client.agent.count({
        where: { OR: agentStatusContainsFilter(AGENT_FAILED_STATUS_TERMS) },
      });
      // parent_agent_id IS NULL AND (type IS NULL OR type != 'subagent'): the
      // explicit OR branch covers the NULL type regardless of how Prisma's `not`
      // treats nulls, so the union equals the original predicate exactly.
      const mainCount = await prisma.client.agent.count({
        where: {
          parentAgentId: null,
          OR: [{ type: null }, { type: { not: "subagent" } }],
        },
      });
      const outcomes = await prisma.client.session.groupBy({
        by: ["status"],
        _count: { _all: true },
      });
      // ISS-5938/ISS-6501: the heavy raw aggregation/window/CTE reads run on
      // the reader pool, off the writer, and are dispatched as ONE concurrent
      // batch so the pool actually has more than one statement in flight.
      const {
        depthRow,
        durationRow,
        subagentTypes,
        edges,
        toolTransitions,
        toolCounts,
        cooccurrence,
      } = await readWorkflowRawRows(prisma, refIso);
      // AVG over an empty set is NULL — no sessions with agents means 0 depth.
      const avgDepth = Number(depthRow[0]?.avg ?? 0);
      const successRate = agentSuccessRate(completedAgents, errorAgents);
      const mappedSubagentTypes = subagentTypes.map((row) => ({
        subagentType: row.subagent_type,
        count: Number(row.count ?? 0),
        completed: Number(row.completed ?? 0),
        errors: Number(row.errors ?? 0),
      }));
      return {
        stats: {
          totalSessions,
          totalAgents,
          totalSubagents,
          avgSubagents: totalSessions > 0 ? totalSubagents / totalSessions : 0,
          successRate,
          avgDepth,
          avgDurationSec: Number(durationRow[0]?.avg ?? 0),
          totalCompactions: 0,
          avgCompactions: 0,
          topFlow:
            toolTransitions.length > 0
              ? {
                  source: toolTransitions[0].source,
                  target: toolTransitions[0].target,
                  count: Number(toolTransitions[0].value ?? 0),
                }
              : null,
        },
        orchestration: {
          sessionCount: totalSessions,
          mainCount,
          subagentTypes: mappedSubagentTypes,
          edges: edges.map((r) => ({
            source: r.source,
            target: r.target,
            weight: Number(r.weight ?? 0),
          })),
          outcomes: outcomes.map((r) => ({
            status: r.status,
            count: r._count._all,
          })),
          compactions: { total: 0, sessions: 0 },
        },
        toolFlow: {
          transitions: toolTransitions.map((r) => ({
            source: r.source,
            target: r.target,
            value: Number(r.value ?? 0),
          })),
          toolCounts: toolCounts.map((r) => ({
            toolName: r.tool_name,
            count: Number(r.count ?? 0),
          })),
        },
        effectiveness: mappedSubagentTypes.map((st) => ({
          subagentType: st.subagentType,
          total: st.count,
          completed: st.completed,
          errors: st.errors,
          sessions: 0,
          successRate: agentSuccessRate(st.completed, st.errors),
          avgDuration: null,
          trend: [],
        })),
        cooccurrence: cooccurrence.map((r) => ({
          source: r.source,
          target: r.target,
          weight: Number(r.weight ?? 0),
        })),
      };
    },
    async getCoreFeatures(): Promise<DashboardCoreFeatures> {
      // ISS-5630: ONE skills read serves both `skills` and the packs fold.
      // This used to call `getPacks()` (which itself calls `getSkills()`) and
      // `getSkills()` concurrently, so the same Skill-event corpus was
      // materialized twice in the same heap on every dashboard load.
      //
      // ISS-5631 / ISS-6451: `plans` and `pullRequests` are this bundle's bounded
      // facets — each read's own default window (the newest
      // MAX_DASHBOARD_PLAN_PAGE_LIMIT plans, the newest
      // MAX_DASHBOARD_PULL_REQUEST_PAGE_LIMIT PRs). That is deliberate: both are
      // whole-corpus ROW reads, so leaving either caller uncapped would just move
      // the whole-corpus IPC response onto `desktop:db:get-core-features`. The
      // bundle has no window of its own, so a caller that needs page 2 reads
      // `desktop:db:get-plans` / `desktop:db:get-pull-requests` directly. NOTE for
      // a corpus intake: golden-layer3's `agg.core.plans_count` and
      // `agg.core.pull_requests_count` compare these against the FULL derived
      // counts, so they go red (loudly, by design) the first time a corpus
      // carries more of either than its cap.
      const [skills, tools, subagents, plans, pullRequests] = await Promise.all(
        [
          this.getSkills(),
          this.getTools(),
          this.getSubAgents(),
          this.getPlans(),
          this.getPullRequests(),
        ]
      );
      return {
        packs: buildPacksFromSkills(skills),
        skills,
        tools,
        subagents,
        plans,
        pullRequests,
      };
    },
    async getPacks(): Promise<DashboardPackSummary[]> {
      return buildPacksFromSkills(await this.getSkills());
    },
    async getSkills(): Promise<DashboardSkillSummary[]> {
      // ISS-4854 / ISS-5629: `SKILL_SUMMARY_SQL` extracts the skill fields AND
      // folds them to ONE row per (harness, skill name) in SQL, so this read
      // never hydrates the Skill-event corpus into the heap-capped db-host —
      // see `dashboard-skill-sql.ts` for how each JS classification step maps
      // onto the query. Runs on the reader pool (ISS-5938), never the writer.
      const rows = await prisma.read((reader) =>
        reader.$queryRawUnsafe<SqliteSkillRow[]>(SKILL_SUMMARY_SQL)
      );
      return rows
        .map((row) => {
          const packId = packIdFromSkillName(row.name);
          return {
            id: `${row.harness}:${packId ?? "standalone"}:${row.name}`,
            packId,
            name: row.name,
            harness: row.harness,
            description: row.description,
            installPath: row.install_path,
            invocationCount: Number(row.invocation_count ?? 0),
            lastUsedAt: row.last_used_at,
          };
        })
        .sort(compareLastUsedThenName);
    },
    async getTools(): Promise<DashboardToolSummary[]> {
      // COUNT(DISTINCT session_id) + MAX(created_at) per tool — no typed groupBy
      // form (Prisma _count is row count, not distinct); raw on the one client.
      const result = await prisma.read((reader) =>
        reader.$queryRawUnsafe<
          {
            tool_name: string;
            invocation_count: bigint;
            session_count: bigint;
            last_used_at: string | null;
          }[]
        >(`
        SELECT tool_name,
          COUNT(*) as invocation_count,
          COUNT(DISTINCT session_id) as session_count,
          MAX(created_at) as last_used_at
        FROM events
        WHERE ${toolInvocationPredicate("tool_name")}
        GROUP BY tool_name
        ORDER BY invocation_count DESC, tool_name ASC
      `)
      );
      return result.map((row) => ({
        toolName: row.tool_name,
        invocationCount: Number(row.invocation_count ?? 0),
        sessionCount: Number(row.session_count ?? 0),
        lastUsedAt: row.last_used_at ?? null,
      }));
    },
    async getSubAgents(): Promise<DashboardSubAgentSummary[]> {
      // GROUP BY over COALESCE(subagent_type, MAX(type)) with conditional SUMs
      // and COUNT(DISTINCT session_id) — no typed groupBy form; raw on the one
      // client. The status predicates are derived from the same shared
      // vocabulary as getWorkflowData so success/failure classify identically.
      const completedStatusPredicate = agentStatusLikePredicate(
        AGENT_SUCCESS_STATUS_TERMS
      );
      const errorStatusPredicate = agentStatusLikePredicate(
        AGENT_FAILED_STATUS_TERMS
      );
      const result = await prisma.read((reader) =>
        reader.$queryRawUnsafe<
          {
            subagent_type: string;
            total: bigint;
            completed: bigint;
            errors: bigint;
            sessions: bigint;
            last_used_at: string | null;
          }[]
        >(`
        SELECT COALESCE(agents.subagent_type, COALESCE(MAX(agents.type), 'unknown')) as subagent_type,
          COUNT(*) as total,
          SUM(CASE WHEN (${completedStatusPredicate}) THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN (${errorStatusPredicate}) THEN 1 ELSE 0 END) as errors,
          COUNT(DISTINCT session_id) as sessions,
          MAX(updated_at) as last_used_at
        FROM agents
        WHERE parent_agent_id IS NOT NULL OR type = 'subagent'
        GROUP BY agents.subagent_type
        ORDER BY total DESC, subagent_type ASC
      `)
      );
      return result.map((row) => ({
        subagentType: row.subagent_type,
        total: Number(row.total ?? 0),
        completed: Number(row.completed ?? 0),
        errors: Number(row.errors ?? 0),
        sessions: Number(row.sessions ?? 0),
        lastUsedAt: row.last_used_at ?? null,
      }));
    },
    async getPlans(
      opts?: DashboardListWindow
    ): Promise<DashboardPlanSummary[]> {
      // ISS-5631: the read is WINDOWED — `limit`/`offset` mirror the paginated
      // sibling `listPlans` (`desktop:db:get-plans-list`), clamped by
      // `coerceDashboardListWindow` so no caller can widen it back to the corpus.
      //
      // What this bounds is the RETURNED ARRAY, and so the IPC response: a plan
      // carries its full markdown `content`, and this read used to hand back
      // every plan in the store on one call. It does NOT bound what the db-host
      // transiently materializes — the SQL below still extracts every plan's
      // content before the fold, so this is not a fix for the FEA-2038 OOM shape
      // the ISS-4855 note beneath describes. Bounding that too needs a two-phase
      // read (page the skinny ordering columns, then fetch content for the page),
      // which is why it is not done here: the ORDER cannot be reproduced in SQL.
      // The window is applied to the FOLDED, SORTED result rather than as a SQL
      // `LIMIT` for exactly that reason — the SQL `ORDER BY` below only seeds the
      // stable JS sort, and the order actually returned is `compareIsoDesc` over
      // each plan's OWN `timestamp`: free-text metadata (`nullableShortTextSchema`,
      // not a normalized column) compared with `Date.parse`, which SQLite can only
      // sort LEXICALLY. A SQL `LIMIT` would therefore page by a DIFFERENT order
      // than it returns and drop plans that belong on the page; windowing
      // post-sort keeps every page identical to the prefix the uncapped read
      // returned.
      const { limit, offset } = coerceDashboardListWindow(
        opts,
        MAX_DASHBOARD_PLAN_PAGE_LIMIT
      );
      // ISS-4855: explode `metadata.plans` in SQL via `json_each`
      // instead of materializing EVERY session's metadata blob into JS to find
      // the handful of rows that carry plans (on a large real corpus that read
      // hydrated hundreds of MB of metadata text per call — the FEA-2038
      // db-host OOM shape). The read returns O(plans) skinny rows: session
      // identity columns plus the three extracted plan fields. Guards mirror
      // the former JS classification exactly: an invalid/non-object metadata or
      // a non-array `plans` contributes nothing (`parseJsonObjectText` +
      // `Array.isArray` → the CASE yields '[]'), a non-object array entry or a
      // non-string field extracts NULL (`asRecord` / `nonEmptyString` on a
      // non-string → skipped), and `p.key` preserves the ORIGINAL array index
      // so plan ids are unchanged even when earlier entries are skipped. The
      // JS fold below (trim/empty classification, title derivation, timestamp
      // fallback, final sort) is unchanged. Runs on the reader pool (ISS-5938).
      // The inner subquery parses each metadata blob a bounded number of times
      // (`json_valid` guard, the `json_type` array gate, one `json_extract`)
      // and hands `json_each` only the extracted (small) plans array.
      // `json_extract('$.plans')` on a valid non-object root yields NULL
      // (matching `parseJsonObjectText`'s object requirement). The array gate
      // is checked with `json_type(metadata, '$.plans')` against the PARENT
      // document — never by re-validating the extracted text: `json_extract`
      // returns a STRING field dequoted, so a `plans` field that is a JSON
      // string whose contents happen to spell an array would pass a
      // post-extraction `json_valid`/`json_type` check and fabricate plan rows
      // the former `Array.isArray` correctly rejected (db-review finding).
      const result = await prisma.read((reader) =>
        reader.$queryRawUnsafe<SqlitePlanRow[]>(`
        SELECT
          s.id AS session_id,
          s.cwd AS cwd,
          s.harness AS harness,
          s.updated_at AS updated_at,
          p.key AS plan_index,
          CASE WHEN p.type = 'object' AND json_type(p.value, '$.content') = 'text'
               THEN json_extract(p.value, '$.content') END AS content,
          CASE WHEN p.type = 'object' AND json_type(p.value, '$.source') = 'text'
               THEN json_extract(p.value, '$.source') END AS source,
          CASE WHEN p.type = 'object' AND json_type(p.value, '$.timestamp') = 'text'
               THEN json_extract(p.value, '$.timestamp') END AS plan_timestamp
        FROM (
          SELECT
            id,
            cwd,
            harness,
            updated_at,
            CASE
              WHEN metadata IS NOT NULL AND json_valid(metadata)
                AND json_type(metadata, '$.plans') = 'array'
              THEN json_extract(metadata, '$.plans')
            END AS plans_json
          FROM sessions
        ) s
        JOIN json_each(COALESCE(s.plans_json, '[]')) p
        ORDER BY s.updated_at DESC, p.key ASC
      `)
      );
      const plans: DashboardPlanSummary[] = [];
      const seen = new Set<string>();
      for (const row of result) {
        const content = nonEmptyString(row.content);
        if (!content) {
          continue;
        }
        const timestamp =
          nonEmptyString(row.plan_timestamp) ?? row.updated_at ?? null;
        const id = `${row.session_id}:plan:${Number(row.plan_index)}`;
        if (seen.has(id)) {
          continue;
        }
        seen.add(id);
        plans.push({
          id,
          sessionId: row.session_id,
          title: titleFromPlan(content),
          source: nonEmptyString(row.source) ?? null,
          content,
          timestamp,
          harness: row.harness,
          cwd: row.cwd,
        });
      }
      plans.sort((a, b) => compareIsoDesc(a.timestamp, b.timestamp));
      return plans.slice(offset, offset + limit);
    },
    async getPullRequests(
      opts?: DashboardListWindow
    ): Promise<DashboardPullRequestSummary[]> {
      // ISS-6451: the read is WINDOWED — `limit`/`offset` mirror `getPlans`,
      // clamped by `coerceDashboardListWindow` so no caller can widen it back to
      // the whole corpus. This was the last unwindowed full-corpus row read in
      // this module: it returned every `kind='pull_request'` artifact, sorted the
      // wide rows in JS, and shipped the array across the db-host IPC boundary,
      // through either of the two entry points that reach it — the
      // `getCoreFeatures` fan-out and the standalone
      // `desktop:db:get-pull-requests` channel.
      //
      // Unlike `getPlans` — whose order is `Date.parse` over a free-text metadata
      // field SQLite cannot reproduce, so its window has to be applied post-sort
      // in JS — `observed_at` is a real column, so the ordering lives in the
      // query's `ORDER BY` and this is a true SQL `LIMIT`/`OFFSET`. What that
      // buys is the IPC RESPONSE and the JS fold below, both now O(page): it does
      // NOT bound what the db-host transiently materializes, same caveat as
      // `getPlans`. The `ROW_NUMBER()` window still ranks every linked PR
      // artifact, and `artifacts` carries no index on `observed_at`, so SQLite
      // still sorts the whole ranked set in a temp b-tree before `LIMIT` takes
      // its slice.
      const { limit, offset } = coerceDashboardListWindow(
        opts,
        MAX_DASHBOARD_PULL_REQUEST_PAGE_LIMIT
      );
      // pr_number is INTEGER and the raw path can surface it as BigInt, so it is
      // Number()-coerced below.
      const result = await prisma.read(async (reader) => {
        // ISS-5936: resolve the delivery-population gate inside the SAME pooled
        // reader dispatch as the statement that consumes it, so both run on one
        // connection instead of taking two round-robin slots.
        const nonDeliveryOnlyIds =
          await resolveNonDeliveryOnlyArtifactIds(reader);
        return reader.$queryRawUnsafe<SqlitePullRequestRow[]>(
          buildDashboardPullRequestSql(
            excludeNonDeliveryOnlyArtifacts("a.id", nonDeliveryOnlyIds)
          ),
          limit,
          offset
        );
      });
      const pullRequests: DashboardPullRequestSummary[] = [];
      for (const row of result) {
        const number = row.pr_number == null ? null : Number(row.pr_number);
        const repoFullName = row.repo_full_name;
        if (number == null || !repoFullName) {
          continue;
        }
        pullRequests.push({
          id: row.artifact_id,
          sessionId: row.session_id,
          sessionName: row.session_name,
          prUrl:
            row.pr_url ?? `https://github.com/${repoFullName}/pull/${number}`,
          prNumber: number,
          repoFullName,
          branchName: row.branch_name,
          headSha: row.head_sha,
          title: row.title,
          harness: row.harness,
          observedAt: row.observed_at,
        });
      }
      return pullRequests;
    },
  };
}

/**
 * ISS-5630: fold a skills list into the pack rollup. Extracted from `getPacks`
 * so `getCoreFeatures` can derive packs from the ONE skills read it already
 * performs instead of issuing a second concurrent Skill-event read.
 */
function buildPacksFromSkills(
  skills: readonly DashboardSkillSummary[]
): DashboardPackSummary[] {
  const packs = new Map<string, DashboardPackSummary>();
  for (const skill of skills) {
    if (!skill.packId) {
      continue;
    }
    const existing = packs.get(skill.packId);
    if (existing) {
      existing.skillCount++;
      existing.toolCallCount += skill.invocationCount;
      existing.lastUsedAt = maxIso(existing.lastUsedAt, skill.lastUsedAt);
      continue;
    }
    packs.set(skill.packId, {
      id: skill.packId,
      name: titleFromId(skill.packId),
      harness: skill.harness,
      installPath: null,
      sourceUrl: null,
      version: null,
      skillCount: 1,
      toolCallCount: skill.invocationCount,
      lastUsedAt: skill.lastUsedAt,
    });
  }
  return [...packs.values()].sort(compareLastUsedThenName);
}

/**
 * ISS-5938: the `getWorkflowData` RAW aggregation/window/CTE reads, extracted
 * onto the reader pool instead of the writer. Same queries, same shapes —
 * only the connection moved. The method's TYPED delegate counts/groupBy stay
 * on `prisma.client` per the FEA-2211 note at the top of this module.
 *
 * ISS-6501: none of the seven consumes another's result, so they are issued as
 * ONE concurrent batch. That OVERLAPS their latency — it does not collapse them
 * into fewer queries. A serial `await` chain round-robined its dispatches
 * across the pool but only ever had one statement in flight, so the pool's
 * parallelism was never used.
 *
 * Seven is a fixed handful rather than a data-driven fan-out, so a plain
 * `Promise.all` is pool-safe and needs no limiter. It is NOT free, and the
 * costs are the `computeDelivery` ones (`local-insights-delivery.ts`) at a
 * smaller width:
 *
 * - Seven statements land on the two-slot pool (`DEFAULT_READER_POOL_SIZE`),
 *   which dispatches strict round-robin with no availability check, so a pooled
 *   read from another surface can now queue behind three or four of them —
 *   including the recursive `agent_depth` CTE and the `LEAD()` window — where
 *   the serial chain left it behind at most one. Bounded rather than
 *   open-ended: `dashboard.getWorkflowData` is a `BOUNDED_READ_OPS` member
 *   (`db-host/db-host-op-lanes.ts`) at a ceiling of 2, so at most two of these
 *   batches overlap. Both slots also stay non-idle for the batch's duration, so
 *   a `recycleIdleReaders` tick that lands inside it skips the whole pool where
 *   the serial chain always left one slot recyclable, and a concurrent reader
 *   `$transaction` that lands on a busy slot spends its `TRANSACTION_MAX_WAIT_MS`
 *   behind three or four statements instead of one.
 * - Peak heap is NOT what changes: the serial chain held all seven result sets
 *   live in its own locals until the same return, so the SUM was always the
 *   peak. What the batch adds is SQLite's per-statement working memory at two
 *   concurrent statements rather than one — bounded by the pool, not by seven.
 *   That is affordable only because every result set is small: two single-row
 *   AVGs, four `LIMIT`ed rollups, and a GROUP BY over the distinct subagent
 *   types. Do not add an unbounded read to this array.
 * - No short-circuit: a failing aggregate used to skip the ones after it, and
 *   now all seven run to completion — and the batch DRAINS them before it
 *   unwinds, so the op cannot release its lane permit while sibling reads are
 *   still on the pool (see the `allSettled` note at the call site). Accepted —
 *   these are local reads whose failure means the store itself is unusable.
 *
 * The snapshot guarantee is unchanged: these were seven independent implicit
 * transactions before and still are, so intra-batch skew was always possible.
 */
async function readWorkflowRawRows(prisma: DesktopPrisma, refIso: string) {
  // The subagent/edge status predicates are derived from the same shared
  // vocabulary as the typed counts above.
  const completedStatusPredicate = agentStatusLikePredicate(
    AGENT_SUCCESS_STATUS_TERMS
  );
  const errorStatusPredicate = agentStatusLikePredicate(
    AGENT_FAILED_STATUS_TERMS
  );
  const reads = [
    // Recursive depth CTE — no typed form; raw. The per-session max depths only
    // ever fed one scalar, so AVG them in SQL: returning O(sessions) rows to
    // average in JS would hydrate the whole per-session set into the heap-capped
    // db-host worker.
    prisma.read((reader) =>
      reader.$queryRawUnsafe<{ avg: number | null }[]>(`
    WITH RECURSIVE agent_depth(id, session_id, depth) AS (
      SELECT id, session_id, 0 FROM agents WHERE parent_agent_id IS NULL
      UNION ALL
      SELECT a.id, a.session_id, ad.depth + 1
      FROM agents a JOIN agent_depth ad ON a.parent_agent_id = ad.id
    )
    SELECT AVG(max_depth) as avg FROM (
      SELECT MAX(depth) as max_depth FROM agent_depth GROUP BY session_id
    ) session_depth
  `)
    ),
    // AVG(unixepoch(...)) date arithmetic — raw.
    prisma.read((reader) =>
      reader.$queryRawUnsafe<{ avg: number | null }[]>(`
    SELECT AVG(unixepoch(COALESCE(ended_at, updated_at), 'subsec') - unixepoch(started_at, 'subsec')) as avg
    FROM sessions WHERE started_at IS NOT NULL
      AND unixepoch(COALESCE(ended_at, updated_at), 'subsec') >= unixepoch(started_at, 'subsec')
  `)
    ),
    // GROUP BY over COALESCE(subagent_type, MAX(name)) plus conditional SUMs —
    // no typed groupBy form; raw.
    prisma.read((reader) =>
      reader.$queryRawUnsafe<
        {
          subagent_type: string;
          count: bigint;
          completed: bigint;
          errors: bigint;
        }[]
      >(`
    SELECT COALESCE(agents.subagent_type, COALESCE(MAX(agents.type), 'unknown')) as subagent_type,
      COUNT(*) as count,
      SUM(CASE WHEN (${completedStatusPredicate}) THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN (${errorStatusPredicate}) THEN 1 ELSE 0 END) as errors
    FROM agents WHERE parent_agent_id IS NOT NULL OR type = 'subagent'
    GROUP BY agents.subagent_type ORDER BY count DESC
  `)
    ),
    // GROUP BY over COALESCE(...) join keys — raw.
    prisma.read((reader) =>
      reader.$queryRawUnsafe<
        {
          source: string;
          target: string;
          weight: bigint;
        }[]
      >(`
    SELECT COALESCE(p.subagent_type, COALESCE(MAX(p.type), 'main')) as source,
      COALESCE(c.subagent_type, COALESCE(MAX(c.type), 'unknown')) as target,
      COUNT(*) as weight
    FROM agents c JOIN agents p ON c.parent_agent_id = p.id
    GROUP BY p.subagent_type, c.subagent_type ORDER BY weight DESC LIMIT 50
  `)
    ),
    // LEAD() window over the recent-tool sequence — raw.
    prisma.read((reader) =>
      reader.$queryRawUnsafe<
        {
          source: string;
          target: string;
          value: bigint;
        }[]
      >(
        `
    WITH recent_tools AS (
      SELECT tool_name, session_id, created_at, id
      FROM events
      WHERE ${toolInvocationPredicate("tool_name")}
        AND event_type = $2
        AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', $1, '-7 days')
    ),
    tool_seq AS (
      SELECT tool_name,
        LEAD(tool_name) OVER (PARTITION BY session_id ORDER BY created_at, id) as next_tool
      FROM recent_tools
    )
    SELECT tool_name as source, next_tool as target, COUNT(*) as value
    FROM tool_seq
    WHERE next_tool IS NOT NULL
    GROUP BY source, target ORDER BY value DESC LIMIT 30
  `,
        refIso,
        TOOL_INVOCATION_EVENT_TYPE
      )
    ),
    // strftime relative-date window — raw, anchored to the caller's `now`.
    prisma.read((reader) =>
      reader.$queryRawUnsafe<{ tool_name: string; count: bigint }[]>(
        `SELECT tool_name, COUNT(*) as count FROM events WHERE created_at > strftime('%Y-%m-%dT%H:%M:%fZ', $1, '-30 days') AND ${toolInvocationPredicate("tool_name")} AND event_type = $2 GROUP BY tool_name ORDER BY count DESC LIMIT 20`,
        refIso,
        TOOL_INVOCATION_EVENT_TYPE
      )
    ),
    // COUNT(DISTINCT) self-join over the per-session agent-type set — raw.
    prisma.read((reader) =>
      reader.$queryRawUnsafe<
        {
          source: string;
          target: string;
          weight: bigint;
        }[]
      >(`
    WITH session_agent_types AS (
      SELECT DISTINCT session_id,
        COALESCE(subagent_type, type, 'unknown') AS agent_type
      FROM agents
    )
    SELECT t1.agent_type as source, t2.agent_type as target,
      COUNT(DISTINCT t1.session_id) as weight
    FROM session_agent_types t1
    JOIN session_agent_types t2
      ON t1.session_id = t2.session_id AND t1.agent_type < t2.agent_type
    GROUP BY t1.agent_type, t2.agent_type ORDER BY weight DESC LIMIT 30
  `)
    ),
  ] as const;
  // ISS-6501 (wongk review): DRAIN, then unwind. `Promise.all` alone rejects the
  // instant one read fails while the other six are still queued on the reader
  // pool, so `getWorkflowData` returns — releasing its `BOUNDED_READ_OPS` permit
  // — with sibling work still in flight, and a retry can stack that detached
  // work past the lane ceiling. `allSettled` holds the op open until all seven
  // settle. The `Promise.all` below then sees only settled promises, so it
  // rethrows the first rejection in array order and keeps the tuple typing.
  await Promise.allSettled(reads);
  const [
    depthRow,
    durationRow,
    subagentTypes,
    edges,
    toolTransitions,
    toolCounts,
    cooccurrence,
  ] = await Promise.all(reads);
  return {
    depthRow,
    durationRow,
    subagentTypes,
    edges,
    toolTransitions,
    toolCounts,
    cooccurrence,
  };
}

/** ISS-4855: one extracted plan row — session identity plus the plan fields. */
type SqlitePlanRow = {
  session_id: string;
  cwd: string | null;
  harness: string | null;
  updated_at: string | null;
  plan_index: number | bigint;
  content: string | null;
  source: string | null;
  plan_timestamp: string | null;
};
