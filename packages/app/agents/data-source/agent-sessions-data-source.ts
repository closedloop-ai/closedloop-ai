import type { SessionQuality } from "@repo/api/src/agent-session-filters";
import type {
  AgentSessionAnalytics,
  AgentSessionDetail,
  AgentSessionListResponse,
  AgentSessionsPageData,
  AgentSessionUsageSummary,
  AgentSessionViewerScope,
} from "@repo/api/src/types/agent-session";
import type { AgentSessionComparisonMode } from "@repo/api/src/types/agent-session-usage-comparison";
import { ReadSource } from "@repo/api/src/types/read-source";
import { ApiError } from "../../shared/api/api-error";
import { buildSearchParams } from "../../shared/lib/format-utils";
import { withReadSource } from "../../shared/lib/read-source";
import { reflectToSettled } from "../../shared/lib/reflect-settled";

/**
 * Query filters shared by the agent-session reads. Canonical home for the type
 * (re-exported from `../hooks/use-agent-sessions` for backward compatibility).
 */
export type AgentSessionQueryFilters = {
  startDate?: string;
  endDate?: string;
  /**
   * FEA-3009: completion-time lower bound — keep only sessions that COMPLETED
   * (reached a terminal `endedAt`/`sessionEndedAt`) at or after this ISO
   * instant. Distinct from `startDate`, which the list route filters on
   * `lastActivityAt` (cloud) / `startedAt` (desktop): a long-running session
   * that started before this instant but finished after it IS counted, and one
   * that finished before it is not. Sessions with no completion timestamp
   * (still running) are excluded. Both surfaces filter the same completion
   * field so the "completed since I last looked" badge counts identically
   * across web and desktop.
   */
  completedAfter?: string;
  harness?: string;
  /** Single-value back-compat filters (e.g. the user-scoped deep link). */
  status?: string;
  userId?: string;
  /** Multi-select Filter facets, serialized as repeated query params. */
  statuses?: string[];
  userIds?: string[];
  repositories?: string[];
  /** Multi-select harness/model facets (options derived from the usage summary). */
  harnesses?: string[];
  models?: string[];
  /** Autonomy-tier ids ("high"/"mixed"/"guided"/"unknown") and cost-bucket ids. */
  autonomyTiers?: string[];
  costBuckets?: string[];
  /** Change-presence ids ("has_changes"/"no_changes") and PR-association ids ("has_pr"/"no_pr"). */
  changePresence?: string[];
  prAssociation?: string[];
  /**
   * FEA-3284/FEA-3345/FEA-4145 session quality: `substantive` (idle/phantom rows
   * hidden), `idle` (only idle/phantom rows), or `all` (both). Absent = the
   * fail-open `all` default (`DEFAULT_SESSION_QUALITY`), matching the server.
   */
  quality?: SessionQuality;
  search?: string;
  viewerScope?: AgentSessionViewerScope;
  teamId?: string;
  projectId?: string;
  /**
   * ISS-5355: multi-select Project facet — sessions that LINKED a document in
   * the selected project(s) (ISS-5236's "linked artifacts"). A different
   * dimension from the singular `projectId` scope above, which matches the
   * session artifact's own parent project; when both are present they AND.
   */
  projectIds?: string[];
  /**
   * FEA-4142: a projection hint for count-only readers (the Agents sidebar
   * activity badge) that need `total` but discard the rows. The desktop-local
   * source honors it by answering with a single SQL `COUNT(*)` — never
   * hydrating the session corpus into JS (the FEA-2038 db-host OOM) — and
   * returning an empty `items`. It is a local-DB optimization only: the cloud
   * list route already computes the identical `total` with a cheap
   * `db.sessionDetail.count()` and hydrates just the requested page, so the HTTP
   * source strips this hint rather than sending an unmodeled query param.
   */
  countOnly?: boolean;
  limit?: number;
  offset?: number;
  /** Column-header sort: column id + direction (server-ordered). */
  sortBy?: string;
  sortDir?: "asc" | "desc";
};

