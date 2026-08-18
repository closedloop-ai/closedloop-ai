import type { SessionQuality } from "@repo/api/src/agent-session-filters";
import type {
  AgentSessionAnalytics,
  AgentSessionDetail,
  AgentSessionHarnessBreakdown,
  AgentSessionListItem,
  AgentSessionListResponse,
  AgentSessionsPageData,
  AgentSessionUsageByModel,
  AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session";
import type {
  AgentSessionAgentTypeBreakdown,
  AgentSessionRepositoryBreakdown,
  AgentSessionToolBreakdown,
} from "@repo/api/src/types/agent-session-usage-breakdown";

export const SHARED_AGENT_SESSIONS_IPC_CHANNELS = {
  list: "desktop:shared-agent-sessions:list",
  detail: "desktop:shared-agent-sessions:detail",
  usage: "desktop:shared-agent-sessions:usage",
  analytics: "desktop:shared-agent-sessions:analytics",
  // FEA-4157: combined list + usage read (mirrors the branches `pageData`
  // channel) so the table and the summary cards share one raw scan.
  pageData: "desktop:shared-agent-sessions:page-data",
} as const;

export const SHARED_AGENT_SESSIONS_IPC_CHANNEL_LIST = [
  SHARED_AGENT_SESSIONS_IPC_CHANNELS.list,
  SHARED_AGENT_SESSIONS_IPC_CHANNELS.detail,
  SHARED_AGENT_SESSIONS_IPC_CHANNELS.usage,
  SHARED_AGENT_SESSIONS_IPC_CHANNELS.analytics,
  SHARED_AGENT_SESSIONS_IPC_CHANNELS.pageData,
] as const;

/** Display label for local Desktop sessions that have no reliable user profile. */
export const DESKTOP_LOCAL_SESSION_AUTHOR_LABEL = "Local Desktop session";

export type SharedAgentSessionsIpcChannel =
  (typeof SHARED_AGENT_SESSIONS_IPC_CHANNEL_LIST)[number];

export type SharedAgentSessionsQuery = {
  startDate?: string;
  endDate?: string;
  /**
   * FEA-3009: completion-time lower bound. Keeps only sessions that COMPLETED
   * (reached a terminal `endedAt`) at or after this ISO instant — mirrors the
   * cloud `completedAfter` param so the "completed since I last opened Agents"
   * badge counts the same completion boundary on desktop and web. Distinct from
   * `startDate`, which desktop filters on `startedAt`; still-running sessions
   * (no `endedAt`) are excluded.
   */
  completedAfter?: string;
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
  /** Harness/model multi-select facets + autonomy-tier / cost-bucket id facets. */
  harnesses?: readonly string[];
  models?: readonly string[];
  autonomyTiers?: readonly string[];
  costBuckets?: readonly string[];
  /** Change-presence id facet ("has_changes"/"no_changes") + PR-association id facet ("has_pr"/"no_pr"). */
  changePresence?: readonly string[];
  prAssociation?: readonly string[];
  /**
   * FEA-3284/FEA-3345/FEA-4145 session quality: `substantive` (idle/phantom rows
   * hidden), `idle` (only idle/phantom rows), or `all` (both). Absent = the
   * fail-open `all` default (`DEFAULT_SESSION_QUALITY`). Mirrors the cloud
   * `quality` param so the desktop Sessions view behaves identically.
   */
  quality?: SessionQuality;
  /**
   * FEA-4142: count-only projection hint (the Agents sidebar activity badge). A
   * count-only read returns just `total` (empty `items`) and, when the query
   * reduces to a metadata-only SQL predicate, resolves it with a single
   * `COUNT(*)` instead of hydrating the session corpus into JS — the FEA-2038
   * desktop analytics invariant. Ignored (falls back to the normal hydrated
   * read) for any query that isn't count-expressible.
   */
  countOnly?: boolean;
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
export type SharedAgentSessionsPageDataResponse = AgentSessionsPageData;

export const SHARED_AGENT_SESSIONS_NOT_FOUND_CODE =
  "LOCAL_AGENT_SESSION_NOT_FOUND" as const;
export const SHARED_AGENT_SESSIONS_SOURCE_ERROR_CODE =
  "LOCAL_AGENT_SESSIONS_SOURCE_ERROR" as const;
/**
 * ISS-4483: the error code stamped on a TRANSIENT local-source read failure — the
 * db-host child restarting / crash-looping mid-backfill (ISS-4476 / ISS-4474 /
 * ISS-4410), or still importing — as distinct from
 * {@link SHARED_AGENT_SESSIONS_SOURCE_ERROR_CODE}, a genuine persistent failure. A
 * transient read is expected to recover on its own once the child re-forks, so the
 * renderer auto-retries it (bounded backoff) and, if it must show anything, renders
 * the quiet "reconnecting / still importing" holding surface — never the hard
 * "something went wrong" error card. Only a persistent failure surfaces that.
 */
export const SHARED_AGENT_SESSIONS_TRANSIENT_ERROR_CODE =
  "LOCAL_AGENT_SESSIONS_SOURCE_TRANSIENT" as const;

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
    // ISS-4773 (wongk review): this build CAN split the bucket, so the empty
    // response must say so with explicit zeroes. Omitting them is the wire
    // signal for "producer predates ISS-4773", which would make a CURRENT
    // Desktop's empty/disabled IPC state fall back to the pre-ISS-4773
    // presentation — the Cost card flipping to "cost" purely
    // because the read was empty. Absent means "cannot split", never "nothing".
    meteredEstimatedCost: 0,
    unknownEstimatedCost: 0,
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

/**
 * Empty canonical combined page-data response (FEA-4157) for disabled or
 * unsupported local reads — the empty list + empty usage summary. Mirrors the
 * branches `emptySharedBranchesPageDataResponse`.
 */
export function emptySharedAgentSessionsPageDataResponse(): SharedAgentSessionsPageDataResponse {
  return {
    list: emptySharedAgentSessionsListResponse(),
    usage: emptySharedAgentSessionsUsageSummary(),
  };
}

/**
 * The `byHarness` bucket a session with no recorded harness folds into.
 *
 * Both usage folds key a NULL harness here, and the SQL fast path additionally
 * merges a literal `"unknown"` column value into the same bucket — so the bucket
 * is a mix of "we never recorded one" and "the row said unknown", never a real
 * harness. Consumers that present harnesses to a user (ISS-5112's tour summary)
 * exclude it rather than render it as a discovered tool.
 */
export const UNKNOWN_HARNESS_BUCKET = "unknown";
