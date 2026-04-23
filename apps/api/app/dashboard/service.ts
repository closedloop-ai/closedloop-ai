import type {
  AgentUsage,
  DailyTrend,
  DashboardStats,
  DeliveryStats,
  ModelUsage,
  ProjectUsage,
  PublicDashboardResponse,
  PublicUsageDashboardResponse,
  RecentSession,
  TimeInterval,
  TimeSeriesBucket,
  UsageDashboardStats,
} from "@repo/api/src/types/dashboard";
import type { PerfSummary } from "@repo/api/src/types/performance";
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
  // "default" model key used by Claude Code when no explicit model is specified
  default: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
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

// ── Query Helpers ──────────────────────────────────────────────────────────

function buildWherePredicates(
  orgId: string,
  startDate: Date | undefined,
  models: string[] | undefined
): {
  baseWhereClause: Prisma.Sql;
  whereClause: Prisma.Sql;
  /** Same as whereClause but with `l.` prefix for JOIN queries */
  joinWhereClause: Prisma.Sql;
} {
  const basePreds: Prisma.Sql[] = [
    Prisma.sql`organization_id = ${orgId}::uuid`,
  ];
  const joinBasePreds: Prisma.Sql[] = [
    Prisma.sql`l.organization_id = ${orgId}::uuid`,
  ];
  if (startDate) {
    basePreds.push(Prisma.sql`created_at >= ${startDate}`);
    joinBasePreds.push(Prisma.sql`l.created_at >= ${startDate}`);
  }
  const baseWhereClause = Prisma.join([...basePreds], " AND ");
  const rawPreds = [...basePreds];
  const joinPreds = [...joinBasePreds];
  if (models && models.length > 0) {
    const modelPreds = models.map((m) => Prisma.sql`tokens_by_model ? ${m}`);
    const joinModelPreds = models.map(
      (m) => Prisma.sql`l.tokens_by_model ? ${m}`
    );
    rawPreds.push(Prisma.sql`(${Prisma.join(modelPreds, " OR ")})`);
    joinPreds.push(Prisma.sql`(${Prisma.join(joinModelPreds, " OR ")})`);
  }
  const whereClause = Prisma.join(rawPreds, " AND ");
  const joinWhereClause = Prisma.join(joinPreds, " AND ");
  return { baseWhereClause, whereClause, joinWhereClause };
}

async function fetchDeliveryStats(
  orgId: string,
  startDate: Date | undefined
): Promise<DeliveryStats> {
  const dateFilter = startDate ? { createdAt: { gte: startDate } } : {};
  const ws = await withDb((db) =>
    db.workstream.findMany({
      where: { organizationId: orgId },
      select: { id: true },
    })
  );
  const wsIds = ws.map((w) => w.id);

  const [prdCount, planCount, featureCount, prsMerged, agenticWorkflows] =
    await Promise.all([
      withDb((db) =>
        db.document.count({
          where: {
            organizationId: orgId,
            type: DocumentType.PRD,
            ...dateFilter,
          },
        })
      ),
      withDb((db) =>
        db.document.count({
          where: {
            organizationId: orgId,
            type: DocumentType.IMPLEMENTATION_PLAN,
            ...dateFilter,
          },
        })
      ),
      withDb((db) =>
        db.document.count({
          where: {
            organizationId: orgId,
            type: DocumentType.FEATURE,
            ...dateFilter,
          },
        })
      ),
      withDb((db) =>
        db.gitHubPullRequest.count({
          where: {
            workstreamId: { in: wsIds },
            state: GitHubPRState.MERGED,
            mergedAt: { not: null, ...(startDate ? { gte: startDate } : {}) },
          },
        })
      ),
      withDb((db) =>
        db.$queryRaw<[{ count: bigint }]>(Prisma.sql`
          SELECT COUNT(DISTINCT workstream_id) AS count
          FROM loops
          WHERE organization_id = ${orgId}::uuid
            AND workstream_id IS NOT NULL
            ${startDate ? Prisma.sql`AND created_at >= ${startDate}` : Prisma.empty}
        `)
      ).then((r) => Number(r[0]?.count ?? 0)),
    ]);

  return {
    prdsCreated: prdCount,
    plansCreated: planCount,
    featuresCreated: featureCount,
    prsMerged,
    agenticWorkflows,
  };
}

