import {
  AGENT_FAILED_STATUS_TERMS,
  AGENT_SUCCESS_STATUS_TERMS,
} from "@repo/api/src/agent-session-status";
import type { InsightsPeriod, InsightsSection } from "@closedloop-ai/loops-api/insights";
import type {
  AnalyticsData,
  DashboardCoreFeatures,
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
import { asRecord } from "../../shared/type-guards.js";
import { parseJsonObjectText } from "../agent-session-sync-service.js";
import { TERMINAL_STATUS_SET } from "./db-constants.js";
import {
  compareIsoDesc,
  compareLastUsedThenName,
  localDay,
  maxIso,
  nonEmptyString,
  packIdFromSkillName,
  titleFromId,
  titleFromPlan,
  tokenCountValue,
} from "./db-helpers.js";
import { computeLocalInsights } from "./local-insights.js";
import type { DesktopPrisma } from "./prisma-client.js";

// Every dashboard read runs on the single `DesktopPrisma` client — typed
// delegates where there is a clean form, raw on `prisma.client.$queryRawUnsafe`
// for the aggregation/window/CTE SQL that has none. `getInsights` delegates to
// `computeLocalInsights(prisma, …)`.

// Single success-rate definition for the orchestration dashboard so the
// headline `stats.successRate` and every per-type `effectiveness[].successRate`
// agree: completed over finished (completed + errors), excluding in-flight
// agents from the denominator, defaulting to 100 when nothing has finished yet.
// Previously the per-type rate divided by the full agent count (including
// running/pending agents), so a type with in-flight work reported an
// artificially low rate that contradicted the headline.
function agentSuccessRate(completed: number, errors: number): number {
  const finished = completed + errors;
  return finished > 0 ? (completed / finished) * 100 : 100;
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
    async getTokenAnalytics(now?: Date): Promise<TokenAnalytics> {
      // FEA-2345: all three facets (totals, byModel, byDay) source from
      // token_events over one shared 30-calendar-day window. token_events is
      // @@ignore'd (no Prisma delegate) — all queries stay $queryRawUnsafe.
      // FEA-2430: the window spans 30 calendar days in the user's LOCAL
      // timezone (was UTC), matching the localtime byDay buckets below — edges
      // are local midnight / local end-of-today expressed as UTC instants, so
      // the ISO string comparison against UTC-stored created_at stays valid.
      const WINDOW_DAYS = 30;
      const ref = now ?? new Date();
      const cutoff = new Date(ref);
      cutoff.setHours(0, 0, 0, 0);
      cutoff.setDate(cutoff.getDate() - (WINDOW_DAYS - 1));
      const cutoffIso = cutoff.toISOString();
      const upper = new Date(ref);
      upper.setHours(23, 59, 59, 999);
      const upperIso = upper.toISOString();
      const ISO_GUARD =
        "created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'";
      const WINDOW_PREDICATE = `${ISO_GUARD} AND created_at >= ? AND created_at <= ?`;

      const [totals, byModel, byDay] = await Promise.all([
        prisma.client.$queryRawUnsafe<
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
        ),
        prisma.client.$queryRawUnsafe<
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
        ),
        prisma.client.$queryRawUnsafe<
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
        ),
      ]);

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
        windowDays: WINDOW_DAYS,
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
    async getAnalytics(now?: Date): Promise<AnalyticsData> {
      // FEA-2430: anchor the dailyEvents window to the caller's `now` (like
      // getTokenAnalytics already does) instead of SQLite's literal 'now', so
      // tests that pass a fixed reference date stay deterministic forever.
      const refIso = (now ?? new Date()).toISOString();
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
        this.getTokenAnalytics(now),
        // event_type is NOT NULL, so the typed groupBy's `_count._all`
        // reproduces COUNT(*); the SQL's ORDER BY count DESC is a JS sort.
        prisma.client.event.groupBy({
          by: ["eventType"],
          _count: { _all: true },
        }),
        // strftime relative-date windows have no typed-delegate form — raw.
        prisma.client.$queryRawUnsafe<{ tool_name: string; count: bigint }[]>(
          "SELECT tool_name, COUNT(*) as count FROM events WHERE created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days') AND tool_name IS NOT NULL GROUP BY tool_name ORDER BY count DESC LIMIT 20"
        ),
        // FEA-2430: bucket daily events by the user's LOCAL day (was UTC per
        // FEA-1459 Fix 6) — every display-facing day bucket converts via
        // 'localtime'; the rolling -365d window filter stays an instant,
        // anchored to the caller's `now`.
        prisma.client.$queryRawUnsafe<{ date: string; count: bigint }[]>(
          `SELECT ${localDay("created_at")} as date, COUNT(*) as count FROM events WHERE created_at > strftime('%Y-%m-%dT%H:%M:%fZ', $1, '-365 days') GROUP BY ${localDay("created_at")} ORDER BY date ASC`,
          refIso
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
    async getWorkflowData(): Promise<WorkflowQueryData> {
      const totalSessions = await prisma.client.session.count();
      const totalAgents = await prisma.client.agent.count();
      const totalSubagents = await prisma.client.agent.count({
        where: { OR: [{ type: "subagent" }, { parentAgentId: { not: null } }] },
      });
      // Classify by the shared status vocabulary (AGENT_*_STATUS_TERMS) so
      // successRate and effectiveness agree with the sessions view: statuses
      // like "success"/"complete"/"done" count as completed and "fail"/"error"
      // as errors, instead of only the exact strings "completed"/"failed".
      const completedAgents = await prisma.client.agent.count({
        where: { OR: agentStatusContainsFilter(AGENT_SUCCESS_STATUS_TERMS) },
      });
      const errorAgents = await prisma.client.agent.count({
        where: { OR: agentStatusContainsFilter(AGENT_FAILED_STATUS_TERMS) },
      });
      // Recursive depth CTE — no typed form; raw on the one client.
      const depthRows = await prisma.client.$queryRawUnsafe<
        {
          session_id: string;
          max_depth: bigint;
        }[]
      >(`
        WITH RECURSIVE agent_depth(id, session_id, depth) AS (
          SELECT id, session_id, 0 FROM agents WHERE parent_agent_id IS NULL
          UNION ALL
          SELECT a.id, a.session_id, ad.depth + 1
          FROM agents a JOIN agent_depth ad ON a.parent_agent_id = ad.id
        )
        SELECT session_id, MAX(depth) as max_depth FROM agent_depth GROUP BY session_id
      `);
      // AVG(unixepoch(...)) date arithmetic — raw on the one client.
      const durationRow = await prisma.client.$queryRawUnsafe<
        { avg: number | null }[]
      >(`
        SELECT AVG(unixepoch(COALESCE(ended_at, updated_at), 'subsec') - unixepoch(started_at, 'subsec')) as avg
        FROM sessions WHERE started_at IS NOT NULL
          AND unixepoch(COALESCE(ended_at, updated_at), 'subsec') >= unixepoch(started_at, 'subsec')
      `);
      // GROUP BY over COALESCE(subagent_type, MAX(name)) plus conditional SUMs —
      // no typed groupBy form; raw on the one client. The status predicates are
      // derived from the same shared vocabulary as the typed counts above.
      const completedStatusPredicate = agentStatusLikePredicate(
        AGENT_SUCCESS_STATUS_TERMS
      );
      const errorStatusPredicate = agentStatusLikePredicate(
        AGENT_FAILED_STATUS_TERMS
      );
      const subagentTypes = await prisma.client.$queryRawUnsafe<
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
      `);
      // parent_agent_id IS NULL AND (type IS NULL OR type != 'subagent'): the
      // explicit OR branch covers the NULL type regardless of how Prisma's `not`
      // treats nulls, so the union equals the original predicate exactly.
      const mainCount = await prisma.client.agent.count({
        where: {
          parentAgentId: null,
          OR: [{ type: null }, { type: { not: "subagent" } }],
        },
      });
      // GROUP BY over COALESCE(...) join keys — raw on the one client.
      const edges = await prisma.client.$queryRawUnsafe<
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
      `);
      const outcomes = await prisma.client.session.groupBy({
        by: ["status"],
        _count: { _all: true },
      });
      // LEAD() window over the recent-tool sequence — raw on the one client.
      const toolTransitions = await prisma.client.$queryRawUnsafe<
        {
          source: string;
          target: string;
          value: bigint;
        }[]
      >(`
        WITH recent_tools AS (
          SELECT tool_name, session_id, created_at, id
          FROM events
          WHERE tool_name IS NOT NULL
            AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')
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
      `);
      // strftime relative-date window — raw on the one client.
      const toolCounts = await prisma.client.$queryRawUnsafe<
        { tool_name: string; count: bigint }[]
      >(
        "SELECT tool_name, COUNT(*) as count FROM events WHERE created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days') AND tool_name IS NOT NULL GROUP BY tool_name ORDER BY count DESC LIMIT 20"
      );
      // COUNT(DISTINCT) self-join over the per-session agent-type set — raw on
      // the one client.
      const cooccurrence = await prisma.client.$queryRawUnsafe<
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
      `);
      const avgDepth =
        depthRows.length > 0
          ? depthRows.reduce(
              (sum, row) => sum + Number(row.max_depth ?? 0),
              0
            ) / depthRows.length
          : 0;
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
      const [packs, skills, tools, subagents, plans, pullRequests] =
        await Promise.all([
          this.getPacks(),
          this.getSkills(),
          this.getTools(),
          this.getSubAgents(),
          this.getPlans(),
          this.getPullRequests(),
        ]);
      return { packs, skills, tools, subagents, plans, pullRequests };
    },
    async getPacks(): Promise<DashboardPackSummary[]> {
      const skills = await this.getSkills();
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
    },
    async getSkills(): Promise<DashboardSkillSummary[]> {
      // The Event model has NO Prisma relation to Session (events can predate
      // their session row), so the LEFT JOIN for the per-event harness is a
      // second keyed read folded into a map — a session absent from the lookup
      // yields a null harness, exactly like the outer join's NULL.
      const rows = await prisma.client.event.findMany({
        where: { toolName: "Skill" },
        select: {
          data: true,
          summary: true,
          createdAt: true,
          sessionId: true,
        },
        orderBy: { createdAt: "desc" },
      });
      const sessionIds = [...new Set(rows.map((row) => row.sessionId))];
      const sessionHarnesses =
        sessionIds.length > 0
          ? await prisma.client.session.findMany({
              where: { id: { in: sessionIds } },
              select: { id: true, harness: true },
            })
          : [];
      const harnessBySessionId = new Map(
        sessionHarnesses.map((s) => [s.id, s.harness])
      );
      const grouped = new Map<string, DashboardSkillSummary>();
      for (const row of rows) {
        const data = parseJsonObjectText(row.data);
        const name =
          nonEmptyString(data?.skillName) ??
          nonEmptyString(data?.skill) ??
          nonEmptyString(data?.name) ??
          nonEmptyString(row.summary);
        if (!name) {
          continue;
        }
        const harness =
          nonEmptyString(harnessBySessionId.get(row.sessionId) ?? null) ??
          "unknown";
        const packId = packIdFromSkillName(name);
        const id = `${harness}:${packId ?? "standalone"}:${name}`;
        const existing = grouped.get(id);
        if (existing) {
          existing.invocationCount++;
          existing.lastUsedAt = maxIso(
            existing.lastUsedAt,
            row.createdAt ?? null
          );
          continue;
        }
        grouped.set(id, {
          id,
          packId,
          name,
          harness,
          description: nonEmptyString(data?.description) ?? null,
          installPath:
            nonEmptyString(data?.installPath) ??
            nonEmptyString(data?.path) ??
            null,
          invocationCount: 1,
          lastUsedAt: row.createdAt ?? null,
        });
      }
      return [...grouped.values()].sort(compareLastUsedThenName);
    },
    async getTools(): Promise<DashboardToolSummary[]> {
      // COUNT(DISTINCT session_id) + MAX(created_at) per tool — no typed groupBy
      // form (Prisma _count is row count, not distinct); raw on the one client.
      const result = await prisma.client.$queryRawUnsafe<
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
        WHERE tool_name IS NOT NULL
        GROUP BY tool_name
        ORDER BY invocation_count DESC, tool_name ASC
      `);
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
      const result = await prisma.client.$queryRawUnsafe<
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
      `);
      return result.map((row) => ({
        subagentType: row.subagent_type,
        total: Number(row.total ?? 0),
        completed: Number(row.completed ?? 0),
        errors: Number(row.errors ?? 0),
        sessions: Number(row.sessions ?? 0),
        lastUsedAt: row.last_used_at ?? null,
      }));
    },
    async getPlans(): Promise<DashboardPlanSummary[]> {
      const result = await prisma.client.session.findMany({
        where: { metadata: { not: null } },
        select: {
          id: true,
          cwd: true,
          harness: true,
          metadata: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: "desc" },
      });
      const plans: DashboardPlanSummary[] = [];
      const seen = new Set<string>();
      for (const session of result) {
        const metadata = parseJsonObjectText(session.metadata);
        const rawPlans = Array.isArray(metadata?.plans) ? metadata.plans : [];
        for (const [index, rawPlan] of rawPlans.entries()) {
          const plan = asRecord(rawPlan);
          const content = nonEmptyString(plan?.content);
          if (!content) {
            continue;
          }
          const timestamp =
            nonEmptyString(plan?.timestamp) ?? session.updatedAt ?? null;
          const id = `${session.id}:plan:${index}`;
          if (seen.has(id)) {
            continue;
          }
          seen.add(id);
          plans.push({
            id,
            sessionId: session.id,
            title: titleFromPlan(content),
            source: nonEmptyString(plan?.source) ?? null,
            content,
            timestamp,
            harness: session.harness,
            cwd: session.cwd,
          });
        }
      }
      return plans.sort((a, b) => compareIsoDesc(a.timestamp, b.timestamp));
    },
    async getPullRequests(): Promise<DashboardPullRequestSummary[]> {
      // FEA-1899: PRs now live as kind='pull_request' rows in the canonical
      // artifacts table, joined to the sessions that captured them via the pure
      // session_artifact_links join. One row per PR artifact: when a PR links to
      // multiple sessions, DISTINCT ON keeps the strongest link (created >
      // primary > any) so the dashboard never double-counts a PR.
      // ROW_NUMBER() one-row-per-PR window + LEFT JOIN to pull_requests — no
      // typed-delegate form; raw on the one client. pr_number is INTEGER and the
      // raw path can surface it as BigInt, so it is Number()-coerced below.
      const result = await prisma.client.$queryRawUnsafe<
        {
          artifact_id: string;
          session_id: string | null;
          session_name: string | null;
          pr_url: string | null;
          pr_number: bigint | null;
          repo_full_name: string | null;
          branch_name: string | null;
          head_sha: string | null;
          title: string | null;
          harness: string | null;
          observed_at: string | null;
        }[]
      >(`
        SELECT
          ranked.artifact_id    AS artifact_id,
          ranked.session_id     AS session_id,
          ranked.session_name   AS session_name,
          ranked.pr_url         AS pr_url,
          ranked.pr_number      AS pr_number,
          ranked.repo_full_name AS repo_full_name,
          -- Branch is sourced from the AUTHORITATIVE pull_requests row of the
          -- winning link's session: the head ref for a PR that session created,
          -- or null for a merely-referenced PR. That column is import-authoritative
          -- and is deleted+re-derived per session on a DATA_REVISION rebuild, so it
          -- self-corrects on upgrade. The COALESCE-accumulated artifacts.branch_name
          -- can retain a stale pre-fix value a re-derive won't clear, so it is used
          -- ONLY as a fallback when no import row exists (e.g. a PR discovered purely
          -- by branch enrichment, which writes the real head to the artifact alone).
          CASE
            WHEN pr.session_id IS NOT NULL THEN pr.branch_name
            ELSE ranked.artifact_branch_name
          END                   AS branch_name,
          ranked.head_sha       AS head_sha,
          ranked.title          AS title,
          ranked.harness        AS harness,
          ranked.observed_at    AS observed_at
        FROM (
          SELECT
            a.id              AS artifact_id,
            sal.session_id    AS session_id,
            s.name            AS session_name,
            a.url             AS pr_url,
            a.pr_number       AS pr_number,
            a.repo_full_name  AS repo_full_name,
            a.branch_name     AS artifact_branch_name,
            a.head_sha        AS head_sha,
            a.title           AS title,
            a.harness         AS harness,
            a.observed_at     AS observed_at,
            ROW_NUMBER() OVER (
              PARTITION BY a.id
              ORDER BY
                CASE WHEN sal.relation = 'created' THEN 0 ELSE 1 END,
                CASE WHEN sal.is_primary THEN 0 ELSE 1 END,
                sal.created_at ASC
            ) AS rn
          FROM artifacts a
          JOIN session_artifact_links sal ON sal.artifact_id = a.id
          JOIN sessions s ON s.id = sal.session_id
          WHERE a.kind = 'pull_request'
            AND a.pr_number IS NOT NULL
            AND a.repo_full_name IS NOT NULL
        ) ranked
        LEFT JOIN pull_requests pr
          ON pr.session_id = ranked.session_id
          AND pr.repo_full_name = ranked.repo_full_name
          AND pr.pr_number = ranked.pr_number
        WHERE ranked.rn = 1
      `);
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
      return pullRequests.sort((a, b) =>
        compareIsoDesc(a.observedAt, b.observedAt)
      );
    },
  };
}
