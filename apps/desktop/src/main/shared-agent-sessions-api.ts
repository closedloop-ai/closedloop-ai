import os from "node:os";
import {
  deriveAgentSessionFallbackState,
  projectAgentSessionTimelineEvents,
  projectAgentSessionTurnItems,
} from "@repo/api/src/agent-session-detail-projection";
import { ERROR_EVENT_PATTERN } from "@repo/api/src/agent-session-events";
import {
  AGENT_FAILED_STATUS_PATTERN as FAILED_STATUS_PATTERN,
  AGENT_SUCCESS_STATUS_PATTERN as SUCCESS_STATUS_PATTERN,
} from "@repo/api/src/agent-session-status";
import {
  type BillingLedger,
  billingLedger,
  normalizeBillingMode,
} from "../shared/billing-mode.js";
import {
  DESKTOP_LOCAL_SESSION_AUTHOR_LABEL,
  emptySharedAgentSessionsAnalytics,
  emptySharedAgentSessionsListResponse,
  emptySharedAgentSessionsUsageSummary,
  type SharedAgentSessionAgentTypeBreakdown,
  type SharedAgentSessionAnalytics,
  type SharedAgentSessionDetail,
  type SharedAgentSessionHarnessBreakdown,
  type SharedAgentSessionListItem,
  type SharedAgentSessionListResponse,
  type SharedAgentSessionRepositoryBreakdown,
  type SharedAgentSessionsListRequest,
  type SharedAgentSessionsQuery,
  type SharedAgentSessionToolBreakdown,
  type SharedAgentSessionUsageByModel,
  type SharedAgentSessionUsageSummary,
} from "../shared/shared-agent-sessions-contract.js";
import type { SyncedAgentSession } from "./agent-session-sync-contract.js";
import {
  type AgentSessionAnalyticsAggregate,
  type AgentSessionSyncSource,
  type AgentSessionUsageAggregate,
  resolveBillingModeForRow,
  type SessionAttributionResolverCache,
  SessionListCursorSortKey,
} from "./agent-session-sync-service.js";

const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;
const LOCAL_COMPUTE_TARGET_ID = "local-desktop";
const LOCAL_COMPUTE_TARGET_NAME = os.hostname() || "Local Desktop";
const TERMINAL_SHARED_STATUSES = new Set(["abandoned", "completed", "failed"]);
const LOCAL_AGENT_SESSION_ORIGIN = "DESKTOP_SYNC" satisfies NonNullable<
  SharedAgentSessionListItem["origin"]
>;

type SanitizedQuery = {
  startDate: Date | null;
  endDate: Date | null;
  harness: string | null;
  status: string | null;
  statuses: string[];
  repositories: string[];
  search: string | null;
  limit: number;
  offset: number;
  sortBy: string | null;
  sortDir: "asc" | "desc";
  hasUnsupportedCloudFilter: boolean;
};

type SessionTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
};

type WorkingSetOptions = {
  applyPagination: boolean;
};

type SessionListCursorPageResult = {
  rows: { id: string }[];
  total: number;
};

/**
 * Creates the per-request attribution cache used by local shared-session API
 * reads. The cache is intentionally not shared with the sync service so a
 * renderer read cannot observe or mutate long-lived sync attribution state.
 */