/**
 * The filters of the reads that can carry a usage summary: the shared shape PLUS
 * the ISS-5809 opt-in to the server-computed period-over-period comparison. Used
 * by `usage()` and — since ISS-6041 — by the combined `pageData()`, whose usage
 * half is the same read.
 *
 * Deliberately a SEPARATE type rather than an optional field on the shared one.
 * The list, analytics and export routes parse the strict base schema and model no
 * comparison, so a `comparison` reaching any of them is a 400 — and the first cut
 * of ISS-5809 put the field on the shared type and stripped it only in
 * `withListQuery`, leaving `analytics()` (which builds its URL with
 * `withBaseQuery`) free to forward it. Keeping the opt-in off the shared type
 * makes that unrepresentable rather than relying on every builder remembering.
 */
export type AgentSessionUsageQueryFilters = AgentSessionQueryFilters & {
  comparison?: AgentSessionComparisonMode;
};

/** A change notification surfaced by a live-capable data source. */
export type AgentSessionsChange = { sessionId?: string };

/**
 * Typed per-domain data-source port for agent sessions (FEA-1834 / PLN-941).
 *
 * The shared read hooks call this port instead of speaking HTTP directly, so a
 * surface can supply a non-HTTP implementation (e.g. the desktop local DB over
 * IPC) without the hooks, query keys, or components changing. The HTTP
 * implementation below is the default; a `DataSourceProvider` may inject another.
 *
 * `subscribe` is optional: a live source (desktop local DB) implements it to
 * notify on data changes; the HTTP source omits it.
 */
export type AgentSessionsDataSource = {
  /**
   * Stable identity for the active source. It is folded into the filter-based
   * React Query keys (see `agentSessionKeys`) so that a surface which can swap
   * sources — e.g. desktop moving between its local DB and the authenticated
   * backend — never serves one source's rows from another's cached filters.
   * Keep values short and stable (the HTTP source uses `"http"`).
   */
  scope: string;
  list(filters: AgentSessionQueryFilters): Promise<AgentSessionListResponse>;
  detail(id: string): Promise<AgentSessionDetail>;
  usage(
    filters: AgentSessionUsageQueryFilters
  ): Promise<AgentSessionUsageSummary>;
  analytics(filters: AgentSessionQueryFilters): Promise<AgentSessionAnalytics>;
  /**
   * Combined list + usage read (FEA-4157). The Sessions screen mounts the table
   * and its prop-driven summary cards together on every load; callers that need
   * both should prefer this over separate `list`/`usage` calls so an
   * implementation can serve them from one shared read — on desktop that is the
   * paginated list plus the metadata-only SQL usage aggregate — instead of two
   * independent scans of the same underlying rows. Mirrors
   * `BranchesDataSource.pageData`.
   *
   * ISS-6041: takes the USAGE filter shape, because its usage half is the same
   * read `usage()` issues and therefore accepts the same ISS-5809 `comparison`
   * opt-in. Without it the desktop Sessions view — which reads through this port,
   * over the very same HTTP source the web page uses when it is in Cloud mode —
   * had no way to ask for the period-over-period figures the API can already
   * serve, so one shared summary-card component chipped its deltas on web and
   * showed nothing on desktop. An implementation whose producer cannot compare
   * windows (the desktop-local SQLite source) drops the opt-in and answers with
   * no `comparison`, which every consumer already reads as "no chip".
   */
  pageData(
    filters: AgentSessionUsageQueryFilters
  ): Promise<AgentSessionsPageData>;
  subscribe?(onChange: (change: AgentSessionsChange) => void): () => void;
};

/** The slice of the API client the HTTP data source needs. */
type AgentSessionsHttpClient = {
  get<T>(path: string, options?: RequestInit): Promise<T>;
};

