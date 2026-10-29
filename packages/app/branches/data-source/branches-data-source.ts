import type { ArtifactActivityFeedResult } from "@repo/api/src/types/artifact-activity-feed";
import {
  type ArtifactCollaboratorBatchResponse,
  CollaboratorArtifactType,
} from "@repo/api/src/types/artifact-collaborators";
import type {
  UpdateArtifactPriorityRequest,
  UpdateBranchPriorityResponse,
} from "@repo/api/src/types/artifact-priority-mutation";
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
import type {
  BranchSelectedPullRequestIdentity,
  BranchSelectedPullRequestQuery,
} from "@repo/api/src/types/branch-associated-pull-request";
import {
  branchLastActiveCohortSchema,
  branchListCohortKey,
} from "@repo/api/src/types/branch-list-cohort";
import {
  BRANCH_LIST_INVALID_PAGE_RESPONSE_CODE,
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListPageMode,
  type BranchListStatusOrderingResponse,
} from "@repo/api/src/types/branch-list-contract";
import { BRANCH_LIST_COMPLETE_COHORT_PAGE_SIZE } from "@repo/api/src/types/branch-list-work-budget";
import type { BranchSelectedPullRequestDetailResponse } from "@repo/api/src/types/branch-selected-pull-request-detail";
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
import type { BranchTracePageResult } from "@repo/api/src/types/branch-trace-paging";
import type { BranchUsageSummary } from "@repo/api/src/types/branch-usage";
import { ReadSource } from "@repo/api/src/types/read-source";
import { ApiError } from "../../shared/api/api-error";
import { readArtifactCollaborators } from "../../shared/lib/artifact-collaborators";
import { withReadSource } from "../../shared/lib/read-source";
import { reflectToSettled } from "../../shared/lib/reflect-settled";
import {
  type BranchActivityPageRequest,
  branchActivityPagePath,
} from "./branch-activity-page-path";
import {
  type BranchCustomFieldValuesRead,
  httpBranchCustomFieldValuesRead,
} from "./branch-custom-field-values";
import {
  readBranchDetailWithLazyChecks,
  readBranchSelectedPullRequestDetail,
} from "./branch-detail-read";
import { branchListPath, withQuery } from "./branch-request-path";
import {
  hasBranchServerPageCapability,
  parseBranchServerPageResponse,
} from "./branch-server-page-response";
import { readBranchTracePage } from "./branch-trace-page";
import {
  type CompleteBranchListWork,
  readCompleteBranchListPages,
} from "./complete-branch-list-read";
import {
  isLegacyServerPageQueryRejection,
  readBranchListStatusOrdering,
  readServerPageData,
} from "./server-page-data";

const BRANCH_TRACE_PAGE_LIMIT = 100;

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

export type BranchTracePageOptions = BranchTraceOptions & { cursor?: string };

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
export type BranchesDataSource = BranchCustomFieldValuesRead & {
  /**
   * Stable identity for the active source. Folded into the filter-based React
   * Query keys (see `branchesKeys`) so a surface that swaps sources — desktop
   * moving between its local DB and the authenticated backend — never serves
   * one source's rows from another's cached filters. Keep values short and
   * stable (the HTTP source uses `"http"`; the local source uses `"local"`).
   */
  scope: string;
  /** HTTP/cloud sources can render list rows independently of analytics. */
  supportsSplitPageData?: boolean;
  /**
   * ISS-12456: whether this source can ever serve `tags` — a cloud Artifact
   * concept the desktop local store's rows carry no identity for. The
   * Branches host keys the Tags column's visibility on this rather than on
   * any one row's `tagAvailability`, mirroring `updatePriority`'s opt-in.
   */
  supportsTags?: boolean;
  /**
   * ISS-12456: whether this source can ever serve `project` — same cloud
   * Artifact-identity gap as `supportsTags`.
   */
  supportsProject?: boolean;
  list(filters: BranchListOptions): Promise<BranchListResponse>;
  /** Rejects (404 ApiError) when missing; never resolves null. */
  detail(id: string, options?: BranchDetailOptions): Promise<BranchPageDetail>;
  /** Additive: older/local adapters can project their existing detail read. */
  selectedPullRequestDetail?(
    id: string,
    selection: BranchSelectedPullRequestIdentity
  ): Promise<BranchSelectedPullRequestDetailResponse | BranchPageDetail>;
  /** Optional for older adapters; null means the cloud endpoint is unavailable. */
  collaborators?(
    artifactIds: readonly string[]
  ): Promise<ArtifactCollaboratorBatchResponse | null>;
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
  tracePage?(
    id: string,
    options?: BranchTracePageOptions
  ): Promise<BranchTracePageResult>;
  /**
   * ISS-10980: one newest-first page of a branch's Activity feed, from
   * `GET /branches/[id]/activity` (ISS-10994). Optional for the same reason the
   * Session port's `activityPage` is: desktop Local mode has no synced
   * activity, and the Activity tab reads that absence as its empty state
   * rather than as a failed read.
   */
  activityPage?(
    request: BranchActivityPageRequest
  ): Promise<ArtifactActivityFeedResult>;
  usage(filters: BranchQueryFilters): Promise<BranchUsageSummary>;
  analytics(filters: BranchQueryFilters): Promise<BranchAnalytics>;
  /**
   * ISS-9437 — optional pre-list read of the ordering the producer says it is
   * serving. Optional so older injected sources degrade to today's behavior.
   */
  listStatusOrdering?(): Promise<BranchListStatusOrderingResponse | null>;
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
  /**
   * ISS-10332 / PLN-2086 Milestone 2: set or clear one branch's priority — the
   * WRITE half of the port and the seam the Priority cell's mutation reads
   * through, so the desktop local store supplies its own implementation
   * (Milestone 3) without the hook, the cell or the grid changing. Optional
   * like `subscribe`: a source that cannot write offers no method, and the cell
   * renders the mark read-only rather than a control that cannot commit.
   */
  updatePriority?(
    id: string,
    input: UpdateArtifactPriorityRequest
  ): Promise<UpdateBranchPriorityResponse>;
};

