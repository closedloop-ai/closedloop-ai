import type {
  BranchAnalytics,
  BranchesPageData,
  BranchListResponse,
  BranchPageDetail,
  BranchPrCommentsResponse,
  BranchQueryFilters,
} from "@repo/api/src/types/branch";
import { BranchViewerScope } from "@repo/api/src/types/branch";
import {
  type BranchAnalyticsCohortRequest,
  type BranchAnalyticsCohortResponse,
  branchAnalyticsCohortConsumerResponseSchema,
} from "@repo/api/src/types/branch-analytics-cohort";
import type { BranchSelectedPullRequestQuery } from "@repo/api/src/types/branch-associated-pull-request";
import {
  BranchTraceCompletenessState,
  type BranchTraceResult,
  BranchTraceSessionHydrationState,
  type BranchTraceState,
  BranchTraceUnavailableReason,
  type MergedTraceItem,
  type NormalizedBranchTracePage,
  normalizeBranchTracePage,
  unavailableBranchTraceResult,
} from "@repo/api/src/types/branch-trace";
import type { BranchUsageSummary } from "@repo/api/src/types/branch-usage";
import { ReadSource } from "@repo/api/src/types/read-source";
import { ApiError } from "../../shared/api/api-error";
import { buildSearchParams } from "../../shared/lib/format-utils";
import { withReadSource } from "../../shared/lib/read-source";
import { reflectToSettled } from "../../shared/lib/reflect-settled";

const BRANCH_TRACE_PAGE_LIMIT = 100;
const BRANCH_LIST_PAGE_LIMIT = 100;
const BRANCH_LIST_PAGE_CONCURRENCY = 4;

// `BranchQueryFilters` is now defined canonically in `@repo/api/src/types/branch`
// (one home shared by both surfaces — AGENTS.md). Re-exported here so the
// data-source port and `../hooks/use-branches` keep their existing import paths.
export type { BranchQueryFilters } from "@repo/api/src/types/branch";

/** A change notification surfaced by a live-capable data source. */
export type BranchesChange = { branchId?: string };

export type BranchListOptions = BranchQueryFilters & {
  forceRefresh?: boolean;
};

export type BranchDetailOptions = BranchSelectedPullRequestQuery & {
  forceRefresh?: boolean;
};

export type BranchCommentsOptions = BranchSelectedPullRequestQuery;

export type BranchTraceOptions = {
  signal?: AbortSignal;
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
  comments(
    id: string,
    options?: BranchCommentsOptions
  ): Promise<BranchPrCommentsResponse>;
  /**
   * The events-heavy cross-session merged trace (PLN-1148 Phase 2), fetched
   * lazily only when the Sessions & timeline tab opens — split out of `detail` so
   * the default view never loads the trace's multi-KB event payloads. Session
   * and page failures resolve as typed incomplete evidence; request cancellation
   * still propagates to the query lifecycle.
   */
  trace(id: string, options?: BranchTraceOptions): Promise<BranchTraceResult>;
  usage(filters: BranchQueryFilters): Promise<BranchUsageSummary>;
  analytics(filters: BranchQueryFilters): Promise<BranchAnalytics>;
  /**
   * Additive exact-cohort analytics. Optional so older injected sources and
   * installed Desktop preloads degrade to unavailable instead of crashing.
   */
  cohortAnalytics?(
    request: BranchAnalyticsCohortRequest
  ): Promise<BranchAnalyticsCohortResponse | null>;
  /**
   * Combined list + analytics read (FEA-3056 follow-up). The Branches screen
   * mounts both together on every load; callers that need both should prefer
   * this over separate `list`/`analytics` calls so an implementation can serve
   * them from one shared read instead of two independent scans of the same
   * underlying rows.
   */
  pageData(filters: BranchListOptions): Promise<BranchesPageData>;
  subscribe?(onChange: (change: BranchesChange) => void): () => void;
};