export function createSessionAttributionResolverCache(): SessionAttributionResolverCache {
  return {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
}

/**
 * Project local SQLite-backed sessions into the canonical shared API list
 * response. Cursor rows own ordering for no-ID reads; loaded rows own every
 * payload field and are reassembled by cursor or explicit caller order before
 * filters, totals, or pagination run.
 */
export async function getSharedAgentSessions(
  source: AgentSessionSyncSource | null | undefined,
  request: SharedAgentSessionsListRequest = {}
): Promise<SharedAgentSessionListResponse> {
  if (!source) {
    return emptySharedAgentSessionsListResponse();
  }

  const query = sanitizeQuery(request);
  if (query.hasUnsupportedCloudFilter) {
    return emptySharedAgentSessionsListResponse();
  }

  const workingSet = await loadWorkingSessions(source, request, query, {
    applyPagination: true,
  });

  return {
    items: workingSet.page.map(mapListItem),
    total: workingSet.total,
    viewerScope: "self",
  };
}

/**
 * Project one local session into the canonical detail response. A missing or
 * stale loaded row returns `null`; callers translate that into a typed 404 at
 * the IPC/fetch boundary instead of synthesizing a partial DTO from cursor data.
 */
export async function getSharedAgentSessionDetail(
  source: AgentSessionSyncSource | null | undefined,
  id: unknown
): Promise<SharedAgentSessionDetail | null> {
  if (!source) {
    return null;
  }
  const sessionId = coerceNonEmptyString(id);
  if (!sessionId) {
    return null;
  }

  const cache = createSessionAttributionResolverCache();
  const loaded = await source.loadSyncedSessions([sessionId], cache);
  const session = indexSessionsById(loaded).get(sessionId);
  return session ? mapDetail(session) : null;
}

/**
 * Aggregate local sessions into the canonical usage summary. Unsupported
 * cloud-only filters fail closed with an empty response; supported filters use
 * the same deterministic working set as list reads without list pagination.
 */
export async function getSharedAgentSessionUsage(
  source: AgentSessionSyncSource | null | undefined,
  request: SharedAgentSessionsQuery = {}
): Promise<SharedAgentSessionUsageSummary> {
  if (!source) {
    return emptySharedAgentSessionsUsageSummary();
  }

  const query = sanitizeQuery(request);
  if (query.hasUnsupportedCloudFilter) {
    return emptySharedAgentSessionsUsageSummary();
  }

  // FEA-1834 / PLN-941 §4: prefer the O(grouped) SQL aggregation — the summary
  // never hydrates the corpus on the live cadence. Skipped for explicit-id
  // requests (the aggregation filters by harness/status/date, not ids) and for
  // free-text search (the aggregation cannot match the hydrated
  // repositoryFullName/baseBranch fields), both of which fall through to the
  // hydrate path below so usage filtering stays identical to list filtering.
  if (
    source.aggregateUsage &&
    !Object.hasOwn(request, "ids") &&
    query.search === null
  ) {
    const aggregate = await source.aggregateUsage({
      harness: query.harness ?? undefined,
      status: query.status ?? undefined,
      startDate: query.startDate ?? undefined,
      endDate: query.endDate ?? undefined,
    });
    return foldUsageAggregate(aggregate);
  }

  // FEA-1834: prefer the lightweight usage load (session metadata +
  // tokenUsageByModel only) when the source supports it. Mirrors the
  // non-paginated `loadWorkingSessions` path exactly — same ordered ids, same
  // re-index/rebuild from `orderedIds`, same `matchesQuery` filter, same
  // `buildUsageSummary` fold — but skips the agents/events hydration so the
  // summary stays cheap on the live cadence. Rebuilding from `orderedIds`
  // (rather than trusting the source's return order) keeps the result identical
  // to the full path even if a source returns DB-natural order or extra rows.
  // Skip the lightweight path when a free-text search is active: those rows are
  // built with `resolveAttribution: () => undefined`, so a search matching only
  // repositoryFullName/baseBranch would mis-filter usage totals. Fall through to
  // the fully-hydrated `loadWorkingSessions` path so usage search matches list search.
  if (source.loadUsageSessions && query.search === null) {
    const orderedIds = await resolveOrderedIds(source, request);
    if (orderedIds.length === 0) {
      return emptySharedAgentSessionsUsageSummary();
    }
    const loaded = await source.loadUsageSessions(orderedIds);
    const loadedById = indexSessionsById(loaded);
    const ordered = orderedIds.flatMap((id) => {
      const session = loadedById.get(id);
      return session ? [session] : [];
    });
    const filtered = ordered.filter((session) => matchesQuery(session, query));
    return buildUsageSummary(filtered);
  }

  const { filtered } = await loadWorkingSessions(source, request, query, {
    applyPagination: false,
  });
  return buildUsageSummary(filtered);
}

/**
 * Aggregate local sessions into the canonical analytics response. Local
 * desktop cannot resolve cloud projects, so `byProject` is intentionally empty
 * while tools, agent types, and repository/worktree buckets derive from loaded
 * rows.
 */
export async function getSharedAgentSessionAnalytics(
  source: AgentSessionSyncSource | null | undefined,
  request: SharedAgentSessionsQuery = {}
): Promise<SharedAgentSessionAnalytics> {
  if (!source) {
    return emptySharedAgentSessionsAnalytics();
  }

  const query = sanitizeQuery(request);
  if (query.hasUnsupportedCloudFilter) {
    return emptySharedAgentSessionsAnalytics();
  }

  // FEA-2038: prefer the O(grouped) SQL aggregation — analytics never hydrates
  // the whole filtered session/event/agent/token corpus into JS (the db-host
  // OOM, exit code 5). Skipped for explicit-id requests (the aggregation filters
  // by harness/status/date, not ids) and for free-text search (the aggregation
  // cannot match the hydrated repositoryFullName/baseBranch fields); both fall
  // through to the hydrate path below so analytics filtering stays identical to
  // list filtering.
  if (
    source.aggregateAnalytics &&
    !Object.hasOwn(request, "ids") &&
    query.search === null
  ) {
    const cache = createSessionAttributionResolverCache();
    const aggregate = await source.aggregateAnalytics(
      {
        harness: query.harness ?? undefined,
        status: query.status ?? undefined,
        startDate: query.startDate ?? undefined,
        endDate: query.endDate ?? undefined,
      },
      cache
    );
    return foldAnalyticsAggregate(aggregate);
  }

  const { filtered } = await loadWorkingSessions(source, request, query, {
    applyPagination: false,
  });
  return buildAnalytics(filtered);
}

/**
 * FEA-2038: fold the O(grouped) analytics aggregate into the canonical
 * `SharedAgentSessionAnalytics`. The aggregate's byTool/byRepository rows map
 * 1:1 to the contract shape; byAgentType converts the SQL duration fold
 * (durationTotalMs/durationCount) into `avgDurationMs` and omits those two
 * fields, matching `buildAgentTypeBreakdowns`. `byProject` is empty (local
 * desktop cannot resolve cloud projects), matching `buildAnalytics`.
 */
function foldAnalyticsAggregate(
  aggregate: AgentSessionAnalyticsAggregate
): SharedAgentSessionAnalytics {
  return {
    viewerScope: "self",
    byTool: aggregate.byTool.map((group) => ({
      toolName: group.toolName,
      invocationCount: group.invocationCount,
      errorCount: group.errorCount,
      sessionCount: group.sessionCount,
    })),
    byAgentType: aggregate.byAgentType.map((group) => ({
      agentType: group.agentType,
      count: group.count,
      successCount: group.successCount,
      failedCount: group.failedCount,
      avgDurationMs:
        group.durationCount > 0
          ? group.durationTotalMs / group.durationCount
          : null,
    })),
    byRepository: aggregate.byRepository.map((group) => ({
      repositoryFullName: group.repositoryFullName,
      sessionCount: group.sessionCount,
      inputTokens: group.inputTokens,
      outputTokens: group.outputTokens,
      estimatedCost: group.estimatedCost,
      errorCount: group.errorCount,
    })),
    byProject: [],
  };
}

async function loadWorkingSessions(
  source: AgentSessionSyncSource,
  request: SharedAgentSessionsListRequest,
  query: SanitizedQuery,
  options: WorkingSetOptions
): Promise<{
  ordered: SyncedAgentSession[];
  filtered: SyncedAgentSession[];
  page: SyncedAgentSession[];
  total: number;
}> {
  const cursorPage =
    options.applyPagination &&
    (await loadCursorPageBeforeHydration(source, request, query));
  if (cursorPage) {
    const page = await loadOrderedPage(
      source,
      cursorPage.rows.map((row) => row.id)
    );
    return {
      ordered: page,
      filtered: page,
      page,
      total: cursorPage.total,
    };
  }

  const orderedIds = await resolveOrderedIds(source, request);
  if (orderedIds.length === 0) {
    return { ordered: [], filtered: [], page: [], total: 0 };
  }
  if (options.applyPagination && canPageBeforeLoading(request, query)) {
    const pageIds = orderedIds.slice(query.offset, query.offset + query.limit);
    const page = await loadOrderedPage(source, pageIds);
    return {
      ordered: page,
      filtered: page,
      page,
      total: orderedIds.length,
    };
  }
  const cache = createSessionAttributionResolverCache();
  // FEA-2038: same as the paged branch above — this full-corpus hydration feeds
  // only the event-data-free folds (list/analytics/usage), so omit `event.data`
  // to keep peak memory flat as the corpus grows.
  const loaded = await source.loadSyncedSessions(orderedIds, cache, {
    omitEventData: true,
  });
  const loadedById = indexSessionsById(loaded);
  const ordered = orderedIds.flatMap((id) => {
    const session = loadedById.get(id);
    return session ? [session] : [];
  });
  const filtered = sortSyncedSessions(
    ordered.filter((session) => matchesQuery(session, query)),
    query
  );
  const total = filtered.length;
  const page = options.applyPagination
    ? filtered.slice(query.offset, query.offset + query.limit)
    : filtered;

  return { ordered, filtered, page, total };
}

async function loadOrderedPage(
  source: AgentSessionSyncSource,
  pageIds: string[]
): Promise<SyncedAgentSession[]> {
  const cache = createSessionAttributionResolverCache();
  // FEA-2038: the list/analytics/usage working set is folded by mapListItem /
  // matchesQuery / buildUsageSummary / buildAnalytics, none of which read
  // `event.data`. Drop the heavy event `data` blob so loading a page never
  // retains every event payload at once (the db-host OOM). The detail path
  // hydrates with full data via its own loadSyncedSessions call.
  const loaded = await source.loadSyncedSessions(pageIds, cache, {
    omitEventData: true,
  });
  const loadedById = indexSessionsById(loaded);
  return pageIds.flatMap((id) => {
    const session = loadedById.get(id);
    return session ? [session] : [];
  });
}

function canPageBeforeLoading(
  request: SharedAgentSessionsListRequest,
  query: SanitizedQuery
): boolean {
  return (
    !Object.hasOwn(request, "ids") &&
    query.startDate === null &&
    query.endDate === null &&
    query.harness === null &&
    query.status === null &&
    query.statuses.length === 0 &&
    query.repositories.length === 0 &&
    query.sortBy === null &&
    query.search === null
  );
}

function loadCursorPageBeforeHydration(
  source: AgentSessionSyncSource,
  request: SharedAgentSessionsListRequest,
  query: SanitizedQuery
): SessionListCursorPageResult | Promise<SessionListCursorPageResult> | null {
  if (!(source.listSessionCursorPage && canUseListCursorPage(request, query))) {
    return null;
  }
  return source.listSessionCursorPage({
    limit: query.limit,
    offset: query.offset,
    sortBy: query.sortBy,
    sortDir: query.sortDir,
    ...(query.startDate ? { startDate: query.startDate } : {}),
    ...(query.endDate ? { endDate: query.endDate } : {}),
    ...(query.search ? { search: query.search } : {}),
  });
}

function canUseListCursorPage(
  request: SharedAgentSessionsListRequest,
  query: SanitizedQuery
): query is SanitizedQuery & { sortBy: SessionListCursorSortKey } {
  return (
    !Object.hasOwn(request, "ids") &&
    query.harness === null &&
    query.status === null &&
    query.statuses.length === 0 &&
    query.repositories.length === 0 &&
    (query.sortBy === SessionListCursorSortKey.LastActivity ||
      query.sortBy === SessionListCursorSortKey.Started)
  );
}

async function resolveOrderedIds(
  source: AgentSessionSyncSource,
  request: SharedAgentSessionsListRequest
): Promise<string[]> {
  const explicitIds = explicitIdsFromRequest(request);
  if (explicitIds !== null) {
    return explicitIds;
  }
  const rows = await source.listAllSessionCursorRows();
  return sanitizeIds(
    rows.map((row) => row.id),
    { limit: null }
  );
}

function explicitIdsFromRequest(
  request: SharedAgentSessionsListRequest
): string[] | null {
  if (!Object.hasOwn(request, "ids")) {
    return null;
  }
  const ids = (request as { ids?: unknown }).ids;
  return Array.isArray(ids) ? sanitizeIds(ids, { limit: MAX_LIST_LIMIT }) : [];
}

function sanitizeIds(
  ids: readonly unknown[],
  options: { limit: number | null }
): string[] {
  const seen = new Set<string>();
  const sanitized: string[] = [];
  for (const value of ids) {
    const id = coerceNonEmptyString(value);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    sanitized.push(id);
    if (options.limit !== null && sanitized.length >= options.limit) {
      break;
    }
  }
  return sanitized;
}

function sanitizeQuery(query: SharedAgentSessionsQuery): SanitizedQuery {
  return {
    startDate: parseOptionalDate(query.startDate, "startDate"),
    endDate: parseOptionalDate(query.endDate, "endDate"),
    harness: coerceOptionalString(query.harness),
    status: coerceOptionalString(query.status),
    statuses: coerceStringArray(query.statuses),
    repositories: coerceStringArray(query.repositories),
    search: coerceOptionalString(query.search),
    limit: clampLimit(query.limit),
    offset: clampOffset(query.offset),
    sortBy: coerceOptionalString(query.sortBy),
    sortDir: query.sortDir === "asc" ? "asc" : "desc",
    hasUnsupportedCloudFilter: hasUnsupportedCloudFilter(query),
  };
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    const text = coerceNonEmptyString(entry);
    if (text && !seen.has(text)) {
      seen.add(text);
      result.push(text);
    }
  }
  return result;
}

