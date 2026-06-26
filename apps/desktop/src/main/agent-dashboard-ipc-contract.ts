import type { SessionPageRequest } from "../shared/agent-db-contract.js";
import {
  emptySharedAgentSessionsAnalytics,
  emptySharedAgentSessionsListResponse,
  emptySharedAgentSessionsUsageSummary,
  SHARED_AGENT_SESSIONS_IPC_CHANNEL_LIST,
  SHARED_AGENT_SESSIONS_IPC_CHANNELS,
  type SharedAgentSessionsIpcChannel,
} from "../shared/shared-agent-sessions-contract.js";
import {
  emptySharedBranchesAnalytics,
  emptySharedBranchesListResponse,
  emptySharedBranchesUsageSummary,
  SHARED_BRANCHES_IPC_CHANNEL_LIST,
  SHARED_BRANCHES_IPC_CHANNELS,
  type SharedBranchesIpcChannel,
} from "../shared/shared-branches-contract.js";

export const DESIGN_SYSTEM_DB_IPC_CHANNELS = [
  "desktop:db:get-sessions",
  "desktop:db:get-sessions-page",
  "desktop:db:get-kanban-pages",
  "desktop:db:get-session",
  "desktop:db:get-session-details",
  "desktop:db:get-agents",
  "desktop:db:get-events",
  "desktop:db:get-dashboard-summary",
  "desktop:db:get-sessions-with-details",
  "desktop:db:get-event-feed",
  "desktop:db:get-events-with-session",
  "desktop:db:get-event-count-by-type",
  "desktop:db:get-token-analytics",
  "desktop:db:get-insights",
  "desktop:db:get-agent-hierarchy",
  "desktop:db:get-analytics",
  "desktop:db:get-workflow-data",
  "desktop:db:get-core-features",
  "desktop:db:get-packs",
  "desktop:db:get-skills",
  "desktop:db:get-tools",
  "desktop:db:get-subagents",
  "desktop:db:get-plans",
  "desktop:db:get-pull-requests",
  // Catalog (FEA-1314)
  "desktop:db:get-catalog",
  "desktop:db:get-catalog-entry",
  "desktop:db:get-catalog-readme",
  "desktop:db:get-catalog-contents",
  "desktop:db:get-catalog-history",
  "desktop:db:catalog-install",
  "desktop:db:catalog-uninstall",
  "desktop:db:catalog-refresh",
  "desktop:db:get-install-runs",
  // Installed packs (FEA-1224)
  "desktop:db:get-installed-packs",
  "desktop:db:get-pack-detail",
  "desktop:db:get-pack-sessions",
  "desktop:db:get-all-skills",
  "desktop:db:get-skill-invocations",
  "desktop:db:get-recent-projects",
  // Plans (FEA-1189)
  "desktop:db:get-plans-list",
  "desktop:db:get-plan",
  "desktop:db:get-plan-versions",
  "desktop:db:confirm-plan",
  "desktop:db:reject-plan",
  "desktop:db:open-plan",
  // Pull Requests (FEA-1226)
  "desktop:db:get-pr-stats",
  "desktop:db:get-pr-sessions",
  "desktop:db:get-pr-list",
  "desktop:db:open-pr",
  // Diagnostics (FEA-1959)
  "desktop:db:get-diagnostics",
] as const;

export type DesignSystemDbIpcChannel =
  (typeof DESIGN_SYSTEM_DB_IPC_CHANNELS)[number];

const EMPTY_DASHBOARD_SUMMARY = {
  totalSessions: 0,
  activeSessions: 0,
  totalAgents: 0,
  totalEvents: 0,
  eventTypeCount: 0,
  totalTokens: 0,
  recentSessions: [],
};

const EMPTY_TOKEN_ANALYTICS = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheWriteTokens: 0,
  byModel: [],
  byDay: [],
};

const EMPTY_ANALYTICS = {
  tokens: EMPTY_TOKEN_ANALYTICS,
  eventsByType: [],
  toolUsage: [],
  dailyEvents: [],
  sessionsByStatus: [],
  agentsByStatus: [],
  agentsByType: [],
  totalSessions: 0,
  totalAgents: 0,
  totalEvents: 0,
};

