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

export const SHARED_BRANCHES_IPC_CHANNEL_LIST = [
  SHARED_BRANCHES_IPC_CHANNELS.list,
  SHARED_BRANCHES_IPC_CHANNELS.detail,
  SHARED_BRANCHES_IPC_CHANNELS.trace,
  SHARED_BRANCHES_IPC_CHANNELS.usage,
  SHARED_BRANCHES_IPC_CHANNELS.analytics,
  SHARED_BRANCHES_IPC_CHANNELS.cohortAnalytics,
  SHARED_BRANCHES_IPC_CHANNELS.pageData,
] as const;

export type SharedBranchesIpcChannel =
  (typeof SHARED_BRANCHES_IPC_CHANNEL_LIST)[number];

/**
 * The IPC query is exactly the shared port's `BranchQueryFilters` — aliased (not
 * re-declared) so the two cannot drift (AGENTS.md: one canonical type).
 */
export type SharedBranchesQuery = BranchQueryFilters;

export type SharedBranchAnalyticsCohortRequest = BranchAnalyticsCohortRequest;
export type SharedBranchAnalyticsCohortResponse = BranchAnalyticsCohortResponse;

export type SharedBranchesListRequest = SharedBranchesQuery & {
  ids?: readonly string[];
  forceRefresh?: boolean;
};

export type SharedBranchesDetailRequest = BranchSelectedPullRequestQuery & {
  id: string;
  forceRefresh?: boolean;
};

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
 * ISS-4483 (review cid 3679616167, wongk): the error code stamped on a TRANSIENT
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
