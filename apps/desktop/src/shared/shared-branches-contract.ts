import {
  type BranchAnalytics,
  type BranchKpi,
  BranchKpiState,
  type BranchListResponse,
  type BranchQueryFilters,
  type BranchUsageSummary,
  BranchViewerScope,
} from "@repo/api/src/types/branch";

export const SHARED_BRANCHES_IPC_CHANNELS = {
  list: "desktop:shared-branches:list",
  detail: "desktop:shared-branches:detail",
  // PLN-1148 Phase 2: the events-heavy merged trace, split out of `detail` and
  // fetched lazily when the Sessions & timeline tab opens.
  trace: "desktop:shared-branches:trace",
  usage: "desktop:shared-branches:usage",
  analytics: "desktop:shared-branches:analytics",
} as const;

export const SHARED_BRANCHES_IPC_CHANNEL_LIST = [
  SHARED_BRANCHES_IPC_CHANNELS.list,
  SHARED_BRANCHES_IPC_CHANNELS.detail,
  SHARED_BRANCHES_IPC_CHANNELS.trace,
  SHARED_BRANCHES_IPC_CHANNELS.usage,
  SHARED_BRANCHES_IPC_CHANNELS.analytics,
] as const;

export type SharedBranchesIpcChannel =
  (typeof SHARED_BRANCHES_IPC_CHANNEL_LIST)[number];

/**
 * The IPC query is exactly the shared port's `BranchQueryFilters` — aliased (not
 * re-declared) so the two cannot drift (CLAUDE.md: one canonical type).
 */
export type SharedBranchesQuery = BranchQueryFilters;

export type SharedBranchesListRequest = SharedBranchesQuery & {
  ids?: readonly string[];
  forceRefresh?: boolean;
};

export type SharedBranchesDetailRequest = {
  id: string;
  forceRefresh?: boolean;
};

export const SHARED_BRANCHES_NOT_FOUND_CODE = "LOCAL_BRANCH_NOT_FOUND" as const;
export const SHARED_BRANCHES_SOURCE_ERROR_CODE =
  "LOCAL_BRANCHES_SOURCE_ERROR" as const;

/** Canonical "no data" KPI — used by every gated/unavailable analytics field. */
function unavailableKpi(): BranchKpi {
  return {
    value: null,
    state: BranchKpiState.Unavailable,
    baseline30d: null,
    deltaPct: null,
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