const EMPTY_WORKFLOW_DATA = {
  stats: {
    totalSessions: 0,
    totalAgents: 0,
    totalSubagents: 0,
    avgSubagents: 0,
    successRate: 0,
    avgDepth: 0,
    avgDurationSec: 0,
    totalCompactions: 0,
    avgCompactions: 0,
    topFlow: null,
  },
  orchestration: {
    sessionCount: 0,
    mainCount: 0,
    subagentTypes: [],
    edges: [],
    outcomes: [],
    compactions: { total: 0, sessions: 0 },
  },
  toolFlow: {
    transitions: [],
    toolCounts: [],
  },
  effectiveness: [],
  cooccurrence: [],
};

const EMPTY_CORE_FEATURES = {
  packs: [],
  skills: [],
  tools: [],
  subagents: [],
  plans: [],
  pullRequests: [],
};

const DISABLED_MUTATION_RESULT = {
  started: false,
  error: {
    code: "AGENT_DASHBOARD_DISABLED",
    message: "Agent Dashboard is disabled in Settings.",
  },
};

const EMPTY_PR_STATS = {
  totalPrs: 0,
  sessionsWithPrs: 0,
  repos: 0,
};

const EMPTY_DIAGNOSTICS = {
  enrichmentQueue: [],
  pendingArtifacts: [],
  stalledArtifacts: [],
  repos: [],
  backfill: {
    artifactLinks: { totalScanned: 0, lastScannedAt: null },
    prBackfill: { totalScanned: 0, lastScannedAt: null },
  },
  linkStats: [],
  linkTotals: { totalLinks: 0, linkedSessions: 0, linkedArtifacts: 0 },
};

/**
 * Return neutral renderer-safe DB responses while the Agent Dashboard runtime is
 * disabled. This keeps the always-loaded design-system renderer from failing on
 * missing IPC handlers without importing SQLite or starting capture services.
 */
export function resolveDisabledAgentDashboardDbIpcResponse(
  channel: DesignSystemDbIpcChannel,
  args: unknown[]
): unknown {
  switch (channel) {
    case "desktop:db:get-dashboard-summary":
      return EMPTY_DASHBOARD_SUMMARY;
    case "desktop:db:get-sessions-page":
      return emptySessionPage(args[0]);
    case "desktop:db:get-kanban-pages":
      return emptyKanbanPages(args[0], args[1]);
    case "desktop:db:get-token-analytics":
      return EMPTY_TOKEN_ANALYTICS;
    case "desktop:db:get-insights":
      return emptyInsightsResponse(args[0]);
    case "desktop:db:get-analytics":
      return EMPTY_ANALYTICS;
    case "desktop:db:get-workflow-data":
      return EMPTY_WORKFLOW_DATA;
    case "desktop:db:get-core-features":
      return EMPTY_CORE_FEATURES;
    case "desktop:db:get-pr-stats":
      return EMPTY_PR_STATS;
    case "desktop:db:get-session":
    case "desktop:db:get-session-details":
      return undefined;
    case "desktop:db:get-catalog-entry":
    case "desktop:db:get-catalog-readme":
    case "desktop:db:get-catalog-contents":
    case "desktop:db:get-plan":
      return null;
    case "desktop:db:catalog-install":
    case "desktop:db:catalog-uninstall":
      return DISABLED_MUTATION_RESULT;
    case "desktop:db:catalog-refresh":
    case "desktop:db:confirm-plan":
    case "desktop:db:reject-plan":
    case "desktop:db:open-plan":
    case "desktop:db:open-pr":
      return undefined;
    case "desktop:db:get-diagnostics":
      return EMPTY_DIAGNOSTICS;
    default:
      return [];
  }
}

/**
 * Return neutral canonical shared-session responses while the Agent Dashboard
 * runtime is disabled or unavailable. Detail fails closed as not-found, while
 * collection/aggregate reads return empty canonical shapes for future mounted
 * shared hooks.
 */
export function resolveDisabledSharedAgentSessionsIpcResponse(
  channel: SharedAgentSessionsIpcChannel
): unknown {
  switch (channel) {
    case SHARED_AGENT_SESSIONS_IPC_CHANNELS.list:
      return emptySharedAgentSessionsListResponse();
    case SHARED_AGENT_SESSIONS_IPC_CHANNELS.detail:
      return null;
    case SHARED_AGENT_SESSIONS_IPC_CHANNELS.usage:
      return emptySharedAgentSessionsUsageSummary();
    case SHARED_AGENT_SESSIONS_IPC_CHANNELS.analytics:
      return emptySharedAgentSessionsAnalytics();
    default:
      return emptySharedAgentSessionsListResponse();
  }
}

