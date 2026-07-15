import type {
  AgentComponent,
  AgentComponentDetail,
  AgentComponentListResponse,
  AgentComponentQueryFilters,
  AgentComponentsChange,
} from "@repo/api/src/types/agent-component";
import { buildSearchParams } from "../../shared/lib/format-utils";

/**
 * Typed per-domain data-source port for the Agents workspace slice (FEA-2923).
 *
 * Mirrors `AgentSessionsDataSource` and `BranchesDataSource` exactly: the
 * shared read hooks call this port instead of speaking HTTP directly, so a
 * surface can supply a non-HTTP implementation (the desktop local DB or a
 * Phase-1 stub) without the hooks, query keys, or components changing. The
 * HTTP implementation below is the default; an `AgentComponentsDataSourceProvider`
 * may inject another.
 *
 * `subscribe` is optional: a live source (desktop local DB) implements it to
 * notify on data changes; the HTTP source omits it.
 */
export type AgentComponentsDataSource = {
  /**
   * Stable identity for the active source. Folded into React Query keys so a
   * surface that swaps sources never serves one source's rows from another's
   * cached filters. Keep values short and stable; distinct from the existing
   * AgentSessionsDataSource scope values ("http" / "local").
   *
   * HTTP source uses "agent-components:http"; the Phase-1 stub will use
   * "agent-components:stub".
   */
  scope: string;
  list(
    filters: AgentComponentQueryFilters
  ): Promise<AgentComponentListResponse>;
  /** Rejects (404 ApiError) when the slug is not found; never resolves null. */
  detail(slug: string): Promise<AgentComponentDetail>;
  subscribe?(onChange: (change: AgentComponentsChange) => void): () => void;
};

/** The slice of the API client the HTTP data source needs. */
type AgentComponentsHttpClient = {
  get<T>(path: string): Promise<T>;
};

function withQuery(path: string, filters: AgentComponentQueryFilters): string {
  const qs = buildSearchParams(filters).toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * Maps a raw `AgentComponent` response row from `GET /agent-components` to the
 * `AgentComponent` render shape expected by the workspace slice.
 *
 * The real endpoint already returns fields in the canonical shape (id=uuid,
 * computeTargetIds, firstSeenAt, lastSeenAt), so this function is a typed
 * pass-through that validates the shape at the seam boundary — no field
 * guessing or unsafe casts.
 */
export function adaptAgentComponentToResponse(
  raw: AgentComponent
): AgentComponent {
  return {
    id: raw.id,
    name: raw.name,
    kind: raw.kind,
    sourceType: raw.sourceType,
    source: raw.source,
    harness: raw.harness,
    invocations: raw.invocations,
    sessions: raw.sessions,
    klocPerDollar: raw.klocPerDollar,
    trend: raw.trend,
    owner: raw.owner,
    collaborators: raw.collaborators,
    computeTargetIds: raw.computeTargetIds,
    firstSeenAt: raw.firstSeenAt,
    lastSeenAt: raw.lastSeenAt,
  };
}

/**
 * The HTTP data source — the single place that builds the REST URLs/query
 * strings for the Agents workspace slice. Used by the web shell and by
 * authenticated desktop.
 *
 * `list()` calls `GET /agent-components` and returns `AgentComponentListResponse`
 * directly — the real endpoint performs org-level dedup and usage aggregation
 * server-side, so no client-side adaptation of the legacy `/agents` shape is
 * needed.
 *
 * `detail()` calls `GET /agent-components/{slug}` where `slug` is the DB UUID
 * of the component (`AgentComponent.id`). If the server responds 404, the HTTP
 * client throws an `ApiError` with status 404, satisfying the port contract
 * (rejects, never resolves null).
 */
export function createHttpAgentComponentsDataSource(
  apiClient: AgentComponentsHttpClient
): AgentComponentsDataSource {
  return {
    scope: "agent-components:http",

    list: async (filters) => {
      const response = await apiClient.get<AgentComponentListResponse>(
        withQuery("/agent-components", filters)
      );
      return {
        items: response.items.map(adaptAgentComponentToResponse),
        total: response.total,
        hasMore: response.hasMore,
      };
    },

    detail: (slug) =>
      apiClient.get<AgentComponentDetail>(`/agent-components/${slug}`),

    // No `subscribe` — HTTP is poll-only, exactly like the Sessions HTTP source.
  };
}
