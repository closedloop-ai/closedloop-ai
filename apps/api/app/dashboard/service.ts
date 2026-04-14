import type {
  DailyTokenUsage,
  DailyTrend,
  DashboardStats,
  ModelUsage,
  ProjectUsage,
  PublicDashboardResponse,
  PublicUsageDashboardResponse,
  RecentSession,
  UsageDashboardStats,
} from "@repo/api/src/types/dashboard";
import {
  ArtifactType,
  GitHubActionStatus,
  GitHubPRState,
  Prisma,
  withDb,
} from "@repo/database";
import { log } from "@repo/observability/log";

/**
 * Dashboard service - handles database operations for dashboard statistics
 */
export const dashboardService = {
  /**
   * Get dashboard statistics for an organization including counts and 14-day trends.
   * Returns metrics for PRDs, features, implementation plans, landed code, and agentic workflows.
   */
  async getDashboardStats(organizationId: string): Promise<DashboardStats> {
    try {
      // Calculate date 14 days ago for trend queries
      const fourteenDaysAgo = new Date();
      fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

      // Pre-fetch workstream IDs for org (GitHubPullRequest/GitHubActionRun
      // don't have a direct workstream relation, so we filter by ID list)
      const orgWorkstreamIds = await withDb((db) =>
        db.workstream.findMany({
          where: { organizationId },
          select: { id: true },
        })
      ).then((ws) => ws.map((w) => w.id));

      // Execute all queries in parallel for performance
      const [
        prdsCount,
        featuresCount,
        plansCount,
        landedCodeCount,
        agenticWorkflowsCount,
        prdsTrendData,
        featuresTrendData,
        plansTrendData,
        landedCodeTrendData,
        agenticWorkflowsTrendData,
      ] = await Promise.all([
        // Aggregate counts
        withDb((db) =>
          db.artifact.count({
            where: { organizationId, type: ArtifactType.PRD },
          })
        ),
        // Features are a separate entity (Feature table)
        withDb((db) =>
          db.feature.count({
            where: { organizationId },
          })
        ),
        withDb((db) =>
          db.artifact.count({
            where: {
              organizationId,
              type: ArtifactType.IMPLEMENTATION_PLAN,
            },
          })
        ),
        // Landed code: merged PRs with defensive null check on mergedAt
        withDb((db) =>
          db.gitHubPullRequest.count({
            where: {
              workstreamId: { in: orgWorkstreamIds },
              state: GitHubPRState.MERGED,
              mergedAt: { not: null },
            },
          })
        ),
        // Agentic workflows: exclude PENDING since those haven't started yet
        withDb((db) =>
          db.gitHubActionRun.count({
            where: {
              workstreamId: { in: orgWorkstreamIds },
              status: { not: GitHubActionStatus.PENDING },
            },
          })
        ),

        // 14-day trend data
        withDb((db) =>
          db.artifact.findMany({
            where: {
              organizationId,
              type: ArtifactType.PRD,
              createdAt: { gte: fourteenDaysAgo },
            },
            select: { createdAt: true },
          })
        ),
        // Features trend from separate Feature table
        withDb((db) =>
          db.feature.findMany({
            where: {
              organizationId,
              createdAt: { gte: fourteenDaysAgo },
            },
            select: { createdAt: true },
          })
        ),
        withDb((db) =>
          db.artifact.findMany({
            where: {
              organizationId,
              type: ArtifactType.IMPLEMENTATION_PLAN,
              createdAt: { gte: fourteenDaysAgo },
            },
            select: { createdAt: true },
          })
        ),
        // For GitHubPullRequest trends use mergedAt field instead of createdAt
        withDb((db) =>
          db.gitHubPullRequest.findMany({
            where: {
              workstreamId: { in: orgWorkstreamIds },
              state: GitHubPRState.MERGED,
              mergedAt: { gte: fourteenDaysAgo, not: null },
            },
            select: { mergedAt: true },
          })
        ),
        withDb((db) =>
          db.gitHubActionRun.findMany({
            where: {
              workstreamId: { in: orgWorkstreamIds },
              status: { not: GitHubActionStatus.PENDING },
              createdAt: { gte: fourteenDaysAgo },
            },
            select: { createdAt: true },
          })
        ),
      ]);

      // Transform trend data into DailyTrend arrays
      const prdsTrend = aggregateTrendData(prdsTrendData, "createdAt");
      const featuresTrend = aggregateTrendData(featuresTrendData, "createdAt");
      const plansTrend = aggregateTrendData(plansTrendData, "createdAt");
      const landedCodeTrend = aggregateTrendData(
        landedCodeTrendData,
        "mergedAt"
      );
      const agenticWorkflowsTrend = aggregateTrendData(
        agenticWorkflowsTrendData,
        "createdAt"
      );

      // Return structured DashboardStats
      return {
        prds: { count: prdsCount, trend: prdsTrend },
        features: { count: featuresCount, trend: featuresTrend },
        plans: { count: plansCount, trend: plansTrend },
        landedCode: { count: landedCodeCount, trend: landedCodeTrend },
        agenticWorkflows: {
          count: agenticWorkflowsCount,
          trend: agenticWorkflowsTrend,
        },
        // Set undefined for placeholders that lack data models
        agentsCount: undefined,
        leaderboardsCount: undefined,
      };
    } catch (error) {
      log.error("[dashboard-service] Failed to get dashboard stats", {
        error: error instanceof Error ? error.message : String(error),
        organizationId,
      });
      throw error;
    }
  },

  /**
   * Look up an organization by its public dashboard token and return stats.
   * Returns null if the token is invalid or the org is inactive.
   */
  async getPublicDashboardByToken(
    token: string
  ): Promise<PublicDashboardResponse | null> {
    const org = await withDb((db) =>
      db.organization.findUnique({
        where: { publicDashboardToken: token },
        select: { id: true, name: true, active: true },
      })
    );

    if (!org?.active) {
      return null;
    }

    const stats = await dashboardService.getDashboardStats(org.id);
    return { organizationName: org.name, stats };
  },

  /**
   * Get Claude Code usage dashboard data for public display.
   * Aggregates Loop data: sessions, tokens, costs, daily breakdown, model/project breakdowns.
   */
  async getPublicUsageDashboard(
    token: string,
    filters: { rangeDays?: number; models?: string[] }
  ): Promise<PublicUsageDashboardResponse | null> {
    const org = await withDb((db) =>
      db.organization.findUnique({
        where: { publicDashboardToken: token },
        select: { id: true, name: true, active: true },
      })
    );

    if (!org?.active) {
      return null;
    }

    const { rangeDays, models } = filters;
    const startDate =
      rangeDays !== undefined && rangeDays > 0
        ? new Date(Date.now() - rangeDays * 86_400_000)
        : undefined;

    // Build raw SQL predicates for cache/model/project aggregation
    const basePreds: Prisma.Sql[] = [
      Prisma.sql`organization_id = ${org.id}::uuid`,
    ];
    if (startDate) {
      basePreds.push(Prisma.sql`created_at >= ${startDate}`);
    }
    // baseWhereClause: org + date only (used for allModels enumeration)
    const baseWhereClause = Prisma.join([...basePreds], " AND ");
    // Model filter: restrict to loops whose tokens_by_model JSON contains at least one matching key
    const rawPreds = [...basePreds];
    if (models && models.length > 0) {
      const modelPreds = models.map((m) => Prisma.sql`tokens_by_model ? ${m}`);
      rawPreds.push(Prisma.sql`(${Prisma.join(modelPreds, " OR ")})`);
    }
    const whereClause = Prisma.join(rawPreds, " AND ");

    type AggRow = {
      distinct_sessions: bigint;
      total_loops: bigint;
      total_input: bigint;
      total_output: bigint;
      total_cost: string | null;
      total_cache_creation: bigint;
      total_cache_read: bigint;
    };

    type DailyRow = {
      day: string;
      input: bigint;
      output: bigint;
      cache_read: bigint;
      cache_creation: bigint;
    };

    type ModelRow = {
      model: string;
      total_tokens: bigint;
    };

    type ProjectRow = {
      project: string;
      input_tokens: bigint;
      output_tokens: bigint;
    };

    type SessionRow = {
      session_id: string;
      project: string;
      last_active: Date;
      started_at: Date | null;
      primary_model: string;
      turns: bigint;
      input_tokens: bigint;
      output_tokens: bigint;
      total_cost: string | null;
    };

    const [
      aggResult,
      dailyResult,
      modelResult,
      projectResult,
      sessionResult,
      allModels,
    ] = await Promise.all([
      // Aggregate stats
      withDb((db) =>
        db.$queryRaw<AggRow[]>(Prisma.sql`
            SELECT
              COUNT(DISTINCT session_id) AS distinct_sessions,
              COUNT(*) AS total_loops,
              COALESCE(SUM(tokens_input), 0) AS total_input,
              COALESCE(SUM(tokens_output), 0) AS total_output,
              SUM(estimated_cost) AS total_cost,
              COALESCE(SUM(
                CASE WHEN jsonb_typeof(tokens_by_model) = 'object' THEN (
                  SELECT COALESCE(SUM(CASE
                    WHEN jsonb_typeof(e.value -> 'cacheCreation') = 'number' THEN (e.value ->> 'cacheCreation')::numeric::bigint
                    ELSE 0 END), 0)
                  FROM jsonb_each(tokens_by_model) AS e(key, value)
                ) ELSE 0 END
              ), 0) AS total_cache_creation,
              COALESCE(SUM(
                CASE WHEN jsonb_typeof(tokens_by_model) = 'object' THEN (
                  SELECT COALESCE(SUM(CASE
                    WHEN jsonb_typeof(e.value -> 'cacheRead') = 'number' THEN (e.value ->> 'cacheRead')::numeric::bigint
                    ELSE 0 END), 0)
                  FROM jsonb_each(tokens_by_model) AS e(key, value)
                ) ELSE 0 END
              ), 0) AS total_cache_read
            FROM loops
            WHERE ${whereClause}
          `)
      ),

      // Daily token breakdown
      withDb((db) =>
        db.$queryRaw<DailyRow[]>(Prisma.sql`
            SELECT
              TO_CHAR(created_at, 'YYYY-MM-DD') AS day,
              COALESCE(SUM(tokens_input), 0) AS input,
              COALESCE(SUM(tokens_output), 0) AS output,
              COALESCE(SUM(
                CASE WHEN jsonb_typeof(tokens_by_model) = 'object' THEN (
                  SELECT COALESCE(SUM(CASE
                    WHEN jsonb_typeof(e.value -> 'cacheRead') = 'number' THEN (e.value ->> 'cacheRead')::numeric::bigint
                    ELSE 0 END), 0)
                  FROM jsonb_each(tokens_by_model) AS e(key, value)
                ) ELSE 0 END
              ), 0) AS cache_read,
              COALESCE(SUM(
                CASE WHEN jsonb_typeof(tokens_by_model) = 'object' THEN (
                  SELECT COALESCE(SUM(CASE
                    WHEN jsonb_typeof(e.value -> 'cacheCreation') = 'number' THEN (e.value ->> 'cacheCreation')::numeric::bigint
                    ELSE 0 END), 0)
                  FROM jsonb_each(tokens_by_model) AS e(key, value)
                ) ELSE 0 END
              ), 0) AS cache_creation
            FROM loops
            WHERE ${whereClause}
            GROUP BY day
            ORDER BY day
          `)
      ),

      // Token usage by model
      withDb((db) =>
        db.$queryRaw<ModelRow[]>(Prisma.sql`
            SELECT
              e.key AS model,
              SUM(
                COALESCE(CASE WHEN jsonb_typeof(e.value -> 'input') = 'number' THEN (e.value ->> 'input')::numeric::bigint ELSE 0 END, 0) +
                COALESCE(CASE WHEN jsonb_typeof(e.value -> 'output') = 'number' THEN (e.value ->> 'output')::numeric::bigint ELSE 0 END, 0) +
                COALESCE(CASE WHEN jsonb_typeof(e.value -> 'cacheCreation') = 'number' THEN (e.value ->> 'cacheCreation')::numeric::bigint ELSE 0 END, 0) +
                COALESCE(CASE WHEN jsonb_typeof(e.value -> 'cacheRead') = 'number' THEN (e.value ->> 'cacheRead')::numeric::bigint ELSE 0 END, 0)
              ) AS total_tokens
            FROM loops,
            LATERAL jsonb_each(tokens_by_model) AS e(key, value)
            WHERE ${whereClause}
              AND jsonb_typeof(tokens_by_model) = 'object'
            GROUP BY e.key
            ORDER BY total_tokens DESC
          `)
      ),

      // Top projects by tokens (from repo JSON field)
      withDb((db) =>
        db.$queryRaw<ProjectRow[]>(Prisma.sql`
            SELECT
              COALESCE(repo ->> 'fullName', 'Unknown') AS project,
              COALESCE(SUM(tokens_input), 0) AS input_tokens,
              COALESCE(SUM(tokens_output), 0) AS output_tokens
            FROM loops
            WHERE ${whereClause}
              AND repo IS NOT NULL
            GROUP BY project
            ORDER BY (COALESCE(SUM(tokens_input), 0) + COALESCE(SUM(tokens_output), 0)) DESC
            LIMIT 10
          `)
      ),

      // Recent sessions
      withDb((db) =>
        db.$queryRaw<SessionRow[]>(Prisma.sql`
            SELECT
              session_id,
              COALESCE((SELECT r.repo ->> 'fullName' FROM loops r WHERE r.session_id = l.session_id AND r.repo IS NOT NULL LIMIT 1), 'Unknown') AS project,
              MAX(COALESCE(completed_at, created_at)) AS last_active,
              MIN(started_at) AS started_at,
              COALESCE((
                SELECT e.key FROM loops sub, LATERAL jsonb_each(sub.tokens_by_model) AS e(key, value)
                WHERE sub.session_id = l.session_id AND jsonb_typeof(sub.tokens_by_model) = 'object'
                ORDER BY COALESCE((e.value ->> 'input')::numeric::bigint, 0) + COALESCE((e.value ->> 'output')::numeric::bigint, 0) DESC
                LIMIT 1
              ), 'unknown') AS primary_model,
              COUNT(*) AS turns,
              COALESCE(SUM(tokens_input), 0) AS input_tokens,
              COALESCE(SUM(tokens_output), 0) AS output_tokens,
              SUM(estimated_cost) AS total_cost
            FROM loops l
            WHERE ${whereClause}
              AND session_id IS NOT NULL
            GROUP BY session_id
            ORDER BY last_active DESC
            LIMIT 20
          `)
      ),

      // All distinct model names for filter controls (date-scoped, no model filter)
      withDb((db) =>
        db.$queryRaw<{ model: string }[]>(Prisma.sql`
            SELECT DISTINCT e.key AS model
            FROM loops,
            LATERAL jsonb_each(tokens_by_model) AS e(key, value)
            WHERE ${baseWhereClause}
              AND jsonb_typeof(tokens_by_model) = 'object'
            ORDER BY e.key
          `)
      ),
    ]);

    const agg = aggResult[0];

    const stats: UsageDashboardStats = {
      sessions: Number(agg?.distinct_sessions ?? 0),
      turns: Number(agg?.total_loops ?? 0),
      inputTokens: Number(agg?.total_input ?? 0),
      outputTokens: Number(agg?.total_output ?? 0),
      cacheRead: Number(agg?.total_cache_read ?? 0),
      cacheCreation: Number(agg?.total_cache_creation ?? 0),
      estimatedCost: Number(agg?.total_cost ?? 0),
    };

    const dailyUsage: DailyTokenUsage[] = dailyResult.map((r) => ({
      date: r.day,
      input: Number(r.input),
      output: Number(r.output),
      cacheRead: Number(r.cache_read),
      cacheCreation: Number(r.cache_creation),
    }));

    const byModel: ModelUsage[] = modelResult.map((r) => ({
      model: r.model,
      totalTokens: Number(r.total_tokens),
    }));

    const topProjects: ProjectUsage[] = projectResult.map((r) => ({
      project: r.project,
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
    }));

    const recentSessions: RecentSession[] = sessionResult.map((r) => {
      const lastActive = new Date(r.last_active);
      const startedAt = r.started_at ? new Date(r.started_at) : lastActive;
      const durationMs = lastActive.getTime() - startedAt.getTime();
      return {
        sessionId: r.session_id,
        project: r.project,
        lastActive: lastActive.toISOString(),
        durationMinutes: Math.round((durationMs / 60_000) * 10) / 10,
        model: r.primary_model,
        turns: Number(r.turns),
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        estimatedCost: Number(r.total_cost ?? 0),
      };
    });

    return {
      organizationName: org.name,
      updatedAt: new Date().toISOString(),
      models: allModels.map((m) => m.model),
      stats,
      dailyUsage,
      byModel,
      topProjects,
      recentSessions,
    };
  },
};

/** Format a Date as YYYY-MM-DD using UTC date parts (matches Prisma's UTC timestamps). */
function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Aggregate trend data by date, counting occurrences per day.
 * Returns a dense 14-day array with zeros for days without activity.
 */
function aggregateTrendData<K extends DateField>(
  data: Record<K, Date | null>[],
  dateField: K
): DailyTrend[] {
  const countsByDate = new Map<string, number>();

  for (const item of data) {
    const dateValue = item[dateField];
    if (!dateValue) {
      continue;
    }

    const dateString = toDateKey(dateValue);
    const currentCount = countsByDate.get(dateString) ?? 0;
    countsByDate.set(dateString, currentCount + 1);
  }

  // Build dense 14-day array with zeros for days without activity
  const result: DailyTrend[] = [];
  const today = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = toDateKey(d);
    result.push({ date: key, count: countsByDate.get(key) ?? 0 });
  }

  return result;
}

type DateField = "createdAt" | "mergedAt";
