import type {
  DailyTokenUsage,
  DailyTrend,
  DashboardStats,
  DeliveryStats,
  ModelUsage,
  ProjectUsage,
  PublicDashboardResponse,
  PublicUsageDashboardResponse,
  RecentSession,
  UsageDashboardStats,
} from "@repo/api/src/types/dashboard";
import {
  DocumentType,
  GitHubActionStatus,
  GitHubPRState,
  Prisma,
  withDb,
} from "@repo/database";
import { log } from "@repo/observability/log";

// ── Anthropic API Pricing (USD per 1M tokens) ─────────────────────────────
// https://docs.anthropic.com/en/docs/about-claude/models#model-comparison-table
// Used to calculate API cost equivalent for subscription-based usage.

type ModelPricing = {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
};

const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-6": {
    input: 15,
    output: 75,
    cacheWrite: 18.75,
    cacheRead: 3.75,
  },
  "claude-opus-4": {
    input: 15,
    output: 75,
    cacheWrite: 18.75,
    cacheRead: 3.75,
  },
  "claude-sonnet-4-6": {
    input: 3,
    output: 15,
    cacheWrite: 3.75,
    cacheRead: 0.3,
  },
  "claude-sonnet-4-5": {
    input: 3,
    output: 15,
    cacheWrite: 3.75,
    cacheRead: 0.3,
  },
  "claude-sonnet-4": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
};

const DEFAULT_PRICING: ModelPricing = {
  input: 3,
  output: 15,
  cacheWrite: 3.75,
  cacheRead: 0.3,
};

function getModelPricing(model: string): ModelPricing {
  // Exact match first
  if (model in MODEL_PRICING) {
    return MODEL_PRICING[model];
  }
  // Prefix match: versioned model strings (e.g. "claude-sonnet-4-5-20251001")
  // contain the canonical key as a prefix
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (model.startsWith(key)) {
      return pricing;
    }
  }
  return DEFAULT_PRICING;
}

