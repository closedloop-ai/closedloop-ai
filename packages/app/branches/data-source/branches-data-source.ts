import type {
  BranchAnalytics,
  BranchListResponse,
  BranchPageDetail,
  BranchPrCommentsResponse,
  BranchQueryFilters,
  BranchTraceResponse,
  BranchUsageSummary,
  MergedTraceItem,
} from "@repo/api/src/types/branch";
import { BranchViewerScope } from "@repo/api/src/types/branch";
import { ReadSource } from "@repo/api/src/types/read-source";
import { buildSearchParams } from "../../shared/lib/format-utils";
import { withReadSource } from "../../shared/lib/read-source";

const BRANCH_TRACE_PAGE_LIMIT = 100;
const BRANCH_LIST_PAGE_LIMIT = 100;

// `BranchQueryFilters` is now defined canonically in `@repo/api/src/types/branch`
// (one home shared by both surfaces — CLAUDE.md). Re-exported here so the
// data-source port and `../hooks/use-branches` keep their existing import paths.
export type { BranchQueryFilters } from "@repo/api/src/types/branch";

/** A change notification surfaced by a live-capable data source. */
export type BranchesChange = { branchId?: string };

export type BranchListOptions = BranchQueryFilters & {
  forceRefresh?: boolean;
};

export type BranchDetailOptions = {
  forceRefresh?: boolean;
};

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
  list(filters: BranchListOptions): Promise<BranchListResponse>;
  /** Rejects (404 ApiError) when missing; never resolves null. */
  detail(id: string, options?: BranchDetailOptions): Promise<BranchPageDetail>;
  comments(id: string): Promise<BranchPrCommentsResponse>;
  /**
   * The events-heavy cross-session merged trace (PLN-1148 Phase 2), fetched
   * lazily only when the Sessions & timeline tab opens — split out of `detail` so
   * the default view never loads the trace's multi-KB event payloads. Best-effort:
   * resolves to an empty array (never rejects) so the tab degrades to an empty
   * timeline rather than erroring.
   */
  trace(id: string): Promise<readonly MergedTraceItem[]>;
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
 * The trace route returns pagination metadata for REST clients. This adapter
 * follows every page internally because the shared Branches port intentionally
 * exposes only the trace items so existing detail consumers keep receiving the
 * `MergedTraceItem[]` shape they render.
 */
export function createHttpBranchesDataSource(
  api: BranchesHttpClient
): BranchesDataSource {
  return {
    scope: "http",
    list: (filters) => getCompleteBranchList(api, filters),
    detail: (id) => api.get<BranchPageDetail>(`/branches/${id}`),
    comments: (id) =>
      api.get<BranchPrCommentsResponse>(`/branches/${id}/comments`),
    trace: (id) => getCompleteTrace(api, id),
    usage: (filters) =>
      api.get<BranchUsageSummary>(withQuery("/branches/usage", filters)),
    analytics: (filters) =>
      api.get<BranchAnalytics>(withQuery("/branches/analytics", filters)),
    // no `subscribe` — HTTP is poll-only, exactly like the Sessions HTTP source.
  };
}

async function getCompleteBranchList(
  api: BranchesHttpClient,
  filters: BranchQueryFilters
): Promise<BranchListResponse> {
  if (filters.limit !== undefined || filters.offset !== undefined) {
    return withReadSource(
      await api.get<BranchListResponse>(withQuery("/branches", filters)),
      ReadSource.Cloud
    );
  }

  const items: BranchListResponse["items"] = [];
  let offset = 0;
  let total = 0;
  let viewerScope: BranchListResponse["viewerScope"] | undefined;
  let hasMore = true;
  // FEA-3120: honor a server-provided source if any page reports one (all pages
  // come from the same cloud route, so it is uniform); otherwise default to
  // `cloud` since this HTTP boundary always reads synced cloud state.
  let readSource: ReadSource = ReadSource.Cloud;

  while (hasMore) {
    const response = await api.get<BranchListResponse>(
      withQuery("/branches", {
        ...filters,
        limit: BRANCH_LIST_PAGE_LIMIT,
        offset,
      })
    );
    items.push(...response.items);
    total = response.total;
    viewerScope = response.viewerScope;
    if (response.readSource) {
      readSource = response.readSource;
    }
    offset += response.items.length;
    hasMore = response.hasMore === true && response.items.length > 0;
  }

  return {
    items,
    total,
    viewerScope: viewerScope ?? BranchViewerScope.Organization,
    hasMore: false,
    readSource,
  };
}

async function getCompleteTrace(
  api: BranchesHttpClient,
  id: string
): Promise<readonly MergedTraceItem[]> {
  const items: MergedTraceItem[] = [];
  let offset = 0;
  let hasMore = true;

  // Best-effort (port docstring above): the trace is enrichment for the
  // timeline tab, so a failed fetch degrades to the items collected so far
  // (or `[]`) rather than rejecting — mirroring the desktop local source. This
  // keeps `useBranchTrace` out of an error state on web↔desktop parity.
  try {
    while (hasMore) {
      const response = await api.get<BranchTraceResponse>(
        `/branches/${id}/trace?limit=${BRANCH_TRACE_PAGE_LIMIT}&offset=${offset}`
      );
      items.push(...response.items);
      offset += response.items.length;
      hasMore = response.hasMore && response.items.length > 0;
    }
  } catch {
    return items;
  }

  return items;
}