function matchesQuery(
  session: SyncedAgentSession,
  query: SanitizedQuery
): boolean {
  if (query.harness && session.harness !== query.harness) {
    return false;
  }
  // Multi-select status: match if ANY selected status matches (single `status`
  // stays as a back-compat fallback when no multi-select set is present).
  if (
    query.statuses.length > 0 &&
    !query.statuses.some((status) => matchesStatusFilter(session, status))
  ) {
    return false;
  }
  if (
    query.statuses.length === 0 &&
    query.status &&
    !matchesStatusFilter(session, query.status)
  ) {
    return false;
  }
  if (
    query.repositories.length > 0 &&
    !query.repositories.includes(sessionRepositoryName(session))
  ) {
    return false;
  }
  if (query.search && !matchesSearch(session, query.search)) {
    return false;
  }
  const startedAt = parseSessionDate(session.startedAt);
  if (query.startDate && startedAt < query.startDate) {
    return false;
  }
  if (query.endDate && startedAt > query.endDate) {
    return false;
  }
  return true;
}

/** Repo identity used for the Repository facet — mirrors `buildRepositoryBreakdowns`. */
function sessionRepositoryName(session: SyncedAgentSession): string {
  return (
    session.attribution?.repositoryFullName ??
    session.attribution?.worktreePath ??
    session.cwd ??
    "unknown"
  );
}

