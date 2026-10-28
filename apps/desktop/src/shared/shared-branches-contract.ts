import {
  type BranchAnalytics,
  type BranchesPageData,
  type BranchKpi,
  BranchKpiState,
  type BranchListResponse,
  type BranchQueryFilters,
  BranchViewerScope,
  NO_BRANCH_KPI_BASELINE,
} from "@repo/api/src/types/branch";
import type {
  BranchAnalyticsCohortRequest,
  BranchAnalyticsCohortResponse,
} from "@repo/api/src/types/branch-analytics-cohort";
import type { BranchSelectedPullRequestQuery } from "@repo/api/src/types/branch-associated-pull-request";
import type {
  BranchTraceResult,
  MergedTraceItem,
} from "@repo/api/src/types/branch-trace";
import type { BranchUsageSummary } from "@repo/api/src/types/branch-usage";
import type { ListQueryExpression } from "@repo/api/src/types/list-query-expression";

export const SHARED_BRANCHES_IPC_CHANNELS = {
  list: "desktop:shared-branches:list",
  detail: "desktop:shared-branches:detail",
  // PLN-1148 Phase 2: the events-heavy merged trace, split out of `detail` and
  // fetched lazily when the Sessions & timeline tab opens.
  trace: "desktop:shared-branches:trace",
  usage: "desktop:shared-branches:usage",
  analytics: "desktop:shared-branches:analytics",
  cohortAnalytics: "desktop:shared-branches:cohort-analytics",
  // FEA-3056 follow-up: combined list + analytics read for the Branches screen,
  // which mounts both together — see `getSharedBranchesPageData`.
  pageData: "desktop:shared-branches:page-data",
} as const;

/** ISS-8143: from the channel OBJECT, not a side list — see the twin note on
 * `SharedAgentSessionsIpcChannel` for why a list-derived union disarms the
 * exhaustiveness guard it is supposed to feed. */
export type SharedBranchesIpcChannel =
  (typeof SHARED_BRANCHES_IPC_CHANNELS)[keyof typeof SHARED_BRANCHES_IPC_CHANNELS];

/** ISS-8143: DERIVED from the channel object — twin of
 * `SHARED_AGENT_SESSIONS_IPC_CHANNEL_LIST`, and see that note for why a
 * hand-written registration list can drop a channel with nothing in `tsc` to
 * say so. */
export const SHARED_BRANCHES_IPC_CHANNEL_LIST: readonly SharedBranchesIpcChannel[] =
  Object.values(SHARED_BRANCHES_IPC_CHANNELS);

/**
 * The IPC query is exactly the shared port's `BranchQueryFilters` — aliased (not
 * re-declared) so the two cannot drift (AGENTS.md: one canonical type).
 */
export type SharedBranchesQuery = BranchQueryFilters;

/** Internal Desktop IPC hint: the renderer already chose its local read source. */
export const LOCAL_BRANCH_READ = { skipCloudHydration: true } as const;
export type SharedBranchesLocalReadHint = {
  skipCloudHydration?: boolean;
};
export type SharedBranchesLocalReadRequest = SharedBranchesQuery &
  SharedBranchesLocalReadHint & {
    /**
     * PRD-721: the canonical list query expression (ISS-9476), as a structured
     * value under the `LIST_QUERY_EXPRESSION_PARAM` key. Main lowers it into
     * the legacy params above before any read runs
     * (`compileBranchListQueryRequest`), and refuses the request when it cannot
     * serve the expression or when the request also sends a legacy spelling of
     * one of its axes. A Desktop main older than that compiler refuses a
     * server page carrying it (its schema is strict) and reads any other
     * request without it, unwindowed, so only a renderer shipped in the same
     * build sends it.
     */
    listQuery?: ListQueryExpression;
  };
export type SharedBranchCohortLocalReadRequest = BranchAnalyticsCohortRequest &
  SharedBranchesLocalReadHint;

export type SharedBranchAnalyticsCohortRequest = BranchAnalyticsCohortRequest;
export type SharedBranchAnalyticsCohortResponse = BranchAnalyticsCohortResponse;

