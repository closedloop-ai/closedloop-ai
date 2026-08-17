/**
 * Read-model row and aggregate shapes for the desktop agent-session corpus.
 *
 * These describe what the LOCAL SQLite store returns to the sync lane and to the
 * shared sessions/analytics read APIs — the cursor/page rows, the raw session and
 * token-usage columns, and the pre-aggregated usage/analytics rollups that let
 * those APIs answer without hydrating every session. They are deliberately
 * transport-agnostic: nothing here describes a cloud payload (see
 * `agent-session-sync-contract.ts`) or the sync service itself (see
 * `agent-session-sync-source.ts` / `agent-session-sync-service-options.ts`).
 *
 * Extracted verbatim from `agent-session-sync-service.ts` (ISS-4676) so the
 * grandfathered service file carries only the sync lane, not the read model.
 */

import type { SessionDateWindowField } from "./session-date-window.js";

export type SessionCursorRow = {
  id: string;
  updated_at: string;
};

export const SessionListCursorSortKey = {
  LastActivity: "lastActivity",
  Started: "started",
  /**
   * Goal stage 1b: the NATURAL cursor order — `updated_at DESC, id DESC`, the
   * exact order `listAllSessionCursorRows` returns and therefore the order an
   * UNSORTED list read is already served in (`sortSyncedSessions` returns its
   * input untouched when `sortBy` is unset). It exists so a read that carries no
   * sort can ride this page instead of falling to the capped full-corpus
   * hydration, which was the only thing keeping it there. Never selectable from
   * the UI: no table header maps to it, and a request that names a real sort
   * column resolves to `LastActivity`/`Started` as before.
   */
  Updated: "updated",
} as const;
export type SessionListCursorSortKey =
  (typeof SessionListCursorSortKey)[keyof typeof SessionListCursorSortKey];

export type SessionListCursorPageRequest = {
  limit: number;
  offset: number;
  sortBy: SessionListCursorSortKey;
  sortDir: "asc" | "desc";
  /** Inclusive lower bound for the session activity window, applied before paging. */
  startDate?: Date;
  /** Inclusive upper bound for the session activity window, applied before paging. */
  endDate?: Date;
  /**
   * Free-text list search applied before paging. Implementations should mirror
   * the shared sessions list's identity/branch matching as closely as their
   * local indexes allow.
   */
  search?: string;
  /**
   * Goal stage 1 (sync reliability): the Status facet selection, applied before
   * paging — OR within the set, AND with the other filters. Values are the
   * shared Status-facet vocabulary (including the display-derived
   * `waiting`/`stale`/`unknown` and retired-spelling requests). An
   * implementation MUST partition rows exactly as the hydrated
   * `matchesStatusFilter` fold does — the sqlite source renders it via
   * `buildUsageStatusPredicate`, the established SQL twin the count-only badge
   * read already trusts — or not be admitted to the paging branch: a status
   * silently dropped here is a filter silently dropped on screen. Before this
   * field existed, ANY status selection forced the capped full-corpus hydration
   * fallback (`loadSyncedSessions` of up to MAX_WORKING_SET_SESSIONS sessions,
   * measured +1.4–1.6 GB heap per call on a large real corpus — the FEA-2038
   * db-host OOM shape) on every list poll. Absent/empty → no status predicate.
   */
  statuses?: readonly string[];
};

export type SessionListCursorPage = {
  rows: SessionCursorRow[];
  total: number;
};

export type SessionRow = {
  id: string;
  name: string | null;
  status: string;
  cwd: string | null;
  model: string | null;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
  awaiting_input_since: string | null;
  metadata: string | null;
  harness: string | null;
  billing_mode: string | null;
  user_id: string | null;
  organization_id: string | null;
};

export type TokenUsageRow = {
  session_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /**
   * FEA-3419: optional TTL subdivision — callers that SELECT the columns get
   * 1h-correct fallback pricing; callers that omit them price at the default
   * (5m) rate, matching absent provenance. `unknown` because raw SQLite rows
   * (bigint) are spread in un-coerced; coerced via Number() at use.
   */
  cache_write_5m_tokens?: unknown;
  cache_write_1h_tokens?: unknown;
  created_at?: string | null;
  cost_usd_estimated?: number | null;
};