/** The slice of the API client the HTTP data source needs. */
type BranchesHttpClient = {
  get<T>(path: string, options?: RequestInit): Promise<T>;
  post?<T>(path: string, body?: unknown): Promise<T>;
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
 * follows every page internally and preserves the additive membership envelope
 * alongside the loaded items current detail consumers render.
 */
export function createHttpBranchesDataSource(
  api: BranchesHttpClient
): BranchesDataSource {
  return {
    scope: "http",
    list: (filters) => getCompleteBranchList(api, filters),
    detail: (id, options) =>
      api.get<BranchPageDetail>(
        selectedPullRequestPath(`/branches/${id}`, options)
      ),
    comments: (id, options) =>
      api.get<BranchPrCommentsResponse>(
        selectedPullRequestPath(`/branches/${id}/comments`, options)
      ),
    trace: (id, options) => getCompleteTrace(api, id, options),
    usage: (filters) =>
      api.get<BranchUsageSummary>(withQuery("/branches/usage", filters)),
    analytics: (filters) =>
      api.get<BranchAnalytics>(withQuery("/branches/analytics", filters)),
    cohortAnalytics: async (request) => {
      if (!api.post) {
        return null;
      }
      try {
        return branchAnalyticsCohortConsumerResponseSchema.parse(
          await api.post<unknown>("/branches/analytics/cohort", request)
        );
      } catch (error) {
        if (
          error instanceof ApiError &&
          (error.status === 404 || error.status === 410 || error.status === 501)
        ) {
          return null;
        }
        throw error;
      }
    },
    // No combined REST route yet — the redundant-read cost this exists to avoid
    // is a desktop-local (SQLite/IPC) concern; apps/api has no analogous doubled
    // scan today. Fetching both concurrently still saves one round trip's worth
    // of wall-clock time versus sequential awaits.
    //
    // FEA-4177 — independent failure domains: these are two separate requests, so
    // `Promise.all` would give them ONE failure domain (an analytics failure
    // would reject the whole read and blank the table). The list is the required
    // half (rethrow its rejection so the table shows a real error), but an
    // analytics rejection degrades ONLY the summary cards (`analytics` omitted,
    // `analyticsError: true`) while the list still renders.
    //
    // wongk review: don't `await Promise.allSettled([list, analytics])` — that
    // makes the required list WAIT for the optional analytics request, so a list
    // that has already failed while analytics stalls never surfaces its rejection
    // and the page hangs on loading. Reflect the analytics promise to a settled
    // result IMMEDIATELY, await the list DIRECTLY (its rejection propagates the
    // instant it lands), then inspect analytics only after the list resolves.
    pageData: async (filters) => {
      const listPromise = getCompleteBranchList(api, filters);
      const analyticsResultPromise = reflectToSettled(
        api.get<BranchAnalytics>(withQuery("/branches/analytics", filters))
      );
      const list = await listPromise;
      const analyticsResult = await analyticsResultPromise;
      if (analyticsResult.status === "rejected") {
        return { list, analyticsError: true };
      }
      return { list, analytics: analyticsResult.value };
    },
    // no `subscribe` — HTTP is poll-only, exactly like the Sessions HTTP source.
  };
}

function selectedPullRequestPath(
  path: string,
  selection?: BranchSelectedPullRequestQuery
): string {
  if (
    selection?.repositoryFullName === undefined ||
    selection.pullRequestNumber === undefined
  ) {
    return path;
  }
  const searchParams = new URLSearchParams({
    repositoryFullName: selection.repositoryFullName,
    pullRequestNumber: String(selection.pullRequestNumber),
  });
  return `${path}?${searchParams.toString()}`;
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

  const firstPage = await getBranchListPage(api, filters, 0);
  const discoveredRemainingPageCount = getRemainingBranchListPageCount(
    firstPage.total
  );
  const remainingPageCount =
    firstPage.hasMore === true && firstPage.items.length > 0
      ? discoveredRemainingPageCount
      : 0;
  if (firstPage.hasMore === true && firstPage.items.length > 0) {
    assertCompleteBranchListPage(firstPage, 0, firstPage.total);
  }
  const remainingPages = await getRemainingBranchListPages(
    api,
    filters,
    remainingPageCount,
    firstPage.total
  );
  const pages = [firstPage, ...remainingPages];
  const items: BranchListResponse["items"] = [];
  const total = firstPage.total;
  let viewerScope: BranchListResponse["viewerScope"] | undefined;
  // FEA-3120: honor a server-provided source if any page reports one (all pages
  // come from the same cloud route, so it is uniform); otherwise default to
  // `cloud` since this HTTP boundary always reads synced cloud state.
  let readSource: ReadSource = ReadSource.Cloud;
  // FEA-3695: each page carries the authoritative per-session cost for ITS rows'
  // sessions. Merge them into one map spanning every page — a session's cost is
  // identical wherever it appears (it is the session's OWN captured cost, not a
  // per-branch attribution), so first-seen wins and re-observing a shared session
  // on a later page never re-adds it. Absent on older producers → stays empty and
  // the client falls back to the legacy branch-total inference.
  const sessionCost = newSessionMapAccumulator();
  // ISS-4632: the lifetime (un-windowed) counterpart, merged identically across
  // pages. Feeds the client's Value-per-$ ratio denominator. Absent on older
  // producers → stays empty and the client falls back to the windowed map.
  const lifetimeSessionCost = newSessionMapAccumulator();
  // ISS-4689: each session's GLOBAL corpus-member branch count — the
  // window-independent even-split divisor for the Value-per-$ denominator. Merged
  // the same way: a session's global branch count is a property of the SESSION,
  // not of the page it surfaced on, so re-observing it never changes the value.
  const sessionBranchCountAccumulator = newSessionMapAccumulator();

  for (const response of pages) {
    items.push(...response.items);
    viewerScope = response.viewerScope;
    if (response.readSource) {
      readSource = response.readSource;
    }
    // `sessionCostUsd` is the OLDEST of the three maps, so its presence is what
    // marks a page as new-shape for the two later ones (see
    // `observeSessionMapPage`); it has no earlier map to be skewed against.
    const pageIsNewShape = Boolean(response.sessionCostUsd);
    observeSessionMapPage(sessionCost, response.sessionCostUsd, false);
    observeSessionMapPage(
      lifetimeSessionCost,
      response.lifetimeSessionCostUsd,
      pageIsNewShape
    );
    observeSessionMapPage(
      sessionBranchCountAccumulator,
      response.sessionBranchCount,
      pageIsNewShape
    );
  }

  const sessionCostUsd = publishSessionMap(sessionCost);
  const lifetimeSessionCostUsd = publishSessionMap(lifetimeSessionCost);
  const sessionBranchCount = publishSessionMap(sessionBranchCountAccumulator);
  return {
    items,
    total,
    viewerScope: viewerScope ?? BranchViewerScope.Organization,
    hasMore: false,
    readSource,
    ...(sessionCostUsd ? { sessionCostUsd } : {}),
    ...(lifetimeSessionCostUsd ? { lifetimeSessionCostUsd } : {}),
    ...(sessionBranchCount ? { sessionBranchCount } : {}),
  };
}

async function getCompleteTrace(
  api: BranchesHttpClient,
  id: string,
  options?: BranchTraceOptions
): Promise<BranchTraceResult> {
  const items: MergedTraceItem[] = [];
  let offset = 0;
  let hasMore = true;
  let traceState: BranchTraceState | null = null;
  let sawLegacyMetadata = false;

  try {
    while (hasMore) {
      const rawPage = await getTracePage(
        api,
        tracePagePath(id, offset),
        options?.signal
      );
      const page = normalizeBranchTracePage(rawPage);
      if (!page) {
        return degradedTraceResult(
          items,
          traceState,
          BranchTraceUnavailableReason.Malformed
        );
      }
      const metadata = reconcileTracePageMetadata(
        page,
        traceState,
        sawLegacyMetadata,
        id
      );
      if (metadata.degraded) {
        const degradedItems = metadata.retainPageItems
          ? [...items, ...page.items]
          : items;
        return degradedTraceResult(
          degradedItems,
          metadata.traceState,
          metadata.reason
        );
      }
      items.push(...page.items);
      traceState = metadata.traceState;
      sawLegacyMetadata = metadata.sawLegacyMetadata;
      if (page.hasMore && page.items.length === 0) {
        return degradedTraceResult(
          items,
          traceState,
          BranchTraceUnavailableReason.PageFailure
        );
      }
      offset += page.items.length;
      hasMore = page.hasMore;
    }
  } catch (error) {
    if (options?.signal?.aborted || isAbortError(error)) {
      throw error;
    }
    return degradedTraceResult(items, traceState, pageFailureReason(error));
  }

  if (!traceState) {
    return unavailableBranchTraceResult(
      items,
      BranchTraceUnavailableReason.LegacyResponse
    );
  }
  if (sawLegacyMetadata) {
    return degradedTraceResult(
      items,
      traceState,
      BranchTraceUnavailableReason.LegacyResponse
    );
  }
  return { items, ...traceState };
}

function reconcileTracePageMetadata(
  page: NormalizedBranchTracePage,
  traceState: BranchTraceState | null,
  sawLegacyMetadata: boolean,
  requestedBranchId: string
): {
  traceState: BranchTraceState | null;
  sawLegacyMetadata: boolean;
  degraded?: true;
  reason: BranchTraceUnavailableReason;
  retainPageItems: boolean;
} {
  const pageIsLegacy =
    page.metadataReason === BranchTraceUnavailableReason.LegacyResponse;
  const sawLegacy = sawLegacyMetadata || pageIsLegacy;
  if (
    page.branchId !== requestedBranchId ||
    page.viewerScope !== BranchViewerScope.Organization
  ) {
    return {
      traceState,
      sawLegacyMetadata: sawLegacy,
      degraded: true,
      reason: BranchTraceUnavailableReason.Malformed,
      retainPageItems: false,
    };
  }
  if (page.metadataReason && !pageIsLegacy) {
    return {
      traceState: traceState ?? page.traceState,
      sawLegacyMetadata: sawLegacy,
      degraded: true,
      reason: page.metadataReason,
      retainPageItems: pageItemsBelongToLoadedSessions(
        page.items,
        traceState ?? page.traceState
      ),
    };
  }
  if (
    page.traceState &&
    (sawLegacy ||
      (traceState && !traceStatesEqual(traceState, page.traceState)))
  ) {
    return {
      traceState,
      sawLegacyMetadata: sawLegacy,
      degraded: true,
      reason: BranchTraceUnavailableReason.PageFailure,
      retainPageItems: pageItemsBelongToLoadedSessions(
        page.items,
        traceState ?? page.traceState
      ),
    };
  }
  const effectiveState = traceState ?? page.traceState;
  if (
    effectiveState &&
    !pageItemsBelongToLoadedSessions(page.items, effectiveState)
  ) {
    return {
      traceState,
      sawLegacyMetadata: sawLegacy,
      degraded: true,
      reason: BranchTraceUnavailableReason.Malformed,
      retainPageItems: false,
    };
  }
  return {
    traceState: effectiveState,
    sawLegacyMetadata: sawLegacy,
    reason: BranchTraceUnavailableReason.Unknown,
    retainPageItems: true,
  };
}

function pageItemsBelongToLoadedSessions(
  items: readonly MergedTraceItem[],
  traceState: BranchTraceState | null
): boolean {
  if (!traceState) {
    return false;
  }
  const loadedSessionIds = new Set(
    traceState.sessions
      .filter(
        (session) => session.state === BranchTraceSessionHydrationState.Loaded
      )
      .map((session) => session.identity.artifactId)
  );
  return items.every((item) => loadedSessionIds.has(item.sessionId));
}

function tracePagePath(id: string, offset: number): string {
  return `/branches/${id}/trace?limit=${BRANCH_TRACE_PAGE_LIMIT}&offset=${offset}`;
}

function getTracePage(
  api: BranchesHttpClient,
  path: string,
  signal?: AbortSignal
): Promise<unknown> {
  return signal ? api.get<unknown>(path, { signal }) : api.get<unknown>(path);
}

function degradedTraceResult(
  items: MergedTraceItem[],
  traceState: BranchTraceState | null,
  reason: BranchTraceUnavailableReason
): BranchTraceResult {
  if (!traceState) {
    return unavailableBranchTraceResult(items, reason);
  }
  const observedSessionIds = new Set(items.map((item) => item.sessionId));
  const sessions = traceState.sessions.map((session) => {
    if (
      session.state === BranchTraceSessionHydrationState.Loaded &&
      !observedSessionIds.has(session.identity.artifactId)
    ) {
      return {
        identity: session.identity,
        state: BranchTraceSessionHydrationState.Unavailable,
        reason,
      } as const;
    }
    return session;
  });
  const state =
    items.length > 0
      ? BranchTraceCompletenessState.Incomplete
      : BranchTraceCompletenessState.Unavailable;
  // ISS-5075: a page failure does not un-truncate the pages that DID arrive, so
  // the server's truncation signal survives the client's degrade rather than
  // being replaced by the transport reason alone.
  const truncation: { eventsTruncated?: true } = traceState.completeness
    .eventsTruncated
    ? { eventsTruncated: true }
    : {};
  return {
    items,
    sessions,
    qualifyingSessionCount: traceState.qualifyingSessionCount,
    completeness: { state, reason, ...truncation },
    aggregateCompleteness: { state, reason, ...truncation },
  };
}

function traceStatesEqual(
  left: BranchTraceState,
  right: BranchTraceState
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pageFailureReason(error: unknown): BranchTraceUnavailableReason {
  if (error instanceof ApiError && error.status === 401) {
    return BranchTraceUnavailableReason.Authentication;
  }
  if (error instanceof ApiError && error.status === 403) {
    return BranchTraceUnavailableReason.Permission;
  }
  return BranchTraceUnavailableReason.PageFailure;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * One optional, session-keyed wire map accumulated across the pages of a single
 * list read: the merged values, whether any page supplied the map at all, and
 * whether a page was seen that SHOULD have supplied it but did not.
 */
type SessionMapAccumulator = {
  merged: Record<string, number>;
  saw: boolean;
  skewed: boolean;
};

function newSessionMapAccumulator(): SessionMapAccumulator {
  return { merged: {}, saw: false, skewed: false };
}

/**
 * Fold one page's session-keyed map into an accumulator with first-seen-wins
 * semantics: every value merged here is a property of the SESSION — its OWN
 * captured cost (not a per-branch attribution), or its global branch count — so
 * it is identical wherever the session appears and re-observing a session shared
 * across pages never re-adds it.
 *
 * `pageIsNewShape` (wongk/codex review, ISS-4632) detects a deployment straddling
 * pagination: a NEW-shape page supplies the map while an OLD-shape page from the
 * same request contributes nothing, leaving a PARTIAL map that
 * `deriveFilteredBranchAnalytics` would treat as authoritative — silently dropping
 * the older pages' sessions from the Value-per-$ denominator. The producers' own
 * invariant is the detector: a page emits the lifetime cost map and the
 * `sessionBranchCount` divisor IFF it emits the windowed `sessionCostUsd` (all
 * three derive from the same page usage — see branch-read-service
 * `pageSessionCost` / `pageLifetimeSessionCost` / `pageSessionBranchCount`). So a
 * page that supplied `sessionCostUsd` but not this map is old-shape, and
 * `publishSessionMap` then suppresses the whole map rather than publish a partial.
 */
function observeSessionMapPage(
  accumulator: SessionMapAccumulator,
  page: Readonly<Record<string, number>> | undefined,
  pageIsNewShape: boolean
): void {
  if (page) {
    accumulator.saw = true;
    for (const [sessionId, value] of Object.entries(page)) {
      if (!Object.hasOwn(accumulator.merged, sessionId)) {
        accumulator.merged[sessionId] = value;
      }
    }
    return;
  }
  if (pageIsNewShape) {
    accumulator.skewed = true;
  }
}

/**
 * The merged map, or `undefined` when no page supplied it (older producer) or a
 * mid-deploy page left it partial. All-or-nothing on purpose: the client treats a
 * present map as authoritative, so half a map is worse than none — it would price
 * or divide some sessions one way and the rest another inside ONE denominator.
 */
function publishSessionMap(
  accumulator: SessionMapAccumulator
): Record<string, number> | undefined {
  if (accumulator.saw && !accumulator.skewed) {
    return accumulator.merged;
  }
  return;
}

function getBranchListPage(
  api: BranchesHttpClient,
  filters: BranchQueryFilters,
  offset: number
): Promise<BranchListResponse> {
  return api.get<BranchListResponse>(
    withQuery("/branches", {
      ...filters,
      limit: BRANCH_LIST_PAGE_LIMIT,
      offset,
    })
  );
}

/** Derive the remaining page count from the first response's total. */
function getRemainingBranchListPageCount(total: number): number {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new RangeError("Branches list returned an invalid total");
  }
  return Math.max(0, Math.ceil(total / BRANCH_LIST_PAGE_LIMIT) - 1);
}

/**
 * Fetch remaining pages through a fixed worker pool while storing each response
 * at its page index, so later folding is independent of completion order. Page
 * indices are claimed lazily to avoid allocating an unbounded offset queue from
 * corrupt-but-safe integer totals. Once a request rejects, active requests may
 * settle but no worker claims another page.
 */
async function getRemainingBranchListPages(
  api: BranchesHttpClient,
  filters: BranchQueryFilters,
  pageCount: number,
  total: number
): Promise<BranchListResponse[]> {
  const pages = new Map<number, BranchListResponse>();
  let nextPageIndex = 1;
  let failed = false;
  let firstError: unknown;

  const fetchNextPages = async (): Promise<void> => {
    while (!failed) {
      const pageIndex = nextPageIndex;
      nextPageIndex += 1;
      if (pageIndex > pageCount) {
        return;
      }

      try {
        const page = await getBranchListPage(
          api,
          filters,
          pageIndex * BRANCH_LIST_PAGE_LIMIT
        );
        assertCompleteBranchListPage(page, pageIndex, total);
        pages.set(pageIndex, page);
      } catch (error) {
        if (!failed) {
          firstError = error;
        }
        failed = true;
        return;
      }
    }
  };

  const workerCount = Math.min(BRANCH_LIST_PAGE_CONCURRENCY, pageCount);
  await Promise.all(
    Array.from({ length: workerCount }, () => fetchNextPages())
  );
  if (failed) {
    throw firstError;
  }
  return Array.from(pages.entries())
    .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
    .map(([, page]) => page);
}

/** Fail closed when a page cannot reconcile with page one's cohort total. */
function assertCompleteBranchListPage(
  page: BranchListResponse,
  pageIndex: number,
  total: number
): void {
  const offset = pageIndex * BRANCH_LIST_PAGE_LIMIT;
  const expectedItemCount = Math.min(
    BRANCH_LIST_PAGE_LIMIT,
    Math.max(0, total - offset)
  );
  const expectedHasMore = offset + expectedItemCount < total;
  if (
    page.items.length !== expectedItemCount ||
    page.hasMore !== expectedHasMore
  ) {
    throw new RangeError("Branches list pagination metadata is inconsistent");
  }
}