async function fetchAgentUsage(
  orgId: string,
  startDate: Date | undefined
): Promise<AgentUsage[]> {
  const perfRecords = await withDb((db) =>
    db.gitHubActionRunPerformance.findMany({
      where: {
        document: {
          organizationId: orgId,
          ...(startDate ? { createdAt: { gte: startDate } } : {}),
        },
      },
      select: { summaryData: true },
    })
  );

  const agentMap = new Map<string, AgentUsage>();
  for (const record of perfRecords) {
    const summary = record.summaryData as unknown as PerfSummary | null;
    if (!summary?.agentBreakdown) {
      continue;
    }
    for (const agent of summary.agentBreakdown) {
      const key = `${agent.agentName}:${agent.agentType}`;
      const existing = agentMap.get(key);
      if (existing) {
        existing.totalCalls += agent.callCount;
        existing.totalDurationS += agent.totalDurationS;
      } else {
        agentMap.set(key, {
          agentName: agent.agentName,
          agentType: agent.agentType,
          totalCalls: agent.callCount,
          totalDurationS: agent.totalDurationS,
        });
      }
    }
  }

  return Array.from(agentMap.values()).sort(
    (a, b) => b.totalCalls - a.totalCalls
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
    filters: { rangeDays?: number; models?: string[]; interval?: TimeInterval }
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

    const { rangeDays, models, interval = "1d" } = filters;
    const startDate =
      rangeDays !== undefined && rangeDays > 0
        ? new Date(Date.now() - rangeDays * 86_400_000)
        : undefined;

    // Time bucket format for GROUP BY depending on interval
    const bucketFormatMap: Record<TimeInterval, string> = {
      "15min": "YYYY-MM-DD HH24:MI",
      "1h": "YYYY-MM-DD HH24:00",
      "1d": "YYYY-MM-DD",
    };
    const bucketFormat = bucketFormatMap[interval];
    // For 15-min buckets, truncate to 15-min boundary
    const bucketExpr =
      interval === "15min"
        ? Prisma.sql`TO_CHAR(date_trunc('hour', created_at) + INTERVAL '15 min' * FLOOR(EXTRACT(MINUTE FROM created_at) / 15), ${bucketFormat})`
        : Prisma.sql`TO_CHAR(created_at, ${bucketFormat})`;

    // Days in range for avg calculations
    const daysInRange = rangeDays && rangeDays > 0 ? rangeDays : 365;

    const { baseWhereClause, whereClause, joinWhereClause } =
      buildWherePredicates(org.id, startDate, models);

    type AggRow = {
      active_users: bigint;
      sessions: bigint;
      active_nodes: bigint;
      total_loops: bigint;
      total_input: bigint;
      total_output: bigint;
      total_cache_creation: bigint;
      total_cache_read: bigint;
      avg_runtime_minutes: string | null;
    };

    type TimeSeriesRow = {
      bucket: string;
      input: bigint;
      output: bigint;
      cache_read: bigint;
      cache_creation: bigint;
      active_users: bigint;
      loops: bigint;
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
      delivery,
      agentUsage,
    ] = await Promise.all([
      // Aggregate stats (all loops including failed — no status filter)
      withDb((db) =>
        db.$queryRaw<AggRow[]>(Prisma.sql`
            SELECT
              COUNT(DISTINCT user_id) AS active_users,
              COUNT(DISTINCT session_id) AS sessions,
              COUNT(DISTINCT compute_target_id) AS active_nodes,
              COUNT(*) AS total_loops,
              COALESCE(SUM(tokens_input), 0) AS total_input,
              COALESCE(SUM(tokens_output), 0) AS total_output,
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
              ), 0) AS total_cache_read,
              EXTRACT(EPOCH FROM AVG(completed_at - started_at)) / 60.0 AS avg_runtime_minutes
            FROM loops
            WHERE ${whereClause}
          `)
      ),

      // Time series with parameterized interval bucket
      withDb((db) =>
        db.$queryRaw<TimeSeriesRow[]>(Prisma.sql`
            SELECT
              ${bucketExpr} AS bucket,
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
              ), 0) AS cache_creation,
              COUNT(DISTINCT user_id) AS active_users,
              COUNT(*) AS loops
            FROM loops
            WHERE ${whereClause}
            GROUP BY bucket
            ORDER BY bucket
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

      // Top projects by tokens (via workstream → project join, fallback to repo name)
      withDb((db) =>
        db.$queryRaw<ProjectRow[]>(Prisma.sql`
            SELECT
              COALESCE(p.name, l.repo ->> 'fullName', 'Unknown') AS project,
              COALESCE(SUM(l.tokens_input), 0) AS input_tokens,
              COALESCE(SUM(l.tokens_output), 0) AS output_tokens
            FROM loops l
            LEFT JOIN workstreams w ON l.workstream_id = w.id
            LEFT JOIN projects p ON w.project_id = p.id
            WHERE ${joinWhereClause}
            GROUP BY project
            ORDER BY (COALESCE(SUM(l.tokens_input), 0) + COALESCE(SUM(l.tokens_output), 0)) DESC
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

      fetchDeliveryStats(org.id, startDate),
      fetchAgentUsage(org.id, startDate),
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

    // Filter out synthetic/junk models and 0-token entries
    const filteredByModel = byModel.filter(
      (m) => m.totalTokens > 0 && !m.model.startsWith("<")
    );
    const apiCostEquivalent = filteredByModel.reduce(
      (sum, m) => sum + m.apiCost,
      0
    );

    // Subscription (electron) vs API (cloud) token split
    const electronRow = originResult.find((r) => r.is_electron);
    const cloudRow = originResult.find((r) => !r.is_electron);
    const subscriptionTokens = Number(electronRow?.total_tokens ?? 0);
    const apiTokens = Number(cloudRow?.total_tokens ?? 0);

    const totalTokens = subscriptionTokens + apiTokens;
    const totalLoops = Number(agg?.total_loops ?? 0);

    const stats: UsageDashboardStats = {
      activeUsers: Number(agg?.active_users ?? 0),
      sessions: Number(agg?.sessions ?? 0),
      activeNodes: Number(agg?.active_nodes ?? 0),
      turns: totalLoops,
      inputTokens: Number(agg?.total_input ?? 0),
      outputTokens: Number(agg?.total_output ?? 0),
      cacheRead: Number(agg?.total_cache_read ?? 0),
      cacheCreation: Number(agg?.total_cache_creation ?? 0),
      apiCostEquivalent,
      estimatedCost: apiCostEquivalent,
      subscriptionTokens,
      apiTokens,
      subscriptionPct:
        totalTokens > 0
          ? Math.round((subscriptionTokens / totalTokens) * 100)
          : 0,
      avgLoopsPerDay: Math.round((totalLoops / daysInRange) * 10) / 10,
      avgRuntimeMinutes:
        Math.round(Number(agg?.avg_runtime_minutes ?? 0) * 10) / 10,
    };

    // Compute blended cost-per-token rate from model breakdown
    const totalModelTokens = filteredByModel.reduce(
      (s, m) => s + m.totalTokens,
      0
    );
    const blendedCostPerToken =
      totalModelTokens > 0 ? apiCostEquivalent / totalModelTokens : 0;

    const timeSeries: TimeSeriesBucket[] = dailyResult.map(
      (r: TimeSeriesRow) => {
        const bucketTokens =
          Number(r.input) +
          Number(r.output) +
          Number(r.cache_read) +
          Number(r.cache_creation);
        return {
          date: r.bucket,
          input: Number(r.input),
          output: Number(r.output),
          cacheRead: Number(r.cache_read),
          cacheCreation: Number(r.cache_creation),
          activeUsers: Number(r.active_users),
          loops: Number(r.loops),
          apiCost: Math.round(bucketTokens * blendedCostPerToken * 100) / 100,
        };
      }
    );

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
      timeSeries,
      dailyUsage: timeSeries,
      byModel: filteredByModel,
      topProjects,
      recentSessions,
      agentUsage,
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
