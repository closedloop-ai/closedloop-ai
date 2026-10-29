import {
  BranchTraceUnavailableReason,
  unavailableBranchTraceResult,
} from "@repo/api/src/types/branch-trace";
import {
  ConvertFailureClass,
  type ConvertInstallOutcome,
  makeConvertInstallErrorOutcome,
} from "@repo/api/src/types/convert-install";
import { AgentDashboardDbIpcChannel } from "../../shared/agent-dashboard-db-ipc-channel.js";
import type {
  SessionPageRequest,
  WorkflowQueryData,
} from "../../shared/agent-db-contract.js";
import {
  LOCAL_BRANCH_PRIORITY_WRITE_CHANNEL,
  LOCAL_SESSION_PRIORITY_WRITE_CHANNEL,
  type LocalPriorityWriteResult,
  LocalPriorityWriteStatus,
} from "../../shared/local-priority-write-contract.js";
import {
  emptyAgentComponentsListResponse,
  emptyAgentComponentsPageDataResponse,
  SHARED_AGENT_COMPONENTS_IPC_CHANNELS,
} from "../../shared/shared-agent-components-contract.js";
import {
  emptySharedAgentSessionsAnalytics,
  emptySharedAgentSessionsListResponse,
  emptySharedAgentSessionsPageDataResponse,
  emptySharedAgentSessionsUsageSummary,
  SHARED_AGENT_SESSIONS_IPC_CHANNEL_LIST,
  SHARED_AGENT_SESSIONS_IPC_CHANNELS,
  type SharedAgentSessionsCancelReadResult,
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
  THREAD_VIEWED_CHANNEL,
  type ThreadViewedResult,
} from "../../shared/thread-viewership-contract.js";

/**
 * The convert-engine IPC channel name (FEA-4079). Named once here and imported by
 * the contract array below, the preload bridge, and the main-process handler so a
 * one-sided rename is a COMPILE error instead of a silent runtime "no handler
 * for channel" failure (the copies would otherwise all still typecheck).
 */
export const CATALOG_CONVERT_INSTALL_CHANNEL =
  "desktop:db:catalog-convert-install" as const;

