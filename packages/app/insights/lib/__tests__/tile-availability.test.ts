import { BranchKpiState } from "@repo/api/src/types/branch";
// `GitHubInstallationStatus` is a const object read at runtime, so it is a VALUE
// import; only the status type beside it is erasable.
import {
  GitHubInstallationStatus,
  type GitHubIntegrationStatus,
} from "@repo/api/src/types/github";
import {
  InsightsScope,
  InsightsSection,
  InsightsTileAvailabilityState,
} from "@repo/api/src/types/insights";
import { describe, expect, it } from "vitest";
import {
  InsightsGitHubConnectionState,
  InsightsTileSourceKind,
  isGitHubTruthInsightsTile,
  resolveInsightsGitHubConnectionState,
  resolveInsightsTileAvailability,
  resolveMissingSourceTileAvailability,
} from "../tile-availability";
import {
  INSIGHTS_PR_BY_REPO_CHART_TILE_ID,
  INSIGHTS_PR_BY_REPO_DONUT_TILE_ID,
} from "../tile-catalog";

const githubTruthLaunchTiles = [
  ["kpi:merged", InsightsSection.Delivery],
  ["kpi:ttm", InsightsSection.Delivery],
  ["kpi:merge-rate", InsightsSection.Delivery],
  // ISS-7866: the merged-PR LOC pair joined the GitHub-truth set. They used to
  // short-circuit to Available and render desktop's LOCALLY-captured population
  // beside gated GitHub cards — same tile id, same unit label, a different
  // measurement — so signing in silently swapped which one the card meant.
  ["kpi:kloc", InsightsSection.Delivery],
  ["kpi:pr-size", InsightsSection.Delivery],
  ["chart:branchesWithoutPr", InsightsSection.Delivery],
  ["chart:branchesWithoutPr:donut", InsightsSection.Delivery],
  ["chart:checkStatus", InsightsSection.Delivery],
  ["chart:checkStatus:bar", InsightsSection.Delivery],
  // ISS-12638 (whitlockk): the repo chart joined the set for BOTH sources. Gated on
  // a LOCAL source only, a disconnected cloud workspace kept a bare unavailable
  // sentence beside `kpi:merged`'s ask over the same merged-PR evidence.
  [INSIGHTS_PR_BY_REPO_CHART_TILE_ID, InsightsSection.Delivery],
  [INSIGHTS_PR_BY_REPO_DONUT_TILE_ID, InsightsSection.Delivery],
  ["kpi:backlog", InsightsSection.Utilization],
  ["chart:reviewQueue", InsightsSection.Utilization],
  ["chart:reviewQueue:donut", InsightsSection.Utilization],
  ["chart:reviewerLoad", InsightsSection.Utilization],
] as const;

const nonLaunchTiles = [
  ["kpi:active-prs", InsightsSection.Delivery],
  ["chart:prTrend", InsightsSection.Delivery],
  ["kpi:sessions", InsightsSection.Utilization],
  ["chart:eventActivity", InsightsSection.Utilization],
  ["kpi:tokens", InsightsSection.Agents],
] as const;

