// Dashboard stats types for API contract
// These are explicitly defined to keep packages/api independent of database

/**
 * Represents a single data point in a time-series trend.
 * Date is in ISO 8601 format (YYYY-MM-DD).
 */
export type DailyTrend = {
  date: string; // ISO 8601 date string (YYYY-MM-DD)
  count: number;
};

/**
 * Metric object containing current count and historical trend data.
 */
export type MetricWithTrend = {
  count: number;
  trend: DailyTrend[];
};

/**
 * Dashboard statistics including key metrics and their trends.
 * Each metric includes the current count and a time-series array for visualization.
 */
export type DashboardStats = {
  /** Total number of PRDs */
  prds: MetricWithTrend;
  /** Total number of issues */
  issues: MetricWithTrend;
  /** Total number of implementation plans */
  plans: MetricWithTrend;
  /** Number of landed code (merged PRs) */
  landedCode: MetricWithTrend;
  /** Number of agentic workflows fired off */
  agenticWorkflows: MetricWithTrend;
  /** Number of agents, skills, plugins, and sub-agents (placeholder) */
  agentsCount?: number;
  /** Number of active leaderboards (placeholder) */
  leaderboardsCount?: number;
};
