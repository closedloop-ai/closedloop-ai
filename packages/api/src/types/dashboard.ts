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
  /** Total number of features */
  features: MetricWithTrend;
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

/**
 * Response for the public (unauthenticated) dashboard endpoint.
 */
export type PublicDashboardResponse = {
  organizationName: string;
  stats: DashboardStats;
};

/**
 * Response for admin public dashboard token management.
 */
export type PublicDashboardTokenResponse = {
  token: string | null;
  url: string | null;
};

// ── Public Usage Dashboard Types ────────────────────────────────────────────

/**
 * Response for the public usage dashboard (Claude Code usage stats).
 */
export type PublicUsageDashboardResponse = {
  organizationName: string;
  updatedAt: string;
  models: string[];
  stats: UsageDashboardStats;
  dailyUsage: DailyTokenUsage[];
  byModel: ModelUsage[];
  topProjects: ProjectUsage[];
  recentSessions: RecentSession[];
};

export type UsageDashboardStats = {
  sessions: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreation: number;
  estimatedCost: number;
};

export type DailyTokenUsage = {
  date: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
};

export type ModelUsage = {
  model: string;
  totalTokens: number;
};

export type ProjectUsage = {
  project: string;
  inputTokens: number;
  outputTokens: number;
};

export type RecentSession = {
  sessionId: string;
  project: string;
  lastActive: string;
  durationMinutes: number;
  model: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
};