/**
 * Sort the filtered working set by a column id (matching the table headers).
 * Returns a new array; an unset `sortBy` preserves the incoming cursor order.
 */
function sortSyncedSessions(
  sessions: SyncedAgentSession[],
  query: SanitizedQuery
): SyncedAgentSession[] {
  if (!query.sortBy) {
    return sessions;
  }
  const factor = query.sortDir === "asc" ? 1 : -1;
  const sortKey = query.sortBy;
  return [...sessions].sort((a, b) => compareSessions(a, b, sortKey) * factor);
}

function compareSessions(
  a: SyncedAgentSession,
  b: SyncedAgentSession,
  sortKey: string
): number {
  switch (sortKey) {
    case "status":
      return canonicalSharedStatus(a.status).localeCompare(
        canonicalSharedStatus(b.status)
      );
    case "repo":
      return sessionRepositoryName(a).localeCompare(sessionRepositoryName(b));
    case "harness":
      return (a.harness ?? "").localeCompare(b.harness ?? "");
    case "model":
      return (a.model ?? "").localeCompare(b.model ?? "");
    case "user":
      // Desktop list items carry no per-row user identity (the User column is a
      // constant local-author label), so there is nothing name-bearing to order
      // by — keep a stable order rather than sorting by the opaque userId.
      return 0;
    case "cost":
      return sumTokenUsage(a).estimatedCost - sumTokenUsage(b).estimatedCost;
    case "duration":
      return sessionDurationMs(a) - sessionDurationMs(b);
    case "lastActivity":
      // PLN-1034: genuine activity, falling back to the start time when a
      // session has no events yet (matches the cloud's floored derivation).
      return (
        parseSessionDate(a.lastActivityAt ?? a.startedAt).getTime() -
        parseSessionDate(b.lastActivityAt ?? b.startedAt).getTime()
      );
    default:
      return (
        parseSessionDate(a.startedAt).getTime() -
        parseSessionDate(b.startedAt).getTime()
      );
  }
}

function sessionDurationMs(session: SyncedAgentSession): number {
  if (!session.endedAt) {
    return 0;
  }
  const ended = parseSessionDate(session.endedAt).getTime();
  const started = parseSessionDate(session.startedAt).getTime();
  return Math.max(0, ended - started);
}

function mapListItem(session: SyncedAgentSession): SharedAgentSessionListItem {
  const totals = sumTokenUsage(session);
  const attribution = session.attribution ?? null;
  const updatedAt = parseSessionDate(session.updatedAt);
  const status = canonicalSharedStatus(session.status);
  const prs = session.prs ?? [];
  const primaryModel = session.model ?? null;
  const toolUseCount = countToolUseEvents(session.events);

  return {
    ...buildLocalSessionIdentity(
      session,
      attribution,
      status,
      primaryModel,
      prs
    ),
    ...buildLocalSessionTraceFields(session, totals, prs, toolUseCount),
    ...buildLocalSessionTimingAndUsage(
      session,
      totals,
      updatedAt,
      toolUseCount
    ),
    ...buildLocalSessionRelations(attribution, updatedAt),
    // PLN-1034: genuine activity, floored at the start for event-less sessions.
    lastActivityAt: parseSessionDate(
      session.lastActivityAt ?? session.startedAt
    ),
  };
}

function buildLocalSessionIdentity(
  session: SyncedAgentSession,
  attribution: SyncedAgentSession["attribution"] | null,
  status: string,
  primaryModel: string | null,
  prs: NonNullable<SyncedAgentSession["prs"]>
): Pick<
  SharedAgentSessionListItem,
  | "branch"
  | "cwd"
  | "externalSessionId"
  | "harness"
  | "id"
  | "issues"
  | "model"
  | "models"
  | "name"
  | "origin"
  | "primaryModel"
  | "prs"
  | "repo"
  | "repositoryFullName"
  | "slug"
  | "state"
  | "status"
  | "worktreePath"
> {
  return {
    id: session.externalSessionId,
    slug: null,
    externalSessionId: session.externalSessionId,
    name: session.name ?? null,
    status,
    origin: LOCAL_AGENT_SESSION_ORIGIN,
    state: deriveAgentSessionFallbackState({
      status,
      awaitingInputSince: session.awaitingInputSince,
      endedAt: session.endedAt,
    }),
    harness: session.harness ?? "unknown",
    cwd: session.cwd ?? null,
    repositoryFullName: attribution?.repositoryFullName ?? null,
    repo: attribution?.repositoryFullName ?? null,
    worktreePath: attribution?.worktreePath ?? null,
    model: primaryModel,
    primaryModel,
    models: toSingleModelList(primaryModel),
    branch: resolveLocalSessionBranch(session, attribution),
    issues: session.issues ?? [],
    prs,
  };
}

