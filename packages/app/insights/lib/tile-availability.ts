import {
  BranchKpiState,
  type BranchKpiState as BranchKpiStateValue,
} from "@repo/api/src/types/branch";
import type { GitHubIntegrationStatus } from "@repo/api/src/types/github";
import {
  InsightsScope,
  InsightsSection,
  type InsightsTileAvailabilityMap,
  InsightsTileAvailabilityState,
} from "@repo/api/src/types/insights";
import { resolveGitHubGateConnected } from "../../github/lib/github-connect-action";
import {
  INSIGHTS_KLOC_KPI_TILE_ID,
  INSIGHTS_PR_BY_REPO_CHART_TILE_ID,
  INSIGHTS_PR_BY_REPO_DONUT_TILE_ID,
  INSIGHTS_PR_SIZE_KPI_TILE_ID,
} from "./tile-catalog";

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
  // ISS-7866: these two used to short-circuit to Available and render desktop's
  // LOCALLY-captured population beside gated GitHub cards. Same tile id, same
  // unit label, different measurement — and signing in silently swapped which
  // one the card meant. Naming the population in the label (ISS-7868) annotated
  // that rather than fixing it; they are GitHub truth, so they gate like it.
  "kpi:kloc",
  "kpi:pr-size",
  "chart:branchesWithoutPr",
  "chart:branchesWithoutPr:donut",
  "chart:checkStatus",
  "chart:checkStatus:bar",
  "kpi:backlog",
  "chart:reviewQueue",
  "chart:reviewQueue:donut",
  "chart:reviewerLoad",
  // ISS-12638: the cloud payload map answers "did the merged population get
  // measured", never "is there a connection to measure it through", so the repo
  // chart gates like `kpi:merged`, which is the same merged-PR evidence. Both
  // variants, as every other chart in this set lists both.
  INSIGHTS_PR_BY_REPO_CHART_TILE_ID,
  INSIGHTS_PR_BY_REPO_DONUT_TILE_ID,
]);

/**
 * GitHub-truth tiles a LOCAL source can never satisfy, however healthy its
 * GitHub connection (ISS-7866). Desktop SQLite can compute a captured-PR
 * population for these, but that is a different measurement from the merged-PR
 * one the tile names, so a local read must fall through to its availability map
 * (which reports them Unavailable) rather than take the blanket
 * Local+Connected fast path below.
 */
const CLOUD_ONLY_TILE_IDS = new Set<string>([
  INSIGHTS_KLOC_KPI_TILE_ID,
  INSIGHTS_PR_SIZE_KPI_TILE_ID,
  INSIGHTS_PR_BY_REPO_CHART_TILE_ID,
  INSIGHTS_PR_BY_REPO_DONUT_TILE_ID,
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
 * proves the current payload can satisfy that tile. A Cloud-sourced `me`-scope
 * tile trusts the cloud response's per-tile payload directly (FEA-3721). Desktop
 * personal/local metrics do not carry cloud payload proof, so they still require
 * an active GitHub data connection before GitHub-truth tiles render from local
 * enrichment.
 */
export function resolveInsightsTileAvailability({
  tileId,
  section,
  scope,
  connectionState,
  payloadAvailability,
  sourceKind = InsightsTileSourceKind.Cloud,
}: ResolveInsightsTileAvailabilityInput): InsightsTileAvailability {
  const isGitHubTruth = isGitHubTruthInsightsTile(tileId, section);
  if (!isGitHubTruth) {
    // ISS-8424: a payload that names this tile Unavailable is believed
    // even outside the GitHub-truth set. The cloud producer reports the
    // merged-PR trend/state charts unavailable when nothing in the
    // org-merged population has been verified, and without this they would
    // short-circuit to Available and draw an empty chart — the same fabricated
    // zero as the KPI tiles, in chart form. Only ids the producer actually puts
    // in the map are affected; every id the map carried before ISS-8424 is
    // already GitHub-truth and resolves below exactly as it did.
    return {
      state: isPayloadUnavailable(payloadAvailability, tileId)
        ? BranchKpiState.Unavailable
        : BranchKpiState.Available,
    };
  }
  if (ORG_ONLY_TILE_IDS.has(tileId) && scope !== InsightsScope.Org) {
    return { state: BranchKpiState.Unavailable };
  }
  // FEA-3721: a Cloud-sourced `me`-scope GitHub-truth tile reads the cloud
  // `/insights/*` response, which already carries the per-tile payload proof
  // (`buildDeliveryTileAvailability` runs scope-independently in the cloud
  // service). Trust that payload directly — it is the source of truth for the
  // signed-in user's own delivery data — instead of re-gating on the desktop's
  // LOCAL GitHub App connection, which had wrongly forced populated cloud KPIs
  // (merged/merge-rate/ttm) to 0/blank when the local App was not connected.
  // `org` still requires an active connection/provenance (handled below); Local
  // sources carry no cloud payload proof and keep their connection gating.
  if (
    sourceKind === InsightsTileSourceKind.Cloud &&
    scope === InsightsScope.Me
  ) {
    return { state: toBranchKpiState(payloadAvailability?.[tileId]) };
  }
  if (
    sourceKind === InsightsTileSourceKind.Local &&
    connectionState === InsightsGitHubConnectionState.Connected &&
    !CLOUD_ONLY_TILE_IDS.has(tileId)
  ) {
    return { state: BranchKpiState.Available };
  }
  // A LOCAL source gates on an UNKNOWN connection too, and deliberately so: a
  // local read carries no cloud payload proof, and desktop's status fetch is
  // enabled purely on the session, so in local/offline mode it may never land.
  // Requiring a definite `false` here would mean a genuinely disconnected
  // offline user never gets the ask at all — the one user this surface most
  // needs to reach.
  //
  // ISS-7866 briefly removed this to make the two surfaces agree, and that was
  // the wrong half to change: the signed-out case it was really covering is now
  // answered honestly upstream, where the provider resolves no-session to
  // Disconnected rather than leaving it unread. What remains is a narrower,
  // deliberate divergence from the Sessions strip's `=== false` rule, scoped to
  // a local source that cannot prove the tile either way.
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

/**
 * The GitHub connection state Insights tiles gate on, for both shells. Web and
 * desktop each carried their own copy of this three-way branch; one of them
 * collapsed `undefined` into `Disconnected` and gated cloud-proven tiles on it.
 * One helper beside the enum it returns, so the two cannot drift again.
 */
export function resolveInsightsGitHubConnectionState(
  status: GitHubIntegrationStatus | null | undefined,
  // Defaulted so the web callers — which only mount behind an authenticated
  // route group — read unchanged. Desktop passes its real auth state, because
  // signed out it has one (ISS-7866).
  authenticated = true,
  // Likewise defaulted: only desktop has an in-flight sign-in phase, and during
  // one this must resolve UNKNOWN rather than gate on a status about to change.
  authSettled = true
): InsightsGitHubConnectionState {
  const connected = resolveGitHubGateConnected({
    authSettled,
    authenticated,
    status,
  });
  if (connected === true) {
    return InsightsGitHubConnectionState.Connected;
  }
  if (connected === false) {
    return InsightsGitHubConnectionState.Disconnected;
  }
  return InsightsGitHubConnectionState.Unknown;
}

/**
 * Whether the active payload explicitly reports this tile unavailable. The
 * Local producer authors its own map (ISS-12709), so it is believed for either
 * source kind.
 */
function isPayloadUnavailable(
  payloadAvailability: InsightsTileAvailabilityMap | undefined,
  tileId: string
): boolean {
  return (
    payloadAvailability?.[tileId] === InsightsTileAvailabilityState.Unavailable
  );
}
