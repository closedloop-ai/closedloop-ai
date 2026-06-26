import type {
  BranchAnalytics,
  BranchListResponse,
  BranchPageDetail,
  BranchQueryFilters,
  BranchUsageSummary,
} from "@repo/api/src/types/branch";
import { buildSearchParams } from "../../shared/lib/format-utils";

// `BranchQueryFilters` is now defined canonically in `@repo/api/src/types/branch`
// (one home shared by both surfaces — CLAUDE.md). Re-exported here so the
// data-source port and `../hooks/use-branches` keep their existing import paths.
export type { BranchQueryFilters } from "@repo/api/src/types/branch";

/** A change notification surfaced by a live-capable data source. */
export type BranchesChange = { branchId?: string };

/**
 * Typed per-domain data-source port for the Branches slice (PLN-983 / Epic A).
 *
 * Mirrors `AgentSessionsDataSource` exactly: the shared read hooks call this
 * port instead of speaking HTTP directly, so a surface can supply a non-HTTP
 * implementation (the desktop local DB over IPC) without the hooks, query keys,
 * or components changing. The HTTP implementation below is the default; a
 * `BranchesDataSourceProvider` may inject another.
 *
 * `subscribe` is optional: a live source (desktop local DB) implements it to
 * notify on data changes; the HTTP source omits it.
 */
export type BranchesDataSource = {
  /**
   * Stable identity for the active source. Folded into the filter-based React
   * Query keys (see `branchesKeys`) so a surface that swaps sources — desktop
   * moving between its local DB and the authenticated backend — never serves
   * one source's rows from another's cached filters. Keep values short and
   * stable (the HTTP source uses `"http"`; the local source uses `"local"`).
   */
  scope: string;
  list(filters: BranchQueryFilters): Promise<BranchListResponse>;
  /** Rejects (404 ApiError) when missing; never resolves null. */
  detail(id: string): Promise<BranchPageDetail>;
  usage(filters: BranchQueryFilters): Promise<BranchUsageSummary>;
  analytics(filters: BranchQueryFilters): Promise<BranchAnalytics>;
  subscribe?(onChange: (change: BranchesChange) => void): () => void;
};

/** The slice of the API client the HTTP data source needs. */
type BranchesHttpClient = {
  get<T>(path: string, options?: RequestInit): Promise<T>;
};

function withQuery(path: string, filters: BranchQueryFilters): string {
  const qs = buildSearchParams(filters).toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * The HTTP data source — the single place that builds the REST URLs/query
 * strings. Used by the web shell and by authenticated desktop.
 *
 * DEFERRED/STUBBED: no `apps/api` `/branches*` routes exist yet. v1 ships the
 * LOCAL path only; this file + signature land so the provider can swap to the
 * REST source — with no hook/key/component change — once the new desktop auth
 * arrives. Behavior mirrors `createHttpAgentSessionsDataSource` exactly.
 */
export function createHttpBranchesDataSource(
  api: BranchesHttpClient
): BranchesDataSource {
  return {
    scope: "http",
    list: (filters) =>
      api.get<BranchListResponse>(withQuery("/branches", filters)),
    detail: (id) => api.get<BranchPageDetail>(`/branches/${id}`),
    usage: (filters) =>
      api.get<BranchUsageSummary>(withQuery("/branches/usage", filters)),
    analytics: (filters) =>
      api.get<BranchAnalytics>(withQuery("/branches/analytics", filters)),
    // no `subscribe` — HTTP is poll-only, exactly like the Sessions HTTP source.
  };
}