function buildLocalSessionTraceFields(
  session: SyncedAgentSession,
  totals: SessionTotals,
  prs: NonNullable<SyncedAgentSession["prs"]>,
  toolUseCount: number
): Pick<
  SharedAgentSessionListItem,
  | "activeAgent"
  | "activityBuckets"
  | "autonomy"
  | "cache"
  | "cacheWrite"
  | "cost"
  | "filesChanged"
  | "gitDiffStats"
  | "branchDiffStats"
  | "linesAdded"
  | "linesRemoved"
  | "markers"
  | "phaseIterations"
  | "phaseLoopbacks"
  | "phases"
  | "prsMerged"
  | "span"
  | "steeringEpisodes"
  | "throttles"
  | "tokensIn"
  | "tokensOut"
  | "toolCallsTotal"
  | "turns"
  | "userColor"
  | "waitingUser"
  | "wallClock"
> {
  return {
    prsMerged: countMergedPullRequests(prs),
    cost: formatCurrency(totals.estimatedCost),
    wallClock: session.wallClock ?? null,
    activeAgent: session.activeAgent ?? null,
    waitingUser: session.waitingUser ?? null,
    linesAdded: session.linesAdded ?? null,
    linesRemoved: session.linesRemoved ?? null,
    filesChanged: session.filesChanged ?? null,
    gitDiffStats: session.gitDiffStats ?? null,
    branchDiffStats: session.branchDiffStats ?? null,
    turns: session.turns ?? null,
    toolCallsTotal: toolUseCount,
    steeringEpisodes: session.steeringEpisodes ?? null,
    autonomy: session.autonomy ?? null,
    tokensIn: totals.inputTokens,
    tokensOut: totals.outputTokens,
    cache: totals.cacheReadTokens,
    cacheWrite: totals.cacheWriteTokens,
    userColor: null,
    activityBuckets: session.activityBuckets ?? [],
    span: session.span ?? null,
    markers: session.markers ?? [],
    throttles: session.throttles ?? [],
    phases: session.phases ?? [],
    phaseIterations: session.phaseIterations ?? {},
    phaseLoopbacks: session.phaseLoopbacks ?? [],
  };
}

function buildLocalSessionTimingAndUsage(
  session: SyncedAgentSession,
  totals: SessionTotals,
  updatedAt: Date,
  toolUseCount: number
): Pick<
  SharedAgentSessionListItem,
  | "agentCount"
  | "awaitingInputSince"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "endedAt"
  | "errorCount"
  | "estimatedCost"
  | "inputTokens"
  | "outputTokens"
  | "startedAt"
  | "toolUseCount"
  | "updatedAt"
> {
  return {
    startedAt: parseSessionDate(session.startedAt),
    updatedAt,
    endedAt: parseNullableSessionDate(session.endedAt),
    awaitingInputSince: parseNullableSessionDate(session.awaitingInputSince),
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    estimatedCost: totals.estimatedCost,
    agentCount: session.agents.length,
    toolUseCount,
    errorCount: countErrorEvents(session.events),
  };
}

function buildLocalSessionRelations(
  attribution: SyncedAgentSession["attribution"] | null,
  updatedAt: Date
): Pick<
  SharedAgentSessionListItem,
  | "baseBranch"
  | "computeTarget"
  | "issueId"
  | "project"
  | "sourceArtifact"
  | "sourceArtifactId"
  | "sourceLoopId"
  | "user"
> {
  return {
    issueId: attribution?.issueId ?? null,
    baseBranch: attribution?.baseBranch ?? null,
    sourceArtifactId: attribution?.sourceArtifactId ?? null,
    sourceArtifact: null,
    sourceLoopId: attribution?.sourceLoopId ?? null,
    user: null,
    computeTarget: {
      id: LOCAL_COMPUTE_TARGET_ID,
      machineName: LOCAL_COMPUTE_TARGET_NAME,
      isOnline: true,
      lastSeenAt: updatedAt,
    },
    project: null,
  };
}

function toSingleModelList(model: string | null): string[] {
  if (!model) {
    return [];
  }
  return [model];
}

function resolveLocalSessionBranch(
  session: SyncedAgentSession,
  attribution: SyncedAgentSession["attribution"] | null
): string | null {
  return session.branch ?? attribution?.baseBranch ?? null;
}

function countMergedPullRequests(
  prs: NonNullable<SyncedAgentSession["prs"]>
): number {
  return prs.filter((pr) => pr.status.toLowerCase() === "merged").length;
}

function countToolUseEvents(events: SyncedAgentSession["events"]): number {
  return events.filter((event) => Boolean(event.toolName)).length;
}

function mapDetail(session: SyncedAgentSession): SharedAgentSessionDetail {
  const timeline = projectAgentSessionTimelineEvents(session.events, {
    metadata: session.metadata,
  });
  return {
    ...mapListItem(session),
    metadata: session.metadata ?? null,
    sourceArtifactId: session.attribution?.sourceArtifactId ?? null,
    sourceLoopId: session.attribution?.sourceLoopId ?? null,
    tokenUsageByModel: session.tokenUsageByModel,
    attribution: session.attribution ?? null,
    agents: session.agents,
    events: session.events,
    timeline,
    turnItems: projectAgentSessionTurnItems({
      sessionId: session.externalSessionId,
      harness: session.harness ?? "unknown",
      primaryModel: session.model ?? null,
      humanActor: {
        name: DESKTOP_LOCAL_SESSION_AUTHOR_LABEL,
        color: "#64748B",
      },
      agents: session.agents,
      events: session.events,
      timeline,
      tokenUsageByModel: session.tokenUsageByModel,
    }),
  };
}

function formatCurrency(value: number): string | null {
  return value > 0
    ? new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(value)
    : null;
}

/**
 * Desktop local storage predates the shared Agent Sessions status vocabulary.
 * Normalize aliases at the local shared-API boundary so shared UI filters and
 * columns keep their canonical semantics without changing persisted rows.
 */
function canonicalSharedStatus(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === "error") {
    return "failed";
  }
  if (normalized === "running") {
    return "active";
  }
  return normalized;
}