export type SharedBranchesListRequest = SharedBranchesLocalReadRequest & {
  ids?: readonly string[];
  forceRefresh?: boolean;
};

export type SharedBranchesDetailRequest = BranchSelectedPullRequestQuery & {
  id: string;
  forceRefresh?: boolean;
} & SharedBranchesLocalReadHint;

/** Current Desktop trace envelope plus the raw-array shape from older mains. */
export type SharedBranchTraceResponse = BranchTraceResult | MergedTraceItem[];

/**
 * Combined response for the `pageData` channel — see `getSharedBranchesPageData`.
 * Aliased (not re-declared) to the canonical `BranchesPageData` shape so the
 * two cannot drift (AGENTS.md: one canonical type).
 */
export type SharedBranchesPageDataResponse = BranchesPageData;

export const SHARED_BRANCHES_NOT_FOUND_CODE = "LOCAL_BRANCH_NOT_FOUND" as const;
export const SHARED_BRANCHES_SOURCE_ERROR_CODE =
  "LOCAL_BRANCHES_SOURCE_ERROR" as const;
/**
 * ISS-4483 (review cid 3679616167, whitlockk): the error code stamped on a TRANSIENT
 * local Branches read failure — the db-host child restarting / crash-looping
 * mid-backfill. Distinct from the fatal {@link SHARED_BRANCHES_SOURCE_ERROR_CODE}
 * so the renderer routes it to the quiet reconnecting surface (bounded retry)
 * rather than the hard error card. The Branches main-process boundary
 * (`rethrowAsSourceError` in `shared-branches-api.ts`) maps a db-host lifecycle
 * signature to this code before the sanitized error crosses IPC, so the renderer's
 * `runSource` classifier can recognize it (it never sees the raw "db-host exited"
 * message, which that boundary discards).
 */
export const SHARED_BRANCHES_TRANSIENT_ERROR_CODE =
  "LOCAL_BRANCHES_SOURCE_TRANSIENT" as const;

/** Canonical "no data" KPI — used by every gated/unavailable analytics field. */
function unavailableKpi(): BranchKpi {
  return {
    value: null,
    state: BranchKpiState.Unavailable,
    // ISS-4686 — a scoped baseline is required the day one is wired here.
    ...NO_BRANCH_KPI_BASELINE,
  };
}

/** Empty canonical list response for disabled or unsupported local reads. */
export function emptySharedBranchesListResponse(): BranchListResponse {
  return {
    items: [],
    total: 0,
    viewerScope: BranchViewerScope.Self,
  };
}

/** Empty canonical usage summary for disabled or unsupported local reads. */
export function emptySharedBranchesUsageSummary(): BranchUsageSummary {
  return {
    viewerScope: BranchViewerScope.Self,
    totalBranches: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalEstimatedCost: 0,
    subscriptionEstimatedCost: 0,
    apiEstimatedCost: 0,
    hourBuckets: [],
    phaseStacks: [],
    byActor: [],
  };
}

/** Empty canonical combined response for disabled or unsupported local reads. */
export function emptySharedBranchesPageDataResponse(): SharedBranchesPageDataResponse {
  return {
    list: emptySharedBranchesListResponse(),
    analytics: emptySharedBranchesAnalytics(),
  };
}

/** Empty canonical analytics response for disabled or unsupported local reads. */
export function emptySharedBranchesAnalytics(): BranchAnalytics {
  return {
    viewerScope: BranchViewerScope.Self,
    medianPrSize: unavailableKpi(),
    mergeRate: unavailableKpi(),
    medianTimeToMergeMs: unavailableKpi(),
    activePrCount: unavailableKpi(),
    mergedCount: unavailableKpi(),
    leadTimeForChangeMs: unavailableKpi(),
    locPerDollar: unavailableKpi(),
    totalSpendUsd: unavailableKpi(),
    activeBranchCount: unavailableKpi(),
    buildVsReworkSplit: {
      buildPct: null,
      reworkPct: null,
      state: BranchKpiState.Unavailable,
    },
  };
}
