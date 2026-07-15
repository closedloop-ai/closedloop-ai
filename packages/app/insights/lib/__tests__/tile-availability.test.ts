import { BranchKpiState } from "@repo/api/src/types/branch";
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
  resolveInsightsTileAvailability,
  resolveMissingSourceTileAvailability,
} from "../tile-availability";

const githubTruthLaunchTiles = [
  ["kpi:merged", InsightsSection.Delivery],
  ["kpi:ttm", InsightsSection.Delivery],
  ["kpi:merge-rate", InsightsSection.Delivery],
  ["chart:branchesWithoutPr", InsightsSection.Delivery],
  ["chart:branchesWithoutPr:donut", InsightsSection.Delivery],
  ["chart:checkStatus", InsightsSection.Delivery],
  ["chart:checkStatus:bar", InsightsSection.Delivery],
  ["kpi:backlog", InsightsSection.Utilization],
  ["chart:reviewQueue", InsightsSection.Utilization],
  ["chart:reviewQueue:donut", InsightsSection.Utilization],
  ["chart:reviewerLoad", InsightsSection.Utilization],
] as const;

const nonLaunchTiles = [
  ["kpi:active-prs", InsightsSection.Delivery],
  ["chart:prTrend", InsightsSection.Delivery],
  ["chart:prByRepo", InsightsSection.Delivery],
  ["kpi:sessions", InsightsSection.Utilization],
  ["chart:eventActivity", InsightsSection.Utilization],
  ["kpi:tokens", InsightsSection.Agents],
] as const;

describe("resolveInsightsTileAvailability", () => {
  it.each(
    githubTruthLaunchTiles
  )("treats %s as a GitHub-truth launch tile", (tileId, section) => {
    expect(isGitHubTruthInsightsTile(tileId, section)).toBe(true);
  });

  it.each(
    nonLaunchTiles
  )("does not treat %s as a launch tile", (tileId, section) => {
    expect(isGitHubTruthInsightsTile(tileId, section)).toBe(false);
  });

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

  it("gates desktop local personal GitHub-truth tiles while GitHub status is unknown", () => {
    expect(
      resolveInsightsTileAvailability({
        tileId: "kpi:merged",
        section: InsightsSection.Delivery,
        scope: InsightsScope.Me,
        connectionState: InsightsGitHubConnectionState.Unknown,
        sourceKind: InsightsTileSourceKind.Local,
      })
    ).toEqual({ state: BranchKpiState.Gated });
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