// Free-text match over the session's own identity plus its repo/branch, so the
// top-left search finds a session by name, repository, or branch (sessions/branches).
function matchesSearch(session: SyncedAgentSession, search: string): boolean {
  const needle = search.toLowerCase();
  const haystack = [
    session.name,
    session.externalSessionId,
    session.harness,
    session.cwd,
    session.branch,
    session.attribution?.repositoryFullName,
    session.attribution?.baseBranch,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

function matchesStatusFilter(
  session: SyncedAgentSession,
  requestedStatus: string
): boolean {
  // Canonicalize the requested filter through the same alias map as the row
  // status so the single canonical cloud value the shared UI sends
  // (`SESSION_STATUS.ERROR` = "error") matches desktop-local rows whose
  // canonical-shared status is "failed". Legacy callers passing "failed"
  // directly keep working because the alias map is idempotent for "failed".
  const status = canonicalSharedStatus(requestedStatus);
  const canonicalStatus = canonicalSharedStatus(session.status);
  // Desktop stores waiting-for-user state as a timestamp on a non-terminal row,
  // not as a persisted session status.
  const isAwaitingInput =
    !TERMINAL_SHARED_STATUSES.has(canonicalStatus) &&
    Boolean(session.awaitingInputSince);

  if (status === "waiting") {
    return isAwaitingInput;
  }
  if (status === "active") {
    return canonicalStatus === "active" && !isAwaitingInput;
  }
  return canonicalStatus === status;
}

function buildUsageSummary(
  sessions: readonly SyncedAgentSession[]
): SharedAgentSessionUsageSummary {
  const byModel = new Map<
    string,
    SharedAgentSessionUsageByModel & { sessionIds: Set<string> }
  >();
  const byHarness = new Map<
    string,
    SharedAgentSessionHarnessBreakdown & { sessionIds: Set<string> }
  >();
  const totals: SessionTotals = zeroTotals();
  const ledgerTotals: Record<BillingLedger, number> = {
    metered: 0,
    subscription: 0,
    unknown: 0,
  };
  let earliestStartMs: number | null = null;
  let latestStartMs: number | null = null;

  for (const session of sessions) {
    // Bounds skip rows with no real start (NULL/empty/malformed), mirroring SQL
    // MIN/MAX (which ignore NULL) and the API's Prisma _min/_max. Folding the
    // epoch-1970 fallback in here instead would drag a single legacy row's
    // bound to "Jan 1, 1970" and disagree with the web path.
    const startMs = parseBoundsStartMs(session.startedAt);
    if (startMs !== null) {
      if (earliestStartMs === null || startMs < earliestStartMs) {
        earliestStartMs = startMs;
      }
      if (latestStartMs === null || startMs > latestStartMs) {
        latestStartMs = startMs;
      }
    }
    const sessionTotals = sumTokenUsage(session);
    addTotals(totals, sessionTotals);
    ledgerTotals[getSessionLedger(session)] += sessionTotals.estimatedCost;
    addSessionToHarnessBreakdown(byHarness, session, sessionTotals);

    for (const usage of session.tokenUsageByModel) {
      const model = usage.model || "unknown";
      const modelSummary = getOrCreateModelSummary(byModel, model);
      modelSummary.sessionIds.add(session.externalSessionId);
      modelSummary.inputTokens += usage.inputTokens;
      modelSummary.outputTokens += usage.outputTokens;
      modelSummary.cacheReadTokens += usage.cacheReadTokens;
      modelSummary.cacheWriteTokens += usage.cacheWriteTokens;
      modelSummary.estimatedCost += usage.estimatedCostUsd ?? 0;
    }
  }

  return {
    viewerScope: "self",
    totalSessions: sessions.length,
    earliestSessionAt:
      earliestStartMs === null ? null : new Date(earliestStartMs).toISOString(),
    latestSessionAt:
      latestStartMs === null ? null : new Date(latestStartMs).toISOString(),
    totalInputTokens: totals.inputTokens,
    totalOutputTokens: totals.outputTokens,
    totalCacheReadTokens: totals.cacheReadTokens,
    totalCacheWriteTokens: totals.cacheWriteTokens,
    totalEstimatedCost: ledgerTotals.metered + ledgerTotals.unknown,
    subscriptionEstimatedCost: ledgerTotals.subscription,
    apiEstimatedCost: ledgerTotals.metered + ledgerTotals.unknown,
    byUser: [],
    byModel: [...byModel.values()].map(stripSessionIds),
    byHarness: [...byHarness.values()].map(stripSessionIds),
    // Kept consistent with the O(grouped) aggregate path (which has no repo
    // rollup) so the two usage paths agree. The Repository facet on desktop is a
    // known limitation; analytics still exposes a repository breakdown.
    byRepository: [],
    lastSyncTargets: [],
  };
}

/**
 * Fold the O(grouped) usage aggregate (FEA-1834 / PLN-941 §4) into the canonical
 * summary, matching `buildUsageSummary` for the same corpus.
 *
 * Cost is folded from persisted token_usage estimates. The ledger bucket uses
 * `resolveBillingModeForRow` PER GROUP (billing mode is re-resolved from the live
 * environment, never read as the raw column — same as the hydrate path's
 * `session.billingMode`). `byHarness` is enumerated from `harnessSessionCounts`
 * so harnesses whose sessions carry zero token rows still appear with their
 * session count (the token join alone cannot see them).
 */
function foldUsageAggregate(
  aggregate: AgentSessionUsageAggregate
): SharedAgentSessionUsageSummary {
  const totals = zeroTotals();
  const ledgerTotals: Record<BillingLedger, number> = {
    metered: 0,
    subscription: 0,
    unknown: 0,
  };
  const byModel = new Map<string, SharedAgentSessionUsageByModel>();
  const byHarnessTokens = new Map<string, SessionTotals>();

  for (const group of aggregate.tokenGroups) {
    const cost = group.estimatedCostUsd ?? 0;

    totals.inputTokens += group.inputTokens;
    totals.outputTokens += group.outputTokens;
    totals.cacheReadTokens += group.cacheReadTokens;
    totals.cacheWriteTokens += group.cacheWriteTokens;

    const ledger = billingLedger(
      normalizeBillingMode(
        resolveBillingModeForRow({
          billing_mode: group.billingMode,
          harness: group.harness,
        })
      )
    );
    ledgerTotals[ledger] += cost;

    const modelKey = group.model || "unknown";
    const modelSummary = byModel.get(modelKey) ?? {
      model: modelKey,
      sessionCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCost: 0,
    };
    modelSummary.inputTokens += group.inputTokens;
    modelSummary.outputTokens += group.outputTokens;
    modelSummary.cacheReadTokens += group.cacheReadTokens;
    modelSummary.cacheWriteTokens += group.cacheWriteTokens;
    modelSummary.estimatedCost += cost;
    modelSummary.sessionCount += group.sessionCount;
    byModel.set(modelKey, modelSummary);

    const harnessKey = group.harness ?? "unknown";
    const harnessTokens = byHarnessTokens.get(harnessKey) ?? zeroTotals();
    harnessTokens.inputTokens += group.inputTokens;
    harnessTokens.outputTokens += group.outputTokens;
    harnessTokens.cacheReadTokens += group.cacheReadTokens;
    harnessTokens.cacheWriteTokens += group.cacheWriteTokens;
    harnessTokens.estimatedCost += cost;
    byHarnessTokens.set(harnessKey, harnessTokens);
  }

  // Normalize harness keys before assembling buckets. SQL groups by the raw
  // column, so a NULL harness and a literal "unknown" harness arrive as separate
  // rows; the hydrate path keys both under "unknown" (`session.harness ?? "unknown"`)
  // and merges them, so we sum their session counts into one bucket too —
  // otherwise byHarness would carry duplicate "unknown" entries.
  const harnessSessionCounts = new Map<string, number>();
  for (const entry of aggregate.harnessSessionCounts) {
    const harnessKey = entry.harness ?? "unknown";
    harnessSessionCounts.set(
      harnessKey,
      (harnessSessionCounts.get(harnessKey) ?? 0) + entry.sessionCount
    );
  }
  const byHarness: SharedAgentSessionHarnessBreakdown[] = [
    ...harnessSessionCounts.entries(),
  ].map(([harnessKey, sessionCount]) => {
    const tokens = byHarnessTokens.get(harnessKey) ?? zeroTotals();
    return {
      harness: harnessKey,
      sessionCount,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      cacheReadTokens: tokens.cacheReadTokens,
      cacheWriteTokens: tokens.cacheWriteTokens,
      estimatedCost: tokens.estimatedCost,
    };
  });

  return {
    viewerScope: "self",
    totalSessions: aggregate.totalSessions,
    earliestSessionAt: aggregate.earliestSessionAt,
    latestSessionAt: aggregate.latestSessionAt,
    totalInputTokens: totals.inputTokens,
    totalOutputTokens: totals.outputTokens,
    totalCacheReadTokens: totals.cacheReadTokens,
    totalCacheWriteTokens: totals.cacheWriteTokens,
    totalEstimatedCost: ledgerTotals.metered + ledgerTotals.unknown,
    subscriptionEstimatedCost: ledgerTotals.subscription,
    apiEstimatedCost: ledgerTotals.metered + ledgerTotals.unknown,
    byUser: [],
    byModel: [...byModel.values()],
    byHarness,
    // The O(grouped) SQL aggregate has no per-repository rollup; the Repository
    // facet on desktop is sourced from the hydrate path (`buildUsageSummary`).
    byRepository: [],
    lastSyncTargets: [],
  };
}

function buildAnalytics(
  sessions: readonly SyncedAgentSession[]
): SharedAgentSessionAnalytics {
  return {
    viewerScope: "self",
    byTool: buildToolBreakdowns(sessions),
    byAgentType: buildAgentTypeBreakdowns(sessions),
    byRepository: buildRepositoryBreakdowns(sessions),
    byProject: [],
  };
}

function buildToolBreakdowns(
  sessions: readonly SyncedAgentSession[]
): SharedAgentSessionToolBreakdown[] {
  const groups = new Map<
    string,
    SharedAgentSessionToolBreakdown & { sessionIds: Set<string> }
  >();
  for (const session of sessions) {
    for (const event of session.events) {
      if (!event.toolName) {
        continue;
      }
      const group = groups.get(event.toolName) ?? {
        toolName: event.toolName,
        invocationCount: 0,
        errorCount: 0,
        sessionCount: 0,
        sessionIds: new Set<string>(),
      };
      group.invocationCount += 1;
      if (ERROR_EVENT_PATTERN.test(event.eventType)) {
        group.errorCount += 1;
      }
      group.sessionIds.add(session.externalSessionId);
      group.sessionCount = group.sessionIds.size;
      groups.set(event.toolName, group);
    }
  }
  return [...groups.values()].map(stripSessionIds);
}

function buildAgentTypeBreakdowns(
  sessions: readonly SyncedAgentSession[]
): SharedAgentSessionAgentTypeBreakdown[] {
  const groups = new Map<
    string,
    SharedAgentSessionAgentTypeBreakdown & {
      durationTotalMs: number;
      durationCount: number;
    }
  >();
  for (const session of sessions) {
    for (const agent of session.agents) {
      const agentType = agent.subagentType ?? agent.type ?? "unknown";
      const group = groups.get(agentType) ?? {
        agentType,
        count: 0,
        successCount: 0,
        failedCount: 0,
        avgDurationMs: null,
        durationTotalMs: 0,
        durationCount: 0,
      };
      group.count += 1;
      if (SUCCESS_STATUS_PATTERN.test(agent.status)) {
        group.successCount += 1;
      }
      if (FAILED_STATUS_PATTERN.test(agent.status)) {
        group.failedCount += 1;
      }
      const durationMs = durationBetween(agent.startedAt, agent.endedAt);
      if (durationMs !== null) {
        group.durationTotalMs += durationMs;
        group.durationCount += 1;
        group.avgDurationMs = group.durationTotalMs / group.durationCount;
      }
      groups.set(agentType, group);
    }
  }
  return [...groups.values()].map(
    ({
      durationCount: _durationCount,
      durationTotalMs: _durationTotalMs,
      ...group
    }) => group
  );
}

function buildRepositoryBreakdowns(
  sessions: readonly SyncedAgentSession[]
): SharedAgentSessionRepositoryBreakdown[] {
  const groups = new Map<string, SharedAgentSessionRepositoryBreakdown>();
  for (const session of sessions) {
    const totals = sumTokenUsage(session);
    const repositoryFullName =
      session.attribution?.repositoryFullName ??
      session.attribution?.worktreePath ??
      session.cwd ??
      "unknown";
    const group = groups.get(repositoryFullName) ?? {
      repositoryFullName,
      sessionCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      errorCount: 0,
    };
    group.sessionCount += 1;
    group.inputTokens += totals.inputTokens;
    group.outputTokens += totals.outputTokens;
    group.estimatedCost += totals.estimatedCost;
    group.errorCount += countErrorEvents(session.events);
    groups.set(repositoryFullName, group);
  }
  return [...groups.values()];
}

function indexSessionsById(
  sessions: readonly SyncedAgentSession[]
): Map<string, SyncedAgentSession> {
  return new Map(
    sessions.map((session) => [session.externalSessionId, session])
  );
}

function sumTokenUsage(session: SyncedAgentSession): SessionTotals {
  return session.tokenUsageByModel.reduce<SessionTotals>((totals, usage) => {
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.cacheReadTokens += usage.cacheReadTokens;
    totals.cacheWriteTokens += usage.cacheWriteTokens;
    totals.estimatedCost += usage.estimatedCostUsd ?? 0;
    return totals;
  }, zeroTotals());
}

function addTotals(target: SessionTotals, next: SessionTotals): void {
  target.inputTokens += next.inputTokens;
  target.outputTokens += next.outputTokens;
  target.cacheReadTokens += next.cacheReadTokens;
  target.cacheWriteTokens += next.cacheWriteTokens;
  target.estimatedCost += next.estimatedCost;
}

function zeroTotals(): SessionTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: 0,
  };
}