/** The slice of the API client the HTTP data source needs. */
type BranchesHttpClient = {
  get<T>(path: string, options?: RequestInit): Promise<T>;
  post?<T>(path: string, body?: unknown): Promise<T>;
  /** ISS-10332: the write verb `updatePriority` rides; optional like `post`. */
  patch?<T>(path: string, body: unknown): Promise<T>;
};

export type BranchesHttpDataSourceOptions = {
  observeBranchListWork?: (work: CompleteBranchListWork) => void;
  /**
   * PRD-721 / ISS-9346: send the list read's filter and sort as the canonical
   * `listQuery` expression. Defaults on, because the web app deploys with the
   * API that compiles it. A caller whose API may be older than that compiler
   * (an installed Desktop build reading the cloud) turns it off: an older
   * route refuses the unknown param.
   */
  canonicalListQuery?: boolean;
};

/**
 * The HTTP data source — the single place that builds the REST URLs/query
 * strings. Used by the web shell and by authenticated desktop.
 *
 * The trace route returns pagination metadata for REST clients. This adapter
 * follows every page internally and preserves the additive membership envelope
 * alongside the loaded items current detail consumers render.
 */
export function createHttpBranchesDataSource(
  api: BranchesHttpClient,
  options: BranchesHttpDataSourceOptions = {}
): BranchesDataSource {
  const patch = api.patch;
  return {
    scope: HTTP_BRANCHES_DATA_SOURCE_SCOPE,
    supportsSplitPageData: true,
    supportsTags: true,
    supportsProject: true,
    list: (filters) => getBranchListWithServerFallback(api, filters, options),
    detail: (id, options) => readBranchDetailWithLazyChecks(api, id, options),
    selectedPullRequestDetail: (id, selection) =>
      readBranchSelectedPullRequestDetail(api, id, selection),
    collaborators: (artifactIds) =>
      readArtifactCollaborators(
        api,
        CollaboratorArtifactType.Branch,
        artifactIds
      ),
    comments: (id, options) =>
      api.get<BranchPrCommentsResponse>(
        selectedPullRequestPath(`/branches/${id}/comments`, options)
      ),
    trace: (id, options) => getCompleteTrace(api, id, options),
    tracePage: (id, options) =>
      readBranchTracePage(
        api.get.bind(api),
        (branchId, traceOptions) =>
          getCompleteTrace(api, branchId, traceOptions),
        id,
        options
      ),
    activityPage: (request) =>
      api.get<ArtifactActivityFeedResult>(branchActivityPagePath(request)),
    ...httpBranchCustomFieldValuesRead(api),
    usage: (filters) =>
      api.get<BranchUsageSummary>(withQuery("/branches/usage", filters)),
    analytics: (filters) => getBranchAnalyticsWithServerFallback(api, filters),
    listStatusOrdering: () => readBranchListStatusOrdering(api),
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
    // FEA-4177: list is required, analytics is optional. Reflect analytics
    // immediately so a stalled optional read cannot hide a list failure.
    pageData: async (filters) => {
      if (filters.pageMode === BranchListPageMode.Server) {
        return readServerPageData(filters, {
          readList: (nextFilters) =>
            getCompleteBranchList(api, nextFilters, options),
          readAnalytics: (nextFilters) =>
            getBranchAnalyticsWithServerFallback(api, nextFilters),
          readLegacy: (nextFilters) =>
            getLegacyPageData(api, nextFilters, options),
          parseCurrentPage: parseCurrentServerPage,
        });
      }
      const listPromise = getCompleteBranchList(api, filters, options);
      const analyticsResultPromise = reflectToSettled(
        getBranchAnalyticsWithServerFallback(api, filters)
      );
      const list = await listPromise;
      const analyticsResult = await analyticsResultPromise;
      if (analyticsResult.status === "rejected") {
        return { list, analyticsError: true };
      }
      return { list, analytics: analyticsResult.value };
    },
    // ISS-10332: `PATCH /branches/[id]`, a strict `{priority, expectedPriority?,
    // surface?}` body (PLN-2086 Milestone 1). Offered only when the client can
    // PATCH, so a read-only double never advertises a write it cannot make.
    ...(patch
      ? {
          updatePriority: (id: string, input: UpdateArtifactPriorityRequest) =>
            patch<UpdateBranchPriorityResponse>(`/branches/${id}`, input),
        }
      : {}),
    // no `subscribe` — HTTP is poll-only, exactly like the Sessions HTTP source.
  };
}