describe("resolveInsightsGitHubConnectionState", () => {
  it("reports either source as connected", () => {
    expect(
      resolveInsightsGitHubConnectionState({
        connected: false,
        githubDataConnection: {
          connected: true,
          sources: [],
          oauthRequiredReasons: [],
        },
      })
    ).toBe(InsightsGitHubConnectionState.Connected);
  });

  it("reports a status with neither source as disconnected", () => {
    expect(resolveInsightsGitHubConnectionState({ connected: false })).toBe(
      InsightsGitHubConnectionState.Disconnected
    );
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
  ] as const)(
    "reports a %s status as unknown, never disconnected",
    (_label, status) => {
      expect(resolveInsightsGitHubConnectionState(status)).toBe(
        InsightsGitHubConnectionState.Unknown
      );
    }
  );

  it.each([
    ["null", null],
    ["undefined", undefined],
  ] as const)(
    "reports a %s status as DISCONNECTED when the surface is signed out (ISS-7866)",
    (_label, status) => {
      // The signed-out half of the same read. With no session there is no user
      // grant and no org installation to read, and the status fetch that would
      // say so returns null and never resolves — so leaving it Unknown is what
      // let the desktop dashboard prompt on a state it had never read while the
      // Sessions strip refused to. This is the only argument that changes the
      // answer for an unlanded status, which is why it is asserted against the
      // same two payloads the signed-in case above uses.
      expect(resolveInsightsGitHubConnectionState(status, false)).toBe(
        InsightsGitHubConnectionState.Disconnected
      );
    }
  );

  it("defaults to authenticated so the web callers read unchanged", () => {
    // Web mounts only behind an authenticated route group and passes no flag.
    // Pinned because the default is what keeps a landed `connected: true` from
    // being overridden by an omitted argument.
    expect(resolveInsightsGitHubConnectionState(legacyConnectedStatus())).toBe(
      InsightsGitHubConnectionState.Connected
    );
  });
});

/**
 * A status connected through the legacy App-installation field alone — no
 * `githubDataConnection`, which is the older payload shape
 * `resolveGitHubDataConnected` falls back for. Typed rather than cast, so a
 * change to the wire shape fails here instead of at the boundary.
 */