function addSessionToHarnessBreakdown(
  byHarness: Map<
    string,
    SharedAgentSessionHarnessBreakdown & { sessionIds: Set<string> }
  >,
  session: SyncedAgentSession,
  totals: SessionTotals
): void {
  const harness = session.harness ?? "unknown";
  const summary = byHarness.get(harness) ?? {
    harness,
    sessionCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: 0,
    sessionIds: new Set<string>(),
  };
  summary.sessionIds.add(session.externalSessionId);
  summary.sessionCount = summary.sessionIds.size;
  summary.inputTokens += totals.inputTokens;
  summary.outputTokens += totals.outputTokens;
  summary.cacheReadTokens += totals.cacheReadTokens;
  summary.cacheWriteTokens += totals.cacheWriteTokens;
  summary.estimatedCost += totals.estimatedCost;
  byHarness.set(harness, summary);
}

function getOrCreateModelSummary(
  byModel: Map<
    string,
    SharedAgentSessionUsageByModel & { sessionIds: Set<string> }
  >,
  model: string
): SharedAgentSessionUsageByModel & { sessionIds: Set<string> } {
  const existing = byModel.get(model);
  if (existing) {
    return existing;
  }
  const created = {
    model,
    sessionCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: 0,
    sessionIds: new Set<string>(),
  };
  byModel.set(model, created);
  return created;
}

