import type {
  AgentSessionAnalytics,
  AgentSessionDetail,
  AgentSessionListResponse,
  AgentSessionUsageSummary,
  AgentSessionViewerScope,
} from "@repo/api/src/types/agent-session";
import { ReadSource } from "@repo/api/src/types/read-source";
import { buildSearchParams } from "../../shared/lib/format-utils";
import { withReadSource } from "../../shared/lib/read-source";

/**
 * Query filters shared by the agent-session reads. Canonical home for the type
 * (re-exported from `../hooks/use-agent-sessions` for backward compatibility).
 */
export type AgentSessionQueryFilters = {
  startDate?: string;
  endDate?: string;
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
  search?: string;
  viewerScope?: AgentSessionViewerScope;
  teamId?: string;
  projectId?: string;
  limit?: number;
  offset?: number;
  /** Column-header sort: column id + direction (server-ordered). */
  sortBy?: string;
  sortDir?: "asc" | "desc";
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
  usage(filters: AgentSessionQueryFilters): Promise<AgentSessionUsageSummary>;
  analytics(filters: AgentSessionQueryFilters): Promise<AgentSessionAnalytics>;
  subscribe?(onChange: (change: AgentSessionsChange) => void): () => void;
};

/** The slice of the API client the HTTP data source needs. */
type AgentSessionsHttpClient = {
  get<T>(path: string, options?: RequestInit): Promise<T>;
};

function withQuery(path: string, filters: AgentSessionQueryFilters): string {
  const qs = buildSearchParams(filters).toString();
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
          withQuery("/agent-sessions", filters)
        ),
        ReadSource.Cloud
      ),
    detail: (id) => api.get<AgentSessionDetail>(`/agent-sessions/${id}`),
    usage: (filters) =>
      api.get<AgentSessionUsageSummary>(
        withQuery("/agent-sessions/usage", filters)
      ),
    analytics: (filters) =>
      api.get<AgentSessionAnalytics>(
        withQuery("/agent-sessions/analytics", filters)
      ),
  };
}
