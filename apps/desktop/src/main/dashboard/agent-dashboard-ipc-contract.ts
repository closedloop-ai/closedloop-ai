import {
  BranchTraceUnavailableReason,
  unavailableBranchTraceResult,
} from "@repo/api/src/types/branch-trace";
import {
  ConvertFailureClass,
  type ConvertInstallOutcome,
  makeConvertInstallErrorOutcome,
} from "@repo/api/src/types/convert-install";
import type { SessionPageRequest } from "../../shared/agent-db-contract.js";
import {
  SCHEDULED_TASKS_IPC_CHANNEL_LIST,
  ScheduledTasksIpcChannel,
} from "../../shared/scheduled-tasks-channel.js";
import { emptyAgentComponentsListResponse } from "../../shared/shared-agent-components-contract.js";
import {
  emptySharedAgentSessionsAnalytics,
  emptySharedAgentSessionsListResponse,
  emptySharedAgentSessionsPageDataResponse,
  emptySharedAgentSessionsUsageSummary,
  SHARED_AGENT_SESSIONS_IPC_CHANNEL_LIST,
  SHARED_AGENT_SESSIONS_IPC_CHANNELS,
  type SharedAgentSessionsIpcChannel,
} from "../../shared/shared-agent-sessions-contract.js";
import {
  emptySharedBranchesAnalytics,
  emptySharedBranchesListResponse,
  emptySharedBranchesPageDataResponse,
  emptySharedBranchesUsageSummary,
  SHARED_BRANCHES_IPC_CHANNEL_LIST,
  SHARED_BRANCHES_IPC_CHANNELS,
  type SharedBranchesIpcChannel,
} from "../../shared/shared-branches-contract.js";
import {
  SHARED_TRACE_COMMENTS_IPC_CHANNEL_LIST,
  type SharedTraceCommentsIpcChannel,
} from "../../shared/shared-trace-comments-contract.js";

/**
 * The convert-engine IPC channel name (FEA-4079). Named once here and imported by
 * the contract array below, the preload bridge, and the main-process handler so a
 * one-sided rename is a COMPILE error instead of a silent runtime "no handler
 * for channel" failure (the copies would otherwise all still typecheck).
 */
export const CATALOG_CONVERT_INSTALL_CHANNEL =
  "desktop:db:catalog-convert-install" as const;

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
  // Convert engine (FEA-4079): convert a component to a target harness's format
  // and install it, as one gateway operation, over the vetted install path.
  CATALOG_CONVERT_INSTALL_CHANNEL,
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
  // Optimization analytics (FEA-2923 / AC-022)
  "desktop:db:get-component-model-trend",
  "desktop:db:get-subagent-frequency",
  "desktop:db:is-skill-loaded",
  // Agent components local read (FEA-2923 / T-16.3)
  "desktop:db:list-agent-components",
  "desktop:db:get-agent-component-detail",
] as const;

type DesignSystemDbIpcChannel = (typeof DESIGN_SYSTEM_DB_IPC_CHANNELS)[number];

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
  windowDays: 0,
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

// FEA-4079: the convert engine returns a ConvertInstallOutcome, not a
// CatalogMutationResult. When the runtime is disabled the convert never runs, so
// the boundary reports an honest, retryable `error` (transient) — enabling the
// dashboard and retrying can succeed — rather than pretending the convert was
// unsupported (a permanent verdict it has not earned). Built through the shared
// contract-complete builder (NOT a hand-rolled `{ state, failureClass, message }`
// literal) so the required `identity`/`capability`/`droppedFields` fields the
// `Promise<ConvertInstallOutcome>` contract promises are present — a consumer on
// the disabled path can never dereference `undefined`. `makeConvertInstallError-
// Outcome` lives in the transport-neutral, dependency-light `@repo/api` type
// module, so this contract file stays free of convert-ENGINE (desktop-main) deps.
const DISABLED_CONVERT_INSTALL_RESULT: ConvertInstallOutcome =
  makeConvertInstallErrorOutcome({
    failureClass: ConvertFailureClass.Transient,
    message: "Agent Dashboard is disabled in Settings.",
  });

const EMPTY_PR_STATS = {
  totalPrs: 0,
  sessionsWithPrs: 0,
  repos: 0,
};