function legacyConnectedStatus(): GitHubIntegrationStatus {
  return {
    connected: true,
    installation: {
      id: "install-1",
      installationId: "1",
      accountLogin: "acme",
      accountType: "Organization",
      status: GitHubInstallationStatus.Active,
      repositorySelection: "all",
      repositoryCount: 1,
      claimedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

describe("resolveInsightsTileAvailability", () => {
  it.each(githubTruthLaunchTiles)(
    "treats %s as a GitHub-truth launch tile",
    (tileId, section) => {
      expect(isGitHubTruthInsightsTile(tileId, section)).toBe(true);
    }
  );

  it.each(nonLaunchTiles)(
    "does not treat %s as a launch tile",
    (tileId, section) => {
      expect(isGitHubTruthInsightsTile(tileId, section)).toBe(false);
    }
  );

  it("gates GitHub-truth launch tiles while GitHub is disconnected", () => {
    expect(
      resolveInsightsTileAvailability({
        tileId: "kpi:merged",
        section: InsightsSection.Delivery,
        scope: InsightsScope.Org,
        connectionState: InsightsGitHubConnectionState.Disconnected,
      })
    ).toEqual({ state: BranchKpiState.Gated });
  });

  it("marks GitHub-truth launch tiles available when connected payload proves the tile", () => {
    expect(
      resolveInsightsTileAvailability({
        tileId: "kpi:merge-rate",
        section: InsightsSection.Delivery,
        scope: InsightsScope.Org,
        connectionState: InsightsGitHubConnectionState.Connected,
        payloadAvailability: {
          "kpi:merge-rate": InsightsTileAvailabilityState.Available,
        },
      })
    ).toEqual({ state: BranchKpiState.Available });
  });

  it("fails closed when connected payload omits GitHub-truth availability proof", () => {
    expect(
      resolveInsightsTileAvailability({
        tileId: "kpi:merge-rate",
        section: InsightsSection.Delivery,
        scope: InsightsScope.Org,
        connectionState: InsightsGitHubConnectionState.Connected,
      })
    ).toEqual({ state: BranchKpiState.Unavailable });
  });

  it("gates desktop local personal GitHub-truth tiles while GitHub is disconnected", () => {
    expect(
      resolveInsightsTileAvailability({
        tileId: "kpi:merged",
        section: InsightsSection.Delivery,
        scope: InsightsScope.Me,
        connectionState: InsightsGitHubConnectionState.Disconnected,
        sourceKind: InsightsTileSourceKind.Local,
      })
    ).toEqual({ state: BranchKpiState.Gated });
  });

  it("gates a LOCAL GitHub-truth tile on an unknown status, but not a cloud one", () => {
    // Deliberately NOT the `=== false` rule the Sessions strip follows, and the
    // asymmetry is the contract. A LOCAL read carries no cloud payload proof,
    // and desktop's status fetch is enabled purely on the session — in
    // local/offline mode it may never land. Requiring a definite absence here
    // would mean a genuinely disconnected offline user never sees the ask at
    // all, which is the one reader this surface most needs to reach.
    //
    // ISS-7866 briefly flipped this to `Unavailable` so the two surfaces would
    // agree, and that broke the connect-from-dashboard flow covered by
    // `desktop-insights-provider.test.tsx`. The signed-out case that change was
    // really chasing is answered upstream instead: the provider resolves
    // no-session to Disconnected, where it is a fact rather than a guess.
    expect(
      resolveInsightsTileAvailability({
        tileId: "kpi:merged",
        section: InsightsSection.Delivery,
        scope: InsightsScope.Me,
        connectionState: InsightsGitHubConnectionState.Unknown,
        sourceKind: InsightsTileSourceKind.Local,
      })
    ).toEqual({ state: BranchKpiState.Gated });
    // The other half, which keeps the exception scoped: a CLOUD source at org
    // scope has payload proof available, so an unread connection there is an
    // absence of evidence rather than grounds to prompt. Without this the
    // local-only carve-out could widen to every source and nothing would fail.
    expect(
      resolveInsightsTileAvailability({
        tileId: "kpi:merged",
        section: InsightsSection.Delivery,
        scope: InsightsScope.Org,
        connectionState: InsightsGitHubConnectionState.Unknown,
        sourceKind: InsightsTileSourceKind.Cloud,
      })
    ).toEqual({ state: BranchKpiState.Unavailable });
  });

  it("keeps the merged-PR LOC pair out of the Local+Connected fast path (ISS-7866)", () => {
    // A healthy LOCAL GitHub connection promotes GitHub-truth tiles wholesale
    // (the case below). These two are exempt: desktop SQLite can compute a
    // CAPTURED-PR population for them, but the tile names the MERGED one, and
    // reporting the captured number is what put a real value beside gated cards
    // on the signed-out dashboard and made the row read as partial data rather
    // than as two different measurements. With no payload proof they fall
    // through to Unavailable instead of being promoted.
    for (const tileId of ["kpi:kloc", "kpi:pr-size"]) {
      expect(
        resolveInsightsTileAvailability({
          tileId,
          section: InsightsSection.Delivery,
          scope: InsightsScope.Me,
          connectionState: InsightsGitHubConnectionState.Connected,
          sourceKind: InsightsTileSourceKind.Local,
        })
      ).toEqual({ state: BranchKpiState.Unavailable });
    }
  });

  it("keeps desktop local personal GitHub-truth tiles available once GitHub is connected", () => {
    expect(
      resolveInsightsTileAvailability({
        tileId: "kpi:merged",
        section: InsightsSection.Delivery,
        scope: InsightsScope.Me,
        connectionState: InsightsGitHubConnectionState.Connected,
        sourceKind: InsightsTileSourceKind.Local,
      })
    ).toEqual({ state: BranchKpiState.Available });
  });

  it("trusts the cloud payload for me-scope GitHub-truth tiles regardless of the local connection (FEA-3721)", () => {
    // In Cloud mode the desktop reads `me` from the cloud /insights/* routes,
    // whose response carries per-tile availability. With the Cloud sourceKind
    // the tile must render from that payload proof and NOT be re-gated on the
    // desktop's local GitHub App connection — even when that connection is
    // Disconnected or Unknown, the populated cloud KPI wins.
    for (const connectionState of [
      InsightsGitHubConnectionState.Connected,
      InsightsGitHubConnectionState.Disconnected,
      InsightsGitHubConnectionState.Unknown,
    ]) {
      expect(
        resolveInsightsTileAvailability({
          tileId: "kpi:merged",
          section: InsightsSection.Delivery,
          scope: InsightsScope.Me,
          connectionState,
          sourceKind: InsightsTileSourceKind.Cloud,
          payloadAvailability: {
            "kpi:merged": InsightsTileAvailabilityState.Available,
          },
        })
      ).toEqual({ state: BranchKpiState.Available });
    }
  });

  it("keeps org-only metrics unavailable outside org scope", () => {
    expect(
      resolveInsightsTileAvailability({
        tileId: "chart:checkStatus",
        section: InsightsSection.Delivery,
        scope: InsightsScope.Me,
        connectionState: InsightsGitHubConnectionState.Connected,
      })
    ).toEqual({ state: BranchKpiState.Unavailable });
  });

  it("does not promote org-only metrics from desktop local personal data", () => {
    expect(
      resolveInsightsTileAvailability({
        tileId: "chart:checkStatus",
        section: InsightsSection.Delivery,
        scope: InsightsScope.Me,
        connectionState: InsightsGitHubConnectionState.Disconnected,
        sourceKind: InsightsTileSourceKind.Local,
      })
    ).toEqual({ state: BranchKpiState.Unavailable });
  });

  it.each([
    InsightsGitHubConnectionState.Disconnected,
    InsightsGitHubConnectionState.Unknown,
  ])(
    "gates the repo chart for a LOCAL source on a %s connection (ISS-12638)",
    (connectionState) => {
      expect(
        resolveInsightsTileAvailability({
          tileId: INSIGHTS_PR_BY_REPO_CHART_TILE_ID,
          section: InsightsSection.Delivery,
          scope: InsightsScope.Me,
          connectionState,
          sourceKind: InsightsTileSourceKind.Local,
        })
      ).toEqual({ state: BranchKpiState.Gated });
    }
  );

  it("does not promote the repo chart for a connected LOCAL source (ISS-12638)", () => {
    expect(
      resolveInsightsTileAvailability({
        tileId: INSIGHTS_PR_BY_REPO_CHART_TILE_ID,
        section: InsightsSection.Delivery,
        scope: InsightsScope.Me,
        connectionState: InsightsGitHubConnectionState.Connected,
        payloadAvailability: {
          [INSIGHTS_PR_BY_REPO_CHART_TILE_ID]:
            InsightsTileAvailabilityState.Unavailable,
        },
        sourceKind: InsightsTileSourceKind.Local,
      })
    ).toEqual({ state: BranchKpiState.Unavailable });
  });

  /**
   * whitlockk, ISS-12638: the repo chart was GitHub truth for a LOCAL source only,
   * so a disconnected CLOUD workspace kept a bare unavailable sentence here
   * while `kpi:merged` beside it — the same merged-PR evidence — offered the
   * ask, and AI Impact's Top repo, which follows this tile, never asked at all.
   * Both variants, because the donut reads the same `prByRepo` series.
   */
  it.each([
    INSIGHTS_PR_BY_REPO_CHART_TILE_ID,
    INSIGHTS_PR_BY_REPO_DONUT_TILE_ID,
  ])("gates %s for a disconnected CLOUD org read (ISS-12638)", (tileId) => {
    expect(
      resolveInsightsTileAvailability({
        tileId,
        section: InsightsSection.Delivery,
        scope: InsightsScope.Org,
        connectionState: InsightsGitHubConnectionState.Disconnected,
        sourceKind: InsightsTileSourceKind.Cloud,
      })
    ).toEqual({ state: BranchKpiState.Gated });
  });

  it("still draws the repo chart for a connected CLOUD org read (ISS-12638)", () => {
    expect(
      resolveInsightsTileAvailability({
        tileId: INSIGHTS_PR_BY_REPO_CHART_TILE_ID,
        section: InsightsSection.Delivery,
        scope: InsightsScope.Org,
        connectionState: InsightsGitHubConnectionState.Connected,
        payloadAvailability: {
          [INSIGHTS_PR_BY_REPO_CHART_TILE_ID]:
            InsightsTileAvailabilityState.Available,
        },
        sourceKind: InsightsTileSourceKind.Cloud,
      })
    ).toEqual({ state: BranchKpiState.Available });
  });

  /**
   * FEA-3721's rule is unchanged by the gating above: a Cloud `me` read trusts
   * the payload the response carries, which is why the producer now publishes
   * proof for this tile (`apps/api/app/insights/service/tiles.ts`).
   */
  it("keeps the CLOUD me-scope read on the response's own payload (ISS-12638)", () => {
    expect(
      resolveInsightsTileAvailability({
        tileId: INSIGHTS_PR_BY_REPO_CHART_TILE_ID,
        section: InsightsSection.Delivery,
        scope: InsightsScope.Me,
        connectionState: InsightsGitHubConnectionState.Disconnected,
        payloadAvailability: {
          [INSIGHTS_PR_BY_REPO_CHART_TILE_ID]:
            InsightsTileAvailabilityState.Available,
        },
        sourceKind: InsightsTileSourceKind.Cloud,
      })
    ).toEqual({ state: BranchKpiState.Available });
  });

  it("does not gate non-launch tiles while GitHub is disconnected", () => {
    expect(
      resolveInsightsTileAvailability({
        tileId: "kpi:active-prs",
        section: InsightsSection.Delivery,
        scope: InsightsScope.Org,
        connectionState: InsightsGitHubConnectionState.Disconnected,
      })
    ).toEqual({ state: BranchKpiState.Available });
  });

  it("fails closed for old data sources that omit availability support", () => {
    expect(
      resolveMissingSourceTileAvailability({
        tileId: "kpi:merged",
        section: InsightsSection.Delivery,
      })
    ).toEqual({ state: BranchKpiState.Unavailable });
  });
});

/**
 * ISS-8424: the merged-PR trend/repo/state charts are not GitHub-truth tiles,
 * so they short-circuited to Available and drew an empty chart even when the
 * cloud producer had reported them unavailable — the same fabricated zero as
 * the KPI tiles, in chart form.
 */
describe("a cloud payload's explicit Unavailable, outside the GitHub-truth set", () => {
  const prTrend = {
    tileId: "chart:prTrend",
    section: InsightsSection.Delivery,
    scope: InsightsScope.Org,
    connectionState: InsightsGitHubConnectionState.Connected,
  };

  it("is believed when the cloud payload names the tile unavailable", () => {
    expect(
      resolveInsightsTileAvailability({
        ...prTrend,
        payloadAvailability: {
          "chart:prTrend": InsightsTileAvailabilityState.Unavailable,
        },
        sourceKind: InsightsTileSourceKind.Cloud,
      })
    ).toEqual({ state: BranchKpiState.Unavailable });
  });

  it("leaves the same tile available when the payload does not name it", () => {
    // The counterfactual: a resolver that returned Unavailable for every
    // non-GitHub-truth tile would pass the case above and fail here.
    expect(
      resolveInsightsTileAvailability({
        ...prTrend,
        payloadAvailability: {
          "kpi:merged": InsightsTileAvailabilityState.Unavailable,
        },
        sourceKind: InsightsTileSourceKind.Cloud,
      })
    ).toEqual({ state: BranchKpiState.Available });
  });

  it("leaves the same tile available with no payload at all", () => {
    expect(resolveInsightsTileAvailability(prTrend)).toEqual({
      state: BranchKpiState.Available,
    });
  });

  it("is believed for a LOCAL source too, which authors its own map", () => {
    expect(
      resolveInsightsTileAvailability({
        ...prTrend,
        tileId: "chart:prByRepo",
        payloadAvailability: {
          "chart:prByRepo": InsightsTileAvailabilityState.Unavailable,
        },
        sourceKind: InsightsTileSourceKind.Local,
      })
    ).toEqual({ state: BranchKpiState.Unavailable });
  });

  it("leaves a LOCAL tile available when the local map does not name it", () => {
    expect(
      resolveInsightsTileAvailability({
        ...prTrend,
        payloadAvailability: {
          "chart:prByRepo": InsightsTileAvailabilityState.Unavailable,
        },
        sourceKind: InsightsTileSourceKind.Local,
      })
    ).toEqual({ state: BranchKpiState.Available });
  });
});