/**
 * Return neutral canonical shared-branches responses while the Agent Dashboard
 * runtime is disabled or unavailable. Detail fails closed as not-found (null);
 * list/usage/analytics return the empty canonical shapes. Mirrors the
 * shared-agent-sessions disabled responder so a mounted branches hook degrades
 * identically when capture is off or SQLite boot fails — without this, the
 * already-exposed `branchesApi` either hits no handler or stays bound to a
 * rejected DB promise.
 */
export function resolveDisabledSharedBranchesIpcResponse(
  channel: SharedBranchesIpcChannel
): unknown {
  switch (channel) {
    case SHARED_BRANCHES_IPC_CHANNELS.list:
      return emptySharedBranchesListResponse();
    case SHARED_BRANCHES_IPC_CHANNELS.detail:
      return null;
    case SHARED_BRANCHES_IPC_CHANNELS.usage:
      return emptySharedBranchesUsageSummary();
    case SHARED_BRANCHES_IPC_CHANNELS.analytics:
      return emptySharedBranchesAnalytics();
    default:
      return emptySharedBranchesListResponse();
  }
}

/** Minimal injectable surface of Electron's `ipcMain` used to (re)install handlers. */
export type IpcHandleRegistrar = {
  handle(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => unknown
  ): void;
  removeHandler(channel: string): void;
};

/**
 * Install the disabled Agent Dashboard DB IPC responders, removing any existing
 * handler for each channel FIRST so this is safe to call after live handlers are
 * registered, during shutdown, or while recovering from a failed Agent Monitor
 * start. removeHandler on a channel with no handler is a no-op.
 */
export function installDisabledAgentDashboardDbIpcHandlers(
  ipc: IpcHandleRegistrar
): void {
  for (const channel of DESIGN_SYSTEM_DB_IPC_CHANNELS) {
    ipc.removeHandler(channel);
    ipc.handle(channel, (_event, ...args) =>
      resolveDisabledAgentDashboardDbIpcResponse(channel, args)
    );
  }
  for (const channel of SHARED_AGENT_SESSIONS_IPC_CHANNEL_LIST) {
    ipc.removeHandler(channel);
    ipc.handle(channel, () =>
      resolveDisabledSharedAgentSessionsIpcResponse(channel)
    );
  }
  for (const channel of SHARED_BRANCHES_IPC_CHANNEL_LIST) {
    ipc.removeHandler(channel);
    ipc.handle(channel, () =>
      resolveDisabledSharedBranchesIpcResponse(channel)
    );
  }
}

const EMPTY_TIME_SERIES = { series: [], points: [] };

function emptyInsightsResponse(section: unknown): unknown {
  if (section === "utilization") {
    return {
      kpis: [],
      charts: {
        eventActivity: EMPTY_TIME_SERIES,
        eventVolume: EMPTY_TIME_SERIES,
        eventsByType: [],
        sessionsByStatus: [],
        reviewQueue: [],
      },
    };
  }
  if (section === "agents") {
    return {
      kpis: [],
      charts: {
        modelUsageOverTime: EMPTY_TIME_SERIES,
        modelBreakdown: [],
        tokenDistribution: [],
        toolUsage: [],
        agentsByStatus: [],
        agentsByType: [],
        toolRunsOverTime: EMPTY_TIME_SERIES,
      },
    };
  }
  return {
    kpis: [],
    charts: {
      prTrend: EMPTY_TIME_SERIES,
      klocTrend: EMPTY_TIME_SERIES,
      prByRepo: [],
      meanTimeToMerge: [],
      prByState: [],
      branchLifespan: [],
      branchesWithoutPr: [],
    },
  };
}

function emptySessionPage(request: unknown): {
  sessions: [];
  total: number;
  limit: number;
  offset: number;
} {
  const pageRequest = isSessionPageRequest(request) ? request : {};
  return {
    sessions: [],
    total: 0,
    limit: pageRequest.limit ?? 25,
    offset: pageRequest.offset ?? 0,
  };
}

function emptyKanbanPages(
  statuses: unknown,
  limit: unknown
): Record<string, unknown> {
  if (!Array.isArray(statuses)) {
    return {};
  }
  return Object.fromEntries(
    statuses
      .filter((status): status is string => typeof status === "string")
      .map((status) => [
        status,
        {
          sessions: [],
          total: 0,
          limit: typeof limit === "number" ? limit : 25,
          offset: 0,
        },
      ])
  );
}

function isSessionPageRequest(value: unknown): value is SessionPageRequest {
  return typeof value === "object" && value !== null;
}