async function getBranchListWithServerFallback(
  api: BranchesHttpClient,
  filters: BranchListOptions,
  options: BranchesHttpDataSourceOptions
): Promise<BranchListResponse> {
  if (filters.pageMode !== BranchListPageMode.Server) {
    return getCompleteBranchList(api, filters, options);
  }
  try {
    const response = await getCompleteBranchList(api, filters, options);
    const current = parseCurrentServerPage(response);
    return (
      current ?? getCompleteBranchList(api, legacyFilters(filters), options)
    );
  } catch (error) {
    if (!isLegacyServerPageQueryRejection(error)) {
      throw error;
    }
    return getCompleteBranchList(api, legacyFilters(filters), options);
  }
}

async function getLegacyPageData(
  api: BranchesHttpClient,
  filters: BranchListOptions,
  options: BranchesHttpDataSourceOptions
): Promise<BranchesPageData> {
  const legacy = legacyFilters(filters);
  const listPromise = getCompleteBranchList(api, legacy, options);
  const analyticsResultPromise = reflectToSettled(
    getBranchAnalyticsWithServerFallback(api, legacy)
  );
  const list = await listPromise;
  const analyticsResult = await analyticsResultPromise;
  return analyticsResult.status === "rejected"
    ? { list, analyticsError: true }
    : { list, analytics: analyticsResult.value };
}

async function getBranchAnalyticsWithServerFallback(
  api: BranchesHttpClient,
  filters: BranchQueryFilters
): Promise<BranchAnalytics> {
  try {
    return await api.get<BranchAnalytics>(
      withQuery("/branches/analytics", filters)
    );
  } catch (error) {
    if (
      filters.pageMode !== BranchListPageMode.Server ||
      !isLegacyServerAnalyticsRejection(error)
    ) {
      throw error;
    }
    return api.get<BranchAnalytics>(
      withQuery("/branches/analytics", legacyServerAnalyticsFilters(filters))
    );
  }
}

function parseCurrentServerPage(
  response: BranchListResponse
): BranchListResponse | null {
  if (!hasBranchServerPageCapability(response)) {
    return null;
  }
  try {
    return parseBranchServerPageResponse(response);
  } catch {
    throw new ApiError(
      "Branches server page response is invalid.",
      502,
      BRANCH_LIST_INVALID_PAGE_RESPONSE_CODE
    );
  }
}

function isLegacyServerAnalyticsRejection(error: unknown): boolean {
  return (
    isLegacyServerPageQueryRejection(error) ||
    (error instanceof ApiError &&
      error.status === 400 &&
      error.message.includes("server pages require"))
  );
}

function legacyFilters(filters: BranchListOptions): BranchQueryFilters {
  return {
    ...(filters.startDate ? { startDate: filters.startDate } : {}),
    ...(filters.endDate ? { endDate: filters.endDate } : {}),
  };
}

