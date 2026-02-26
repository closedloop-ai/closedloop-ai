import type {
  DailyTrend,
  DashboardStats,
  PublicDashboardResponse,
} from "@repo/api/src/types/dashboard";
import {
  ArtifactType,
  GitHubActionStatus,
  GitHubPRState,
  withDb,
} from "@repo/database";
import { log } from "@repo/observability/log";

/**
 * Dashboard service - handles database operations for dashboard statistics
 */
export const dashboardService = {
  /**
   * Get dashboard statistics for an organization including counts and 14-day trends.
   * Returns metrics for PRDs, issues, implementation plans, landed code, and agentic workflows.
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
        issuesCount,
        plansCount,
        landedCodeCount,
        agenticWorkflowsCount,
        prdsTrendData,
        issuesTrendData,
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
        // Issues are a separate entity (Issue table)
        withDb((db) =>
          db.issue.count({
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
        // Issues trend from separate Issue table
        withDb((db) =>
          db.issue.findMany({
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
      const issuesTrend = aggregateTrendData(issuesTrendData, "createdAt");
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
        issues: { count: issuesCount, trend: issuesTrend },
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
