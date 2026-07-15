import {
  BranchKpiState,
  type BranchKpiState as BranchKpiStateValue,
} from "@repo/api/src/types/branch";
import {
  InsightsScope,
  InsightsSection,
  type InsightsTileAvailabilityMap,
  InsightsTileAvailabilityState,
} from "@repo/api/src/types/insights";

export const InsightsGitHubConnectionState = {
  Connected: "connected",
  Disconnected: "disconnected",
  Unknown: "unknown",
} as const;
export type InsightsGitHubConnectionState =
  (typeof InsightsGitHubConnectionState)[keyof typeof InsightsGitHubConnectionState];

export type InsightsTileAvailability = {
  state: BranchKpiStateValue;
};

export type ResolveInsightsTileAvailabilityInput = {
  tileId: string;
  section: InsightsSection;
  scope: InsightsScope;
  connectionState: InsightsGitHubConnectionState;
  payloadAvailability?: InsightsTileAvailabilityMap;
  sourceKind?: InsightsTileSourceKind;
};

export const InsightsTileSourceKind = {
  Cloud: "cloud",
  Local: "local",
} as const;
export type InsightsTileSourceKind =
  (typeof InsightsTileSourceKind)[keyof typeof InsightsTileSourceKind];

const GITHUB_TRUTH_TILE_IDS = new Set<string>([
  "kpi:merged",
  "kpi:ttm",
  "kpi:merge-rate",
  "chart:branchesWithoutPr",
  "chart:branchesWithoutPr:donut",
  "chart:checkStatus",
  "chart:checkStatus:bar",
  "kpi:backlog",
  "chart:reviewQueue",
  "chart:reviewQueue:donut",
  "chart:reviewerLoad",
]);

const ORG_ONLY_TILE_IDS = new Set<string>([
  "chart:checkStatus",
  "chart:checkStatus:bar",
  "kpi:backlog",
  "chart:reviewQueue",
  "chart:reviewQueue:donut",
  "chart:reviewerLoad",
]);

/**
 * Resolve per-user Insights availability outside the static tile catalog.
 * GitHub-truth tiles fail closed unless the active data source explicitly
 * proves the current payload can satisfy that tile. Desktop personal/local
 * metrics do not carry cloud payload proof, but still require an active GitHub
 * data connection before GitHub-truth tiles render from local enrichment.
 */
export function resolveInsightsTileAvailability({
  tileId,
  section,
  scope,
  connectionState,
  payloadAvailability,
  sourceKind = InsightsTileSourceKind.Cloud,
}: ResolveInsightsTileAvailabilityInput): InsightsTileAvailability {
  if (!isGitHubTruthInsightsTile(tileId, section)) {
    return { state: BranchKpiState.Available };
  }
  if (ORG_ONLY_TILE_IDS.has(tileId) && scope !== InsightsScope.Org) {
    return { state: BranchKpiState.Unavailable };
  }
  if (
    sourceKind === InsightsTileSourceKind.Local &&
    connectionState === InsightsGitHubConnectionState.Connected
  ) {
    return { state: BranchKpiState.Available };
  }
  if (
    sourceKind === InsightsTileSourceKind.Local &&
    connectionState === InsightsGitHubConnectionState.Unknown
  ) {
    return { state: BranchKpiState.Gated };
  }
  if (connectionState === InsightsGitHubConnectionState.Disconnected) {
    return { state: BranchKpiState.Gated };
  }
  if (connectionState !== InsightsGitHubConnectionState.Connected) {
    return { state: BranchKpiState.Unavailable };
  }
  return {
    state: toBranchKpiState(payloadAvailability?.[tileId]),
  };
}

export function resolveMissingSourceTileAvailability({
  tileId,
  section,
}: {
  tileId: string;
  section: InsightsSection;
}): InsightsTileAvailability {
  if (isGitHubTruthInsightsTile(tileId, section)) {
    return { state: BranchKpiState.Unavailable };
  }
  return { state: BranchKpiState.Available };
}

function toBranchKpiState(
  state: InsightsTileAvailabilityState | undefined
): BranchKpiStateValue {
  if (state === InsightsTileAvailabilityState.Available) {
    return BranchKpiState.Available;
  }
  if (state === InsightsTileAvailabilityState.Gated) {
    return BranchKpiState.Gated;
  }
  return BranchKpiState.Unavailable;
}

export function isGitHubTruthInsightsTile(
  tileId: string,
  section: InsightsSection
): boolean {
  if (
    section !== InsightsSection.Delivery &&
    section !== InsightsSection.Utilization
  ) {
    return false;
  }
  return GITHUB_TRUTH_TILE_IDS.has(tileId);
}