function stripSessionIds<
  T extends { sessionIds: Set<string>; sessionCount: number },
>(value: T): Omit<T, "sessionIds"> {
  value.sessionCount = value.sessionIds.size;
  const { sessionIds: _sessionIds, ...rest } = value;
  return rest;
}

function getSessionLedger(session: SyncedAgentSession): BillingLedger {
  return billingLedger(normalizeBillingMode(session.billingMode));
}

function countErrorEvents(events: readonly { eventType: string }[]): number {
  return events.filter((event) => ERROR_EVENT_PATTERN.test(event.eventType))
    .length;
}

function hasUnsupportedCloudFilter(query: SharedAgentSessionsQuery): boolean {
  return Boolean(
    coerceOptionalString(query.userId) ||
      coerceOptionalString(query.teamId) ||
      coerceOptionalString(query.projectId)
  );
}

function clampLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_LIST_LIMIT;
  }
  return Math.min(Math.max(Math.floor(value), 1), MAX_LIST_LIMIT);
}

function clampOffset(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(Math.floor(value), 0);
}

function parseOptionalDate(value: unknown, fieldName: string): Date | null {
  const text = coerceOptionalString(value);
  if (!text) {
    return null;
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new SharedAgentSessionsInputError(
      `${fieldName} must be a valid date`
    );
  }
  return date;
}

function parseSessionDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return new Date(0);
  }
  return date;
}

// Date-prefix guard mirroring the sqlite `SESSION_STARTED_AT_BOUNDS_EXPR`
// (`^\d{4}-\d{2}-\d{2}`): a row contributes to the earliest/latest bounds only
// when its `started_at` is a real ISO timestamp. NULL/empty/malformed values
// return null (excluded from MIN/MAX) instead of the epoch-1970 fallback
// `parseSessionDate` uses for filtering, so one legacy row can't make the
// date-range label read "Jan 1, 1970".
const SESSION_STARTED_AT_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;
function parseBoundsStartMs(value: string | null | undefined): number | null {
  if (!(value && SESSION_STARTED_AT_DATE_PREFIX.test(value))) {
    return null;
  }
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function parseNullableSessionDate(
  value: string | null | undefined
): Date | null {
  return value ? parseSessionDate(value) : null;
}

function durationBetween(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined
): number | null {
  if (!(startedAt && endedAt)) {
    return null;
  }
  const start = parseSessionDate(startedAt);
  const end = parseSessionDate(endedAt);
  const durationMs = end.getTime() - start.getTime();
  return Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null;
}

function coerceOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function coerceNonEmptyString(value: unknown): string | null {
  return coerceOptionalString(value);
}

export class SharedAgentSessionsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SharedAgentSessionsInputError";
  }
}