function calculateModelCost(
  model: string,
  input: number,
  output: number,
  cacheCreation: number,
  cacheRead: number
): number {
  const pricing = getModelPricing(model);
  return (
    (input / 1_000_000) * pricing.input +
    (output / 1_000_000) * pricing.output +
    (cacheCreation / 1_000_000) * pricing.cacheWrite +
    (cacheRead / 1_000_000) * pricing.cacheRead
  );
}

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
          db.document.count({
            where: { organizationId, type: DocumentType.PRD },
          })
        ),
        withDb((db) =>
          db.document.count({
            where: { organizationId, type: DocumentType.FEATURE },
          })
        ),
        withDb((db) =>
          db.document.count({
            where: {
              organizationId,
              type: DocumentType.IMPLEMENTATION_PLAN,
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
          db.document.findMany({
            where: {
              organizationId,
              type: DocumentType.PRD,
              createdAt: { gte: fourteenDaysAgo },
            },
            select: { createdAt: true },
          })
        ),
        withDb((db) =>
          db.document.findMany({
            where: {
              organizationId,
              type: DocumentType.FEATURE,
              createdAt: { gte: fourteenDaysAgo },
            },
            select: { createdAt: true },
          })
        ),
        withDb((db) =>
          db.document.findMany({
            where: {
              organizationId,
              type: DocumentType.IMPLEMENTATION_PLAN,
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
      model_input: bigint;
      model_output: bigint;
      model_cache_creation: bigint;
      model_cache_read: bigint;
      total_tokens: bigint;
    };

    type OriginRow = {
      is_electron: boolean;
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
      originResult,
      [prdCount, planCount, featureCount, prsMerged, agenticWorkflows],
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

      // Token usage by model (with per-type breakdown for cost calculation)
      withDb((db) =>
        db.$queryRaw<ModelRow[]>(Prisma.sql`
            SELECT
              e.key AS model,
              COALESCE(SUM(CASE WHEN jsonb_typeof(e.value -> 'input') = 'number' THEN (e.value ->> 'input')::numeric::bigint ELSE 0 END), 0) AS model_input,
              COALESCE(SUM(CASE WHEN jsonb_typeof(e.value -> 'output') = 'number' THEN (e.value ->> 'output')::numeric::bigint ELSE 0 END), 0) AS model_output,
              COALESCE(SUM(CASE WHEN jsonb_typeof(e.value -> 'cacheCreation') = 'number' THEN (e.value ->> 'cacheCreation')::numeric::bigint ELSE 0 END), 0) AS model_cache_creation,
              COALESCE(SUM(CASE WHEN jsonb_typeof(e.value -> 'cacheRead') = 'number' THEN (e.value ->> 'cacheRead')::numeric::bigint ELSE 0 END), 0) AS model_cache_read,
              COALESCE(SUM(
                COALESCE(CASE WHEN jsonb_typeof(e.value -> 'input') = 'number' THEN (e.value ->> 'input')::numeric::bigint ELSE 0 END, 0) +
                COALESCE(CASE WHEN jsonb_typeof(e.value -> 'output') = 'number' THEN (e.value ->> 'output')::numeric::bigint ELSE 0 END, 0) +
                COALESCE(CASE WHEN jsonb_typeof(e.value -> 'cacheCreation') = 'number' THEN (e.value ->> 'cacheCreation')::numeric::bigint ELSE 0 END, 0) +
                COALESCE(CASE WHEN jsonb_typeof(e.value -> 'cacheRead') = 'number' THEN (e.value ->> 'cacheRead')::numeric::bigint ELSE 0 END, 0)
              ), 0) AS total_tokens
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

      // Subscription vs API token split (includes cache tokens for consistency with total)
      withDb((db) =>
        db.$queryRaw<OriginRow[]>(Prisma.sql`
            SELECT
              (compute_target_id IS NOT NULL) AS is_electron,
              COALESCE(SUM(tokens_input), 0) + COALESCE(SUM(tokens_output), 0) +
              COALESCE(SUM(
                CASE WHEN jsonb_typeof(tokens_by_model) = 'object' THEN (
                  SELECT COALESCE(SUM(
                    COALESCE(CASE WHEN jsonb_typeof(e.value -> 'cacheCreation') = 'number' THEN (e.value ->> 'cacheCreation')::numeric::bigint ELSE 0 END, 0) +
                    COALESCE(CASE WHEN jsonb_typeof(e.value -> 'cacheRead') = 'number' THEN (e.value ->> 'cacheRead')::numeric::bigint ELSE 0 END, 0)
                  ), 0) FROM jsonb_each(tokens_by_model) AS e(key, value)
                ) ELSE 0 END
              ), 0) AS total_tokens
            FROM loops
            WHERE ${whereClause}
            GROUP BY is_electron
          `)
      ),

      // Delivery stats: documents, PRs, workflows
      // Pre-fetch workstream IDs once for PR and workflow counts
      withDb((db) =>
        db.workstream.findMany({
          where: { organizationId: org.id },
          select: { id: true },
        })
      ).then((ws) => {
        const wsIds = ws.map((w) => w.id);
        return Promise.all([
          withDb((db) =>
            db.document.count({
              where: {
                organizationId: org.id,
                type: DocumentType.PRD,
                ...(startDate ? { createdAt: { gte: startDate } } : {}),
              },
            })
          ),
          withDb((db) =>
            db.document.count({
              where: {
                organizationId: org.id,
                type: DocumentType.IMPLEMENTATION_PLAN,
                ...(startDate ? { createdAt: { gte: startDate } } : {}),
              },
            })
          ),
          withDb((db) =>
            db.document.count({
              where: {
                organizationId: org.id,
                type: DocumentType.FEATURE,
                ...(startDate ? { createdAt: { gte: startDate } } : {}),
              },
            })
          ),
          withDb((db) =>
            db.gitHubPullRequest.count({
              where: {
                workstreamId: { in: wsIds },
                state: GitHubPRState.MERGED,
                mergedAt: {
                  not: null,
                  ...(startDate ? { gte: startDate } : {}),
                },
              },
            })
          ),
          withDb((db) =>
            db.gitHubActionRun.count({
              where: {
                workstreamId: { in: wsIds },
                status: { not: GitHubActionStatus.PENDING },
                ...(startDate ? { createdAt: { gte: startDate } } : {}),
              },
            })
          ),
        ]);
      }),
    ]);

    const agg = aggResult[0];

    // Calculate API cost equivalent from per-model token breakdown
    const byModel: ModelUsage[] = modelResult.map((r: ModelRow) => {
      const mInput = Number(r.model_input);
      const mOutput = Number(r.model_output);
      const mCacheCreation = Number(r.model_cache_creation);
      const mCacheRead = Number(r.model_cache_read);
      return {
        model: r.model,
        totalTokens: Number(r.total_tokens),
        apiCost: calculateModelCost(
          r.model,
          mInput,
          mOutput,
          mCacheCreation,
          mCacheRead
        ),
      };
    });

    const apiCostEquivalent = byModel.reduce((sum, m) => sum + m.apiCost, 0);

    // Subscription (electron) vs API (cloud) token split
    let subscriptionTokens = 0;
    let apiTokens = 0;
    for (const row of originResult) {
      const tokens = Number(row.total_tokens);
      if (row.is_electron) {
        subscriptionTokens = tokens;
      } else {
        apiTokens = tokens;
      }
    }

    const stats: UsageDashboardStats = {
      sessions: Number(agg?.distinct_sessions ?? 0),
      turns: Number(agg?.total_loops ?? 0),
      inputTokens: Number(agg?.total_input ?? 0),
      outputTokens: Number(agg?.total_output ?? 0),
      cacheRead: Number(agg?.total_cache_read ?? 0),
      cacheCreation: Number(agg?.total_cache_creation ?? 0),
      apiCostEquivalent,
      estimatedCost: apiCostEquivalent,
      subscriptionTokens,
      apiTokens,
    };

    const delivery: DeliveryStats = {
      prdsCreated: prdCount,
      plansCreated: planCount,
      featuresCreated: featureCount,
      prsMerged,
      agenticWorkflows,
    };

    const dailyUsage: DailyTokenUsage[] = dailyResult.map((r: DailyRow) => ({
      date: r.day,
      input: Number(r.input),
      output: Number(r.output),
      cacheRead: Number(r.cache_read),
      cacheCreation: Number(r.cache_creation),
    }));

    const topProjects: ProjectUsage[] = projectResult.map((r: ProjectRow) => ({
      project: r.project,
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
    }));

    const recentSessions: RecentSession[] = sessionResult.map(
      (r: SessionRow) => {
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
      }
    );

    return {
      organizationName: org.name,
      updatedAt: new Date().toISOString(),
      models: allModels.map((m: { model: string }) => m.model),
      stats,
      delivery,
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