/**
 * Sanitized filter inputs for the usage aggregation (FEA-1834 / PLN-941 §4).
 * These mirror the session-level predicates of `matchesQuery`/`sanitizeQuery`
 * (harness equality, the date window, status canonicalization) so the
 * aggregation can apply them in SQL without hydrating sessions.
 */
export type AgentSessionUsageAggregateFilters = {
  harness?: string;
  status?: string;
  /**
   * Multi-status session filter. Takes precedence over `status`, matching the
   * shared list matcher and preventing aggregate endpoints from hydrating the
   * desktop session corpus just to honor multi-select status filters.
   */
  statuses?: string[];
  /**
   * Desktop-local session ownership filter. Explicit user filters match the
   * stored `sessions.user_id`; rows with NULL ownership remain in unfiltered
   * totals and are excluded from explicit user-scoped reads.
   */
  userId?: string;
  /** Multi-user ownership filter. Takes precedence over `userId`. */
  userIds?: string[];
  startDate?: Date;
  endDate?: Date;
  /**
   * ISS-5443: which timestamp the `startDate`/`endDate` window is measured
   * against. Threaded in from the read entrypoint so ONE constant per read
   * surface decides the basis for both this SQL aggregate and the hydrated
   * `matchesDateBounds` fold — the Sessions surface (list + usage/KPI + count
   * badge) on `lastActivityAt`, analytics on `startedAt`. Optional and additive:
   * an absent value defaults to the Sessions-surface basis, the one that
   * reconciles with the list.
   */
  dateWindowField?: SessionDateWindowField;
};

/**
 * FEA-4142: filters for the metadata-only session `COUNT(*)`. A superset of the
 * usage aggregate filters plus the FEA-3009 completion bound — the usage
 * aggregate windows on the Sessions-surface date field, but the "completed
 * since I last opened Agents" badge windows on the terminal `ended_at`.
 * `completedAfter` is an
 * ISO-8601 instant compared as `ended_at >= completedAfter` (a still-running
 * session with a NULL `ended_at` never matches), mirroring `matchesDateBounds`
 * in the shared list API.
 */
export type AgentSessionCountFilters = AgentSessionUsageAggregateFilters & {
  completedAfter?: string;
};

/**
 * One `(billing_mode, harness, model)` token rollup from the usage aggregation.
 * `billingMode`/`harness`/`model` are the RAW column values (the fold resolves
 * the billing mode and maps null/empty harness/model exactly as the hydrate
 * path does). `sessionCount` is `COUNT(DISTINCT session_id)` within the group.
 */
export type AgentSessionUsageTokenGroup = {
  billingMode: string | null;
  harness: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  sessionCount: number;
  estimatedCostUsd: number | null;
};

/**
 * Pre-aggregated usage data — the O(grouped) replacement for hydrating every
 * session to fold a usage summary (FEA-1834 / PLN-941 §4). `tokenGroups` carries
 * SQL SUM/COUNT rollups; `harnessSessionCounts` carries per-harness session
 * counts INCLUDING zero-token sessions (which the token join cannot see, but the
 * hydrate path's `byHarness` includes); `totalSessions` counts all filtered
 * sessions (zero-token included).
 */
export type AgentSessionUsageAggregate = {
  totalSessions: number;
  /** Earliest/latest session start (ISO) across the filtered corpus; null when empty. */
  earliestSessionAt: string | null;
  latestSessionAt: string | null;
  tokenGroups: AgentSessionUsageTokenGroup[];
  harnessSessionCounts: { harness: string | null; sessionCount: number }[];
  /** Per-owner session counts for the multiplayer Owner facet (FEA — owner attribution). */
  userSessionCounts: { userId: string | null; sessionCount: number }[];
  /**
   * FEA-4303: per-PRIMARY-model session counts (`sessions.model`, the single
   * displayed model) counted from `sessions` so token-less sessions still count.
   * Sources the Model filter facet options on the O(grouped) fast path —
   * distinct from `tokenGroups`' per-token-usage `model` (which spans
   * secondary/subagent models). Optional so an older source that does not emit it
   * degrades to no Model facet options rather than crashing.
   */
  primaryModelSessionCounts?: { model: string | null; sessionCount: number }[];
  /**
   * FEA-4299: per-repository session counts sourcing the Repository filter facet
   * options on the fast usage path. Keyed by the resolved Git-remote
   * `repositoryFullName` (the SAME value the row renders); cwds with no resolved
   * remote are dropped, so the facet never offers a value no row can display.
   */
  repoSessionCounts: { repositoryFullName: string; sessionCount: number }[];
};