const EMPTY_DIAGNOSTICS = {
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
function resolveDisabledAgentDashboardDbIpcResponse(
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
    case CATALOG_CONVERT_INSTALL_CHANNEL:
      return DISABLED_CONVERT_INSTALL_RESULT;
    case "desktop:db:catalog-refresh":
    case "desktop:db:confirm-plan":
    case "desktop:db:reject-plan":
    case "desktop:db:open-plan":
    case "desktop:db:open-pr":
      return undefined;
    case "desktop:db:get-diagnostics":
      return EMPTY_DIAGNOSTICS;
    case "desktop:db:get-component-model-trend":
      return { componentKind: "", componentKey: "", windowDays: 0, points: [] };
    case "desktop:db:get-subagent-frequency":
      return { subagentKey: "", windowDays: 0, points: [] };
    case "desktop:db:is-skill-loaded":
      return {
        skillKey: "",
        existsInInventory: false,
        hasUsage: false,
        totalInvocations: 0,
        lastUsedAt: null,
      };
    case "desktop:db:list-agent-components":
      return emptyAgentComponentsListResponse();
    case "desktop:db:get-agent-component-detail":
      return null;
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
function resolveDisabledSharedAgentSessionsIpcResponse(
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
    // FEA-4157: disabled/degraded combined read → empty list + empty usage.
    case SHARED_AGENT_SESSIONS_IPC_CHANNELS.pageData:
      return emptySharedAgentSessionsPageDataResponse();
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
function resolveDisabledSharedBranchesIpcResponse(
  channel: SharedBranchesIpcChannel
): unknown {
  switch (channel) {
    case SHARED_BRANCHES_IPC_CHANNELS.list:
      return emptySharedBranchesListResponse();
    case SHARED_BRANCHES_IPC_CHANNELS.detail:
      return null;
    // Preserve an explicit unavailable state while the local runtime is disabled.
    case SHARED_BRANCHES_IPC_CHANNELS.trace:
      return unavailableBranchTraceResult(
        [],
        BranchTraceUnavailableReason.Unknown
      );
    case SHARED_BRANCHES_IPC_CHANNELS.usage:
      return emptySharedBranchesUsageSummary();
    case SHARED_BRANCHES_IPC_CHANNELS.analytics:
      return emptySharedBranchesAnalytics();
    case SHARED_BRANCHES_IPC_CHANNELS.cohortAnalytics:
      return null;
    case SHARED_BRANCHES_IPC_CHANNELS.pageData:
      return emptySharedBranchesPageDataResponse();
    default:
      return emptySharedBranchesListResponse();
  }
}

/**
 * Fail shared trace-comment IPC explicitly while the Agent Dashboard DB is
 * disabled or unavailable. Unlike sessions/branches, returning empty reads here
 * can hide local-only comments, so every trace-comment operation requires the
 * local store to be live.
 */
function resolveDisabledSharedTraceCommentsIpcResponse(
  _channel: SharedTraceCommentsIpcChannel
): unknown {
  throw new Error(
    "Trace comments are unavailable because the local store is unavailable."
  );
}

/**
 * Disabled-store responder for the Routines channels (the IPC channel strings
 * are the preserved `scheduled-tasks:*` wire contract). Reads degrade to an
 * empty surface so a mounted view renders its empty state; `previewSchedule`
 * returns an inert invalid result; writes reject so the mutation error handler
 * surfaces the failure instead of the UI believing the write landed.
 */
function resolveDisabledScheduledTasksIpcResponse(channel: string): unknown {
  switch (channel) {
    case ScheduledTasksIpcChannel.List:
    case ScheduledTasksIpcChannel.Runs:
      return [];
    case ScheduledTasksIpcChannel.PreviewSchedule:
      return {
        valid: false,
        error: "Routines are unavailable because the daemon is off.",
        nextRuns: [],
      };
    default:
      throw new Error(
        "Routines are unavailable because the local store is unavailable."
      );
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
  for (const channel of SHARED_TRACE_COMMENTS_IPC_CHANNEL_LIST) {
    ipc.removeHandler(channel);
    ipc.handle(channel, () =>
      resolveDisabledSharedTraceCommentsIpcResponse(channel)
    );
  }
  // FEA-3852/3853/3854 (PRD-553): the Scheduled Tasks channels while the store is
  // disabled/unavailable. Reads (`list`/`runs`) return an empty array so a mounted
  // view renders its empty state (never a rejected promise), and `previewSchedule`
  // returns an inert invalid result. Writes (`create`/`update`/`delete`/`toggle`/
  // `runNow`) can't succeed against a disabled store, so they REJECT — the global
  // mutation error handler surfaces it rather than the UI silently believing a
  // create landed (a lying UI).
  for (const channel of SCHEDULED_TASKS_IPC_CHANNEL_LIST) {
    ipc.removeHandler(channel);
    ipc.handle(channel, () =>
      resolveDisabledScheduledTasksIpcResponse(channel)
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
