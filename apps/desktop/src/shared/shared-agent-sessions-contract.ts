import type {
  AgentSessionAgentTypeBreakdown,
  AgentSessionAnalytics,
  AgentSessionDetail,
  AgentSessionHarnessBreakdown,
  AgentSessionListItem,
  AgentSessionListResponse,
  AgentSessionRepositoryBreakdown,
  AgentSessionToolBreakdown,
  AgentSessionUsageByModel,
  AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session";

export const SHARED_AGENT_SESSIONS_IPC_CHANNELS = {
  list: "desktop:shared-agent-sessions:list",
  detail: "desktop:shared-agent-sessions:detail",
  usage: "desktop:shared-agent-sessions:usage",
  analytics: "desktop:shared-agent-sessions:analytics",
} as const;

export const SHARED_AGENT_SESSIONS_IPC_CHANNEL_LIST = [
  SHARED_AGENT_SESSIONS_IPC_CHANNELS.list,
  SHARED_AGENT_SESSIONS_IPC_CHANNELS.detail,
  SHARED_AGENT_SESSIONS_IPC_CHANNELS.usage,
  SHARED_AGENT_SESSIONS_IPC_CHANNELS.analytics,
] as const;

/** Display label for local Desktop sessions that have no reliable user profile. */
export const DESKTOP_LOCAL_SESSION_AUTHOR_LABEL = "Local Desktop session";

export type SharedAgentSessionsIpcChannel =
  (typeof SHARED_AGENT_SESSIONS_IPC_CHANNEL_LIST)[number];

export type SharedAgentSessionsQuery = {
  startDate?: string;
  endDate?: string;
  harness?: string;
  status?: string;
  /** Free-text search over a session's name, repo, and branch (sessions/branches). */
  search?: string;
  userId?: string;
  teamId?: string;
  projectId?: string;
  /** Multi-select Filter facets (mirror the cloud query); empty/absent = no constraint. */
  statuses?: readonly string[];
  userIds?: readonly string[];
  repositories?: readonly string[];
  limit?: number;
  offset?: number;
  /** Column-header sort: column id + direction. */
  sortBy?: string;
  sortDir?: "asc" | "desc";
};

export type SharedAgentSessionsListRequest = SharedAgentSessionsQuery & {
  ids?: readonly string[];
};

export type SharedAgentSessionListItem = AgentSessionListItem;
export type SharedAgentSessionListResponse = AgentSessionListResponse;
export type SharedAgentSessionDetail = AgentSessionDetail;
export type SharedAgentSessionUsageSummary = AgentSessionUsageSummary;
export type SharedAgentSessionUsageByModel = AgentSessionUsageByModel;
export type SharedAgentSessionHarnessBreakdown = AgentSessionHarnessBreakdown;
export type SharedAgentSessionToolBreakdown = AgentSessionToolBreakdown;
export type SharedAgentSessionAgentTypeBreakdown =
  AgentSessionAgentTypeBreakdown;
export type SharedAgentSessionRepositoryBreakdown =
  AgentSessionRepositoryBreakdown;
export type SharedAgentSessionAnalytics = AgentSessionAnalytics;

export const SHARED_AGENT_SESSIONS_NOT_FOUND_CODE =
  "LOCAL_AGENT_SESSION_NOT_FOUND" as const;
export const SHARED_AGENT_SESSIONS_SOURCE_ERROR_CODE =
  "LOCAL_AGENT_SESSIONS_SOURCE_ERROR" as const;

/** Empty canonical list response for disabled or unsupported local reads. */
export function emptySharedAgentSessionsListResponse(): SharedAgentSessionListResponse {
  return {
    items: [],
    total: 0,
    viewerScope: "self",
  };
}

/** Empty canonical usage summary for disabled or unsupported local reads. */
export function emptySharedAgentSessionsUsageSummary(): SharedAgentSessionUsageSummary {
  return {
    viewerScope: "self",
    totalSessions: 0,
    earliestSessionAt: null,
    latestSessionAt: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalEstimatedCost: 0,
    subscriptionEstimatedCost: 0,
    apiEstimatedCost: 0,
    byUser: [],
    byModel: [],
    byHarness: [],
    byRepository: [],
    lastSyncTargets: [],
  };
}

/** Empty canonical analytics response for disabled or unsupported local reads. */
export function emptySharedAgentSessionsAnalytics(): SharedAgentSessionAnalytics {
  return {
    viewerScope: "self",
    byTool: [],
    byAgentType: [],
    byRepository: [],
    byProject: [],
  };
}
