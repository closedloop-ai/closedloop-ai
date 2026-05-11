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
export type TimeInterval = "15min" | "1h" | "1d";

export type PublicUsageDashboardResponse = {
  organizationName: string;
  updatedAt: string;
  models: string[];
  stats: UsageDashboardStats;
  delivery: DeliveryStats;
  /** Token breakdown by time bucket (interval controlled by query param) */
  timeSeries: TimeSeriesBucket[];
  /** @deprecated Use timeSeries instead. Kept for backward compatibility. */
  dailyUsage: TimeSeriesBucket[];
  byModel: ModelUsage[];
  topProjects: ProjectUsage[];
  recentSessions: RecentSession[];
  /** Aggregated agent usage from execution perf stats (empty if no perf data) */
  agentUsage: AgentUsage[];
  /** Per-user leaderboard sorted by total tokens descending */
  userLeaderboard: UserLeaderboardEntry[];
};

export type UsageDashboardStats = {
  activeUsers: number;
  /** Distinct session_id count (individual logins / session refreshes) */
  sessions: number;
  /** Active compute targets (electron nodes) in the period */
  activeNodes: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreation: number;
  /** Calculated from Anthropic per-model API pricing applied to tokens_by_model */
  apiCostEquivalent: number;
  /** @deprecated Use apiCostEquivalent instead. Kept for backward compatibility. */
  estimatedCost: number;
  /** Tokens consumed on electron targets (covered by personal subscription) */
  subscriptionTokens: number;
  /** Tokens consumed via cloud/API key */
  apiTokens: number;
  /** % of tokens on subscription (electron) targets */
  subscriptionPct: number;
  /** Average loops per day in the selected range */
  avgLoopsPerDay: number;
  /** Average loop runtime in minutes (all loops including failed) */
  avgRuntimeMinutes: number;
};

export type AgentUsage = {
  agentName: string;
  agentType: string;
  totalCalls: number;
  totalDurationS: number;
};

export type DeliveryStats = {
  prdsCreated: number;
  plansCreated: number;
  featuresCreated: number;
  prsMerged: number;
  /** Distinct workstreams with loop activity in the period */
  agenticWorkflows: number;
};

/**
 * Multi-metric time series bucket. Each bucket contains all metrics so the
 * frontend can switch the chart to any metric by clicking a stat card.
 */
export type TimeSeriesBucket = {
  date: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  activeUsers: number;
  loops: number;
  apiCost: number;
};

export type UserLeaderboardEntry = {
  userId: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  apiCostEquivalent: number;
  sessions: number;
  loops: number;
  avgRuntimeMinutes: number;
  topModel: string;
  /** Daily token totals for sparkline visualization */
  sparkline: number[];
};

export type ModelUsage = {
  model: string;
  totalTokens: number;
  apiCost: number;
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