function withListQuery(
  path: string,
  filters: AgentSessionUsageQueryFilters
): string {
  // `countOnly` and `search` are desktop-local hints the cloud routes don't
  // model — strip them so the strict server schema accepts the request. Since
  // ISS-6041 the combined `pageData` filters can also carry the usage-only
  // `comparison` opt-in, which the list route's strict schema rejects with a 400;
  // strip it here so the ONE builder that serves every list URL cannot forward it.
  const {
    countOnly: _countOnly,
    search: _search,
    comparison: _comparison,
    ...cloudFilters
  } = filters;
  const qs = buildSearchParams(cloudFilters).toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * The filter fields the non-list routes — usage included — do NOT receive:
 * pagination, sort, and the desktop-local hints the cloud routes do not model.
 *
 * Exported because it is a CONTRACT, not an implementation detail: a field the
 * usage request never carries cannot move the usage aggregate, and consumers
 * reason about that. The desktop Sessions view's ISS-6041 comparison scope is
 * built by dropping exactly this set, so teaching the usage route to honor one of
 * these later must delete it here — which updates that consumer in the same edit
 * instead of leaving it grading a stale scope. `usage-query-contract.test.ts`
 * pins that the built usage URL really omits every key listed here.
 */
export const USAGE_STRIPPED_FILTER_KEYS = [
  "countOnly",
  "limit",
  "offset",
  "search",
  "sortBy",
  "sortDir",
] as const;

/**
 * The base-schema field set: pagination, sort, and the desktop-local hints
 * removed. Shared by every non-list route so one builder cannot start forwarding
 * a field the others strip.
 *
 * Destructured rather than looped over {@link USAGE_STRIPPED_FILTER_KEYS} so the
 * removal stays type-checked against `AgentSessionQueryFilters`; the test named
 * above is what keeps the two statements of the set honest with each other.
 */
function toBaseFilters(
  filters: AgentSessionQueryFilters
): AgentSessionQueryFilters {
  const {
    countOnly: _countOnly,
    search: _search,
    limit: _limit,
    offset: _offset,
    sortBy: _sortBy,
    sortDir: _sortDir,
    ...baseFilters
  } = filters;
  return baseFilters;
}

function withBaseQuery(
  path: string,
  filters: AgentSessionQueryFilters
): string {
  // Non-list routes (usage, analytics, export) share the base schema, which does
  // not model pagination or sort. `AgentSessionQueryFilters` carries no
  // `comparison`, so analytics and export cannot forward the usage-only opt-in
  // that their strict schema rejects — the split is enforced by the TYPE rather
  // than by remembering to strip it in each builder (review of ISS-5809 found
  // exactly that omission here).
  const qs = buildSearchParams(toBaseFilters(filters)).toString();
  return qs ? `${path}?${qs}` : path;
}

/** The base query PLUS the usage-only comparison opt-in. */
function withUsageQuery(
  path: string,
  filters: AgentSessionUsageQueryFilters
): string {
  const { comparison, ...rest } = filters;
  const qs = buildSearchParams({
    ...toBaseFilters(rest),
    ...(comparison ? { comparison } : {}),
  }).toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * The HTTP data source — the single place that builds the REST URLs/query
 * strings. Used by the web shell and by authenticated desktop. Behavior is
 * byte-identical to the former inline `queryFn` bodies in `use-agent-sessions`.
 */
export function createHttpAgentSessionsDataSource(
  api: AgentSessionsHttpClient
): AgentSessionsDataSource {
  return {
    scope: "http",
    // FEA-3120: stamp the read-source at the boundary. The HTTP source always
    // reads synced cloud state, so it is `cloud` unless the backend already
    // annotated the envelope with a more specific source — we never overwrite an
    // explicit server value.
    list: async (filters) =>
      withReadSource(
        await api.get<AgentSessionListResponse>(
          withListQuery("/agent-sessions", filters)
        ),
        ReadSource.Cloud
      ),
    detail: (id) => api.get<AgentSessionDetail>(`/agent-sessions/${id}`),
    usage: (filters) => readUsageSummary(api, filters),
    analytics: (filters) =>
      api.get<AgentSessionAnalytics>(
        withBaseQuery("/agent-sessions/analytics", filters)
      ),
    // FEA-4157: no combined REST route yet — the redundant-read cost this exists
    // to avoid is a desktop-local (SQLite/IPC) concern; apps/api has no analogous
    // doubled scan today. Fetching both concurrently still saves one round trip's
    // worth of wall-clock time versus sequential awaits. Mirrors the Branches
    // HTTP `pageData`.
    //
    // FEA-4177 — independent failure domains: these are two separate requests, so
    // `Promise.all` would give them ONE failure domain (a usage failure would
    // reject the whole read and blank the table). The list is the required half
    // (rethrow its rejection so the table shows a real error), but a usage
    // rejection degrades ONLY the summary cards (`usage` omitted,
    // `usageError: true`) while the list still renders.
    //
    // wongk review: don't `await Promise.allSettled([list, usage])` — that makes
    // the required list WAIT for the optional usage request, so a list that has
    // already failed while usage stalls never surfaces its rejection and the page
    // hangs on loading. Reflect the usage promise to a settled result
    // IMMEDIATELY, await the list DIRECTLY (its rejection propagates the instant
    // it lands), then inspect usage only after the list resolves.
    pageData: async (filters) => {
      // Start BOTH reads before awaiting so they run concurrently.
      const listPromise = api.get<AgentSessionListResponse>(
        withListQuery("/agent-sessions", filters)
      );
      // ISS-6041: the same usage read `usage()` issues, opt-in and deploy-skew
      // fallback included — a desktop reader in Cloud mode asks this one combined
      // read for the comparison the web page asks the standalone read for.
      const usageResultPromise = reflectToSettled(
        readUsageSummary(api, filters)
      );
      // Await the required list directly — a list rejection throws here without
      // waiting on the optional usage read.
      const list = withReadSource(await listPromise, ReadSource.Cloud);
      const usageResult = await usageResultPromise;
      if (usageResult.status === "rejected") {
        return { list, usageError: true };
      }
      return { list, usage: usageResult.value };
    },
  };
}

/**
 * The HTTP usage read, with the ISS-5809 comparison opt-in's deploy-skew
 * fallback.
 *
 * Shared by `usage()` and the combined `pageData()` (ISS-6041) so the two cannot
 * drift into disagreeing about what asking for a comparison costs when the API
 * does not know the param yet.
 */
async function readUsageSummary(
  api: AgentSessionsHttpClient,
  filters: AgentSessionUsageQueryFilters
): Promise<AgentSessionUsageSummary> {
  const read = () =>
    api.get<AgentSessionUsageSummary>(
      withUsageQuery("/agent-sessions/usage", filters)
    );
  if (filters.comparison === undefined) {
    return await read();
  }
  try {
    return await read();
  } catch (error) {
    // Deploy skew: `apps/app` and `apps/api` are separate Vercel projects
    // that promote independently, so a shell that knows the ISS-5809 opt-in
    // can reach an API that does not. That API's usage schema is `.strict()`,
    // so it answers 400 and the reader loses the whole summary — every
    // headline card, not just the chips the param was for. The comparison is
    // optional by contract, so drop it and read again; the cards render and
    // the chips stay absent until the API catches up. Only a client error is
    // retried (a 5xx or a timeout is not a schema disagreement, and retrying
    // it would just double the load on an already-failing backend).
    if (!(error instanceof ApiError && error.isClientError())) {
      throw error;
    }
    const { comparison: _comparison, ...withoutComparison } = filters;
    return await api.get<AgentSessionUsageSummary>(
      withBaseQuery("/agent-sessions/usage", withoutComparison)
    );
  }
}