function legacyServerAnalyticsFilters(
  filters: BranchListOptions
): BranchQueryFilters {
  const { forceRefresh: _forceRefresh, ...queryFilters } = filters;
  return {
    ...queryFilters,
    limit: BRANCH_LIST_SERVER_PAGE_SIZE,
    offset: 0,
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
  filters: BranchQueryFilters,
  options: BranchesHttpDataSourceOptions
): Promise<BranchListResponse> {
  if (filters.limit !== undefined || filters.offset !== undefined) {
    return withReadSource(
      await api.get<BranchListResponse>(
        branchListPath(filters, options.canonicalListQuery)
      ),
      ReadSource.Cloud
    );
  }

  const { pages, work } = await readCompleteBranchListPages((offset) =>
    getBranchListPage(api, filters, offset, options)
  );
  options.observeBranchListWork?.(work);
  const firstPage = pages[0];
  if (!firstPage) {
    throw new RangeError("Branches list returned no first page");
  }
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
  const lastActiveCohort = consistentLastActiveCohort(pages, filters);
  return {
    items,
    total,
    viewerScope: viewerScope ?? BranchViewerScope.Organization,
    hasMore: false,
    readSource,
    ...(lastActiveCohort ? { lastActiveCohort } : {}),
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
  try {
    const firstPage = normalizeBranchTracePage(
      await getTracePage(api, completeTracePath(id), options?.signal)
    );
    if (!firstPage || firstPage.metadataReason) {
      return getPaginatedTrace(api, id, options);
    }
    return getPaginatedTrace(api, id, options, firstPage);
  } catch (error) {
    if (options?.signal?.aborted || isAbortError(error)) {
      throw error;
    }
    if (shouldFallbackFromCompleteTraceFailure(error)) {
      return getPaginatedTrace(api, id, options);
    }
    return degradedTraceResult([], null, pageFailureReason(error));
  }
}

async function getPaginatedTrace(
  api: BranchesHttpClient,
  id: string,
  options?: BranchTraceOptions,
  firstPage?: NormalizedBranchTracePage
): Promise<BranchTraceResult> {
  const items: MergedTraceItem[] = [];
  let offset = 0;
  let hasMore = true;
  let traceState: BranchTraceState | null = null;
  let sawLegacyMetadata = false;
  let nextPage = firstPage;

  try {
    while (hasMore) {
      const page =
        nextPage ??
        normalizeBranchTracePage(
          await getTracePage(api, tracePagePath(id, offset), options?.signal)
        );
      nextPage = undefined;
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

function completeTracePath(id: string): string {
  return `/branches/${id}/trace?complete=true`;
}

function getTracePage(
  api: BranchesHttpClient,
  path: string,
  signal?: AbortSignal
): Promise<unknown> {
  return signal ? api.get<unknown>(path, { signal }) : api.get<unknown>(path);
}

function shouldFallbackFromCompleteTraceFailure(error: unknown): boolean {
  if (!(error instanceof ApiError)) {
    return true;
  }
  return !isTerminalCompleteTraceStatus(error.status);
}

function isTerminalCompleteTraceStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 429;
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
  // ISS-8565: null-prototype, because `merged[sessionId]` below is keyed by a
  // session id that can be `__proto__` (a rollout file with no UUID in its name
  // yields the bare filename). On a plain `{}` that write hits the inherited
  // setter and creates no own key, so the session's cost vanished from the
  // merged map even once the page schema started preserving it.
  return { merged: Object.create(null), saw: false, skewed: false };
}

/**
 * Fold one page's session-keyed map into an accumulator with first-seen-wins
 * semantics: every value merged here is a property of the SESSION — its OWN
 * captured cost (not a per-branch attribution), or its global branch count — so
 * it is identical wherever the session appears and re-observing a session shared
 * across pages never re-adds it.
 *
 * `pageIsNewShape` (whitlockk/codex review, ISS-4632) detects a deployment straddling
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
    // Spread DEFINES, so the own `__proto__` key survives while consumers get
    // back the ordinary prototype they expect rather than the null-prototype
    // accumulator.
    return { ...accumulator.merged };
  }
  return;
}

function getBranchListPage(
  api: BranchesHttpClient,
  filters: BranchQueryFilters,
  offset: number,
  options: BranchesHttpDataSourceOptions
): Promise<BranchListResponse> {
  return api.get<BranchListResponse>(
    branchListPath(
      {
        ...filters,
        limit: BRANCH_LIST_COMPLETE_COHORT_PAGE_SIZE,
        offset,
      },
      options.canonicalListQuery
    )
  );
}

function consistentLastActiveCohort(
  pages: readonly BranchListResponse[],
  filters: BranchQueryFilters
): BranchListResponse["lastActiveCohort"] {
  const parsed = pages.map((page) =>
    branchLastActiveCohortSchema.safeParse(page.lastActiveCohort)
  );
  if (parsed.some((result) => !result.success)) {
    return;
  }
  const cohorts = parsed.flatMap((result) =>
    result.success ? [result.data] : []
  );
  const first = cohorts[0];
  if (
    !first ||
    first.cohortKey !== branchListCohortKey(filters) ||
    cohorts.some((cohort) => JSON.stringify(cohort) !== JSON.stringify(first))
  ) {
    return;
  }
  return first;
}

/**
 * `scope` of the default HTTP source. Named so a caller that keys a cache by the
 * active source can name the default without re-typing the literal.
 */
export const HTTP_BRANCHES_DATA_SOURCE_SCOPE = "http";