export const DESIGN_SYSTEM_DB_IPC_CHANNELS = [
  AgentDashboardDbIpcChannel.GetSessions,
  AgentDashboardDbIpcChannel.GetSessionsPage,
  AgentDashboardDbIpcChannel.GetKanbanPages,
  AgentDashboardDbIpcChannel.GetSession,
  AgentDashboardDbIpcChannel.GetSessionDetails,
  AgentDashboardDbIpcChannel.GetAgents,
  AgentDashboardDbIpcChannel.GetEvents,
  AgentDashboardDbIpcChannel.GetDashboardSummary,
  AgentDashboardDbIpcChannel.GetSessionsWithDetails,
  AgentDashboardDbIpcChannel.GetEventFeed,
  AgentDashboardDbIpcChannel.GetEventsWithSession,
  AgentDashboardDbIpcChannel.GetEventCountByType,
  AgentDashboardDbIpcChannel.GetTokenAnalytics,
  AgentDashboardDbIpcChannel.GetInsights,
  AgentDashboardDbIpcChannel.GetAgentHierarchy,
  AgentDashboardDbIpcChannel.GetAnalytics,
  AgentDashboardDbIpcChannel.GetWorkflowData,
  AgentDashboardDbIpcChannel.GetCoreFeatures,
  AgentDashboardDbIpcChannel.GetPacks,
  AgentDashboardDbIpcChannel.GetSkills,
  AgentDashboardDbIpcChannel.GetTools,
  AgentDashboardDbIpcChannel.GetSubagents,
  AgentDashboardDbIpcChannel.GetPlans,
  AgentDashboardDbIpcChannel.GetPullRequests,
  // Catalog (FEA-1314)
  AgentDashboardDbIpcChannel.GetCatalog,
  AgentDashboardDbIpcChannel.GetCatalogEntry,
  AgentDashboardDbIpcChannel.GetCatalogContents,
  AgentDashboardDbIpcChannel.GetCatalogHistory,
  AgentDashboardDbIpcChannel.CatalogInstall,
  // Convert engine (FEA-4079): convert a component to a target harness's format
  // and install it, as one gateway operation, over the vetted install path.
  CATALOG_CONVERT_INSTALL_CHANNEL,
  AgentDashboardDbIpcChannel.CatalogUninstall,
  AgentDashboardDbIpcChannel.CatalogRefresh,
  AgentDashboardDbIpcChannel.GetInstallRuns,
  // Installed packs (FEA-1224)
  AgentDashboardDbIpcChannel.GetInstalledPacks,
  AgentDashboardDbIpcChannel.GetPackDetail,
  AgentDashboardDbIpcChannel.GetPackSessions,
  AgentDashboardDbIpcChannel.GetAllSkills,
  AgentDashboardDbIpcChannel.GetSkillInvocations,
  // Plans (FEA-1189)
  AgentDashboardDbIpcChannel.GetPlansList,
  AgentDashboardDbIpcChannel.GetPlan,
  AgentDashboardDbIpcChannel.GetPlanVersions,
  AgentDashboardDbIpcChannel.ConfirmPlan,
  AgentDashboardDbIpcChannel.RejectPlan,
  AgentDashboardDbIpcChannel.OpenPlan,
  // Pull Requests (FEA-1226)
  AgentDashboardDbIpcChannel.GetPrStats,
  AgentDashboardDbIpcChannel.GetPrSessions,
  AgentDashboardDbIpcChannel.GetPrList,
  AgentDashboardDbIpcChannel.OpenPr,
  // Diagnostics (FEA-1959)
  AgentDashboardDbIpcChannel.GetDiagnostics,
  // Optimization analytics (FEA-2923 / AC-022)
  AgentDashboardDbIpcChannel.GetComponentModelTrend,
  AgentDashboardDbIpcChannel.GetSubagentFrequency,
  AgentDashboardDbIpcChannel.IsSkillLoaded,
  // Agent components local read (FEA-2923 / T-16.3)
  SHARED_AGENT_COMPONENTS_IPC_CHANNELS.list,
  SHARED_AGENT_COMPONENTS_IPC_CHANNELS.detail,
  SHARED_AGENT_COMPONENTS_IPC_CHANNELS.frequency,
  // ISS-6822: the bounded page-data read.
  SHARED_AGENT_COMPONENTS_IPC_CHANNELS.pageData,
  // ISS-10467: the per-content-version usage drill-down. A db-host handler that
  // is NOT listed here keeps a live ipcMain channel with no disabled-mode
  // responder behind it, so with the runtime down the renderer's call rejects
  // instead of answering — which the panel would render as a failed read rather
  // than as the unavailable capability it is. The CONST, not the literal, for the
  // reason the entry below states: a rename is then a compile error here rather
  // than a runtime "no handler for channel".
  SHARED_AGENT_COMPONENTS_IPC_CHANNELS.versionUsage,
  // ISS-7830: thread-viewership capture. The CONST, not the literal, so a rename
  // is a compile error here rather than a runtime "no handler for channel".
  THREAD_VIEWED_CHANNEL,
  // ISS-10332: the local-mode priority writes.
  LOCAL_SESSION_PRIORITY_WRITE_CHANNEL,
  LOCAL_BRANCH_PRIORITY_WRITE_CHANNEL,
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
  },
  orchestration: {
    sessionCount: 0,
    mainCount: 0,
    subagentTypes: [],
    outcomes: [],
    compactions: { total: 0, sessions: 0 },
  },
  effectiveness: [],
} satisfies WorkflowQueryData;

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
    case AgentDashboardDbIpcChannel.GetDashboardSummary:
      return EMPTY_DASHBOARD_SUMMARY;
    case AgentDashboardDbIpcChannel.GetSessionsPage:
      return emptySessionPage(args[0]);
    case AgentDashboardDbIpcChannel.GetKanbanPages:
      return emptyKanbanPages(args[0], args[1]);
    case AgentDashboardDbIpcChannel.GetTokenAnalytics:
      return EMPTY_TOKEN_ANALYTICS;
    case AgentDashboardDbIpcChannel.GetInsights:
      return emptyInsightsResponse(args[0]);
    case AgentDashboardDbIpcChannel.GetAnalytics:
      return EMPTY_ANALYTICS;
    case AgentDashboardDbIpcChannel.GetWorkflowData:
      return EMPTY_WORKFLOW_DATA;
    case AgentDashboardDbIpcChannel.GetCoreFeatures:
      return EMPTY_CORE_FEATURES;
    case AgentDashboardDbIpcChannel.GetPrStats:
      return EMPTY_PR_STATS;
    case AgentDashboardDbIpcChannel.GetSession:
    case AgentDashboardDbIpcChannel.GetSessionDetails:
      return undefined;
    case AgentDashboardDbIpcChannel.GetCatalogEntry:
    case AgentDashboardDbIpcChannel.GetCatalogContents:
    case AgentDashboardDbIpcChannel.GetPlan:
      return null;
    case AgentDashboardDbIpcChannel.CatalogInstall:
    case AgentDashboardDbIpcChannel.CatalogUninstall:
      return DISABLED_MUTATION_RESULT;
    case CATALOG_CONVERT_INSTALL_CHANNEL:
      return DISABLED_CONVERT_INSTALL_RESULT;
    case AgentDashboardDbIpcChannel.CatalogRefresh:
    case AgentDashboardDbIpcChannel.ConfirmPlan:
    case AgentDashboardDbIpcChannel.RejectPlan:
    case AgentDashboardDbIpcChannel.OpenPlan:
    case AgentDashboardDbIpcChannel.OpenPr:
      return undefined;
    case AgentDashboardDbIpcChannel.GetDiagnostics:
      return EMPTY_DIAGNOSTICS;
    case AgentDashboardDbIpcChannel.GetComponentModelTrend:
      return { componentKind: "", componentKey: "", windowDays: 0, points: [] };
    case AgentDashboardDbIpcChannel.GetSubagentFrequency:
      return { subagentKey: "", windowDays: 0, points: [] };
    case AgentDashboardDbIpcChannel.IsSkillLoaded:
      return {
        skillKey: "",
        existsInInventory: false,
        hasUsage: false,
        totalInvocations: 0,
        lastUsedAt: null,
      };
    case SHARED_AGENT_COMPONENTS_IPC_CHANNELS.list:
      return emptyAgentComponentsListResponse();
    case SHARED_AGENT_COMPONENTS_IPC_CHANNELS.detail:
      return null;
    // ISS-6822: the disabled/degraded bounded read answers with the same empty
    // population the `list` channel does, in the page-data shape.
    case SHARED_AGENT_COMPONENTS_IPC_CHANNELS.pageData:
      return emptyAgentComponentsPageDataResponse();
    // ISS-10467: `null` is the same NOT-FOUND the detail channel answers with,
    // and it is the honest one — with the runtime disabled nothing was read, so
    // an entry carrying `0` invocations would assert this revision ran nothing.
    case SHARED_AGENT_COMPONENTS_IPC_CHANNELS.versionUsage:
    case SHARED_AGENT_COMPONENTS_IPC_CHANNELS.frequency:
      return null;
    // ISS-7830: with the runtime disabled nothing was persisted, and the honest
    // answer says so. Falling through to the `[]` default would hand the renderer
    // a value whose `recorded` is `undefined` — neither true nor a refusal.
    case THREAD_VIEWED_CHANNEL:
      return { recorded: false } satisfies ThreadViewedResult;
    // ISS-10332: with the runtime disabled there is no local row to write, and
    // the answer says so rather than falling through to the `[]` default.
    case LOCAL_SESSION_PRIORITY_WRITE_CHANNEL:
    case LOCAL_BRANCH_PRIORITY_WRITE_CHANNEL:
      return {
        status: LocalPriorityWriteStatus.NotFound,
      } satisfies LocalPriorityWriteResult;
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
    // ISS-9857: a page past a detail nothing can serve fails closed exactly as
    // the detail does — the renderer's local source reads `null` as not-found.
    case SHARED_AGENT_SESSIONS_IPC_CHANNELS.events:
      return null;
    // ISS-10737: a tree nothing can serve fails closed exactly as the detail
    // does. `null` is "this source cannot tell you", which the renderer keeps
    // distinct from an empty tree — a session that genuinely ran no components.
    case SHARED_AGENT_SESSIONS_IPC_CHANNELS.invocationTree:
      return null;
    // ISS-9802: with the runtime disabled there is no in-flight read to cancel,
    // so nothing was forwarded and the answer says exactly that. Answering
    // `true` would report a cancellation that reached no work.
    case SHARED_AGENT_SESSIONS_IPC_CHANNELS.cancelRead:
      return { requested: false } satisfies SharedAgentSessionsCancelReadResult;
    // ISS-8143: an exhaustiveness guard, not a fallback. This switch already
    // covers the whole union, so the old `return emptySharedAgentSessionsList…`
    // arm was unreachable AND harmful: it let a NEWLY added shared channel
    // compile while silently answering with the LIST shape, instead of failing
    // typecheck until someone maps it.
    default: {
      const unmapped: never = channel;
      throw new Error(
        `Unmapped shared agent-sessions IPC channel: ${String(unmapped)}`
      );
    }
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
    // ISS-8143: exhaustiveness guard — see the twin above.
    default: {
      const unmapped: never = channel;
      throw new Error(
        `Unmapped shared-branches IPC channel: ${String(unmapped)}`
      );
    }
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
      // ISS-8184: both vocabularies need an empty state, or a disabled dashboard
      // silently changes which empty sentence it shows when the flag flips.
      locTrend: EMPTY_TIME_SERIES,
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