/**
 * One `tool_name` rollup from the analytics aggregation (FEA-2038). Mirrors the
 * hydrate-path per-tool fold in `buildAnalytics` over the same filtered session set:
 * `invocationCount` counts events with that tool, `errorCount` counts those
 * whose `event_type` matches the error/fail predicate, `sessionCount` is the
 * distinct session count.
 */
export type AgentSessionAnalyticsToolGroup = {
  toolName: string;
  invocationCount: number;
  errorCount: number;
  sessionCount: number;
};

/**
 * One resolved agent-type rollup from the analytics aggregation (FEA-2038).
 * `agentType` is `COALESCE(subagent_type, type, 'unknown')`. `durationTotalMs`/
 * `durationCount` carry the SQL duration fold; the API converts them to
 * `avgDurationMs` and omits these two fields, matching `buildAnalytics`'s per-agent-type fold.
 */
export type AgentSessionAnalyticsAgentTypeGroup = {
  agentType: string;
  count: number;
  successCount: number;
  failedCount: number;
  durationTotalMs: number;
  durationCount: number;
};

/**
 * One per-cwd repository rollup from the analytics aggregation (FEA-2038). SQL
 * groups by the RAW `cwd`; the API resolves each cwd to its attribution and
 * merges cwds that resolve to one `repositoryFullName` (so the field carries the
 * raw cwd here, not the resolved identity).
 */
export type AgentSessionAnalyticsRepositoryGroup = {
  repositoryFullName: string;
  sessionCount: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  errorCount: number;
};

/**
 * Pre-aggregated analytics data — the O(grouped) replacement for hydrating
 * every filtered session/event/agent/token row to fold the analytics response
 * (FEA-2038, db-host OOM). Folded by `getSharedAgentSessionAnalytics` into the
 * canonical `SharedAgentSessionAnalytics`. `byRepository` carries per-cwd rows
 * keyed by RAW cwd; the API resolves+merges them via the shared attribution cache.
 */
export type AgentSessionAnalyticsAggregate = {
  byTool: AgentSessionAnalyticsToolGroup[];
  byAgentType: AgentSessionAnalyticsAgentTypeGroup[];
  byRepository: AgentSessionAnalyticsRepositoryGroup[];
};

/**
 * ISS-4558: the date window and sort a Repository-scoped id resolution may push
 * into its own SQL, so a repo-filtered list read carrying the REAL Sessions
 * request shape (a bounded window plus `sortBy: lastActivity`) still pages
 * pre-hydration instead of falling to the capped full-corpus fallback.
 *
 * Deliberately the same fields — and the same semantics — as the cursor page's
 * request, because the two are answered by the same window expression and sort
 * columns; deriving the type from it keeps them from drifting apart.
 *
 * Every field is optional and OMISSION IS LOAD-BEARING: with no `sortBy` the
 * resolution keeps its legacy `updated_at DESC, id DESC` order, which is what
 * the capped fallback's "cap keeps the most recent N" promise is measured in —
 * and with no `limit` it returns every match, which is what the uncapped
 * pre-hydration paging branch needs to keep `total` correct past the ceiling.
 *
 * ISS-5625: `limit` is the caller's cap, pushed into the resolution so the
 * bounded slice is not paid for by materializing the unbounded one first. It
 * carries the cursor page's `limit` semantics — at most this many rows, in the
 * order above — and, like every other field here, an implementation that cannot
 * honor it must leave the caller's own bound to apply.
 */
export type RepositoryScopedSessionIdsOptions = Partial<
  Pick<
    SessionListCursorPageRequest,
    "startDate" | "endDate" | "limit" | "sortBy" | "sortDir"
  >
>;
