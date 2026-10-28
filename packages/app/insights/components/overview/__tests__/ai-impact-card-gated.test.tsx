import { BranchKpiState } from "@repo/api/src/types/branch";
import {
  type AgentsInsightsResponse,
  type DeliveryInsightsResponse,
  InsightsScope,
  InsightsSection,
} from "@repo/api/src/types/insights";
import { GitHubConnectAction } from "@repo/app/github/lib/github-connect-action";
import { GITHUB_CONNECT_COPY } from "@repo/app/github/lib/github-connect-copy";
import { METRIC_CARD_NO_DATA_LABEL } from "@repo/design-system/components/ui/primitives/metric-card";
import { render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  InsightsGitHubConnectionState,
  InsightsTileSourceKind,
  resolveInsightsTileAvailability,
} from "../../../lib/tile-availability";
import {
  INSIGHTS_KLOC_KPI_TILE_ID,
  INSIGHTS_MERGED_KPI_TILE_ID,
  INSIGHTS_PR_BY_REPO_CHART_TILE_ID,
  type TileDescriptor,
} from "../../../lib/tile-catalog";
import { AiImpactCard } from "../ai-impact-card";

/**
 * ISS-12638: the three AI Impact metrics that divide by GitHub data take the
 * state of the tile they depend on, so a disconnected reader sees the same
 * "No data" and connect ask as that tile's own card. Top model by cost reads no
 * GitHub data and keeps its value.
 */

const GITHUB_DEPENDENT_TILE_IDS: ReadonlySet<string> = new Set([
  INSIGHTS_MERGED_KPI_TILE_ID,
  INSIGHTS_KLOC_KPI_TILE_ID,
  INSIGHTS_PR_BY_REPO_CHART_TILE_ID,
]);
const GITHUB_DEPENDENT_METRIC_COUNT = GITHUB_DEPENDENT_TILE_IDS.size;
const CONNECT_COPY = GITHUB_CONNECT_COPY[GitHubConnectAction.Connect];
const CONNECT_CTA = CONNECT_COPY.cardCtaLabel ?? CONNECT_COPY.ctaLabel;
const TOP_MODEL_LABEL = "Top model by cost";
const MODEL_NAME = "claude-opus-5";

const EMPTY_SERIES = { series: [], points: [] };

const DELIVERY: DeliveryInsightsResponse = {
  kpis: [
    { key: "cost", label: "Estimated cost", value: 1200, format: "currency" },
    { key: "mergedCount", label: "PRs shipped", value: 4, format: "number" },
    { key: "mergedKloc", label: "Merged volume", value: 2, format: "number" },
  ] as DeliveryInsightsResponse["kpis"],
  charts: {
    prTrend: EMPTY_SERIES,
    prByRepo: [{ key: "closedloop-ai", label: "closedloop-ai", value: 9 }],
    meanTimeToMerge: [],
    prByState: [],
    branchLifespan: [],
    branchesWithoutPr: [],
  },
};

const AGENTS = {
  kpis: [],
  charts: {
    modelUsageOverTime: EMPTY_SERIES,
    modelBreakdown: [{ key: MODEL_NAME, label: MODEL_NAME, value: 10 }],
  },
} as unknown as AgentsInsightsResponse;

function gatedGitHubTiles(tile: TileDescriptor) {
  return {
    state: GITHUB_DEPENDENT_TILE_IDS.has(tile.id)
      ? BranchKpiState.Gated
      : BranchKpiState.Available,
  };
}

function unavailableGitHubTiles(tile: TileDescriptor) {
  return {
    state: GITHUB_DEPENDENT_TILE_IDS.has(tile.id)
      ? BranchKpiState.Unavailable
      : BranchKpiState.Available,
  };
}

function availableTiles() {
  return { state: BranchKpiState.Available };
}

function renderCard(
  getTileAvailability: ComponentProps<
    typeof AiImpactCard
  >["getTileAvailability"]
) {
  return render(
    <AiImpactCard
      getTileAvailability={getTileAvailability}
      githubConnect={{
        action: GitHubConnectAction.Connect,
        onConnect: vi.fn(),
      }}
      sections={{
        [InsightsSection.Delivery]: DELIVERY,
        [InsightsSection.Agents]: AGENTS,
      }}
    />
  );
}

describe("AI Impact GitHub-dependent metrics (ISS-12638)", () => {
  it("shows no data and the connect ask on each GitHub-dependent metric", () => {
    renderCard(gatedGitHubTiles);

    expect(screen.getAllByText(METRIC_CARD_NO_DATA_LABEL)).toHaveLength(
      GITHUB_DEPENDENT_METRIC_COUNT
    );
    expect(screen.getAllByRole("button", { name: CONNECT_CTA })).toHaveLength(
      GITHUB_DEPENDENT_METRIC_COUNT
    );
    expect(
      screen.getAllByText(CONNECT_COPY.cardSupportingCopy ?? "")
    ).toHaveLength(GITHUB_DEPENDENT_METRIC_COUNT);
  });

  it("leaves Top model by cost on its own value, with no ask", () => {
    renderCard(gatedGitHubTiles);

    const metric = screen.getByText(TOP_MODEL_LABEL).parentElement;
    if (!metric) {
      throw new Error("Top model metric not found");
    }
    expect(within(metric).getByText(MODEL_NAME)).toBeInTheDocument();
    expect(within(metric).queryByRole("button")).not.toBeInTheDocument();
  });

  it("asks nothing when every dependent tile is available", () => {
    renderCard(availableTiles);

    expect(
      screen.queryByRole("button", { name: CONNECT_CTA })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(METRIC_CARD_NO_DATA_LABEL)
    ).not.toBeInTheDocument();
  });
  /**
   * whitlockk, ISS-12638: the cases above hand the card a SYNTHETIC resolver, which
   * cannot tell whether the shipped one ever answers `Gated` for the tile Top
   * repo follows. It did not — `chart:prByRepo` was GitHub truth for a LOCAL
   * source only — so a disconnected web workspace asked on two of these three
   * metrics and left the third on the old caption. This drives the real
   * resolver, over the cloud org read that case describes.
   */
  it("asks on all three through the SHIPPED resolver, disconnected on a cloud org read", () => {
    renderCard((tile) =>
      resolveInsightsTileAvailability({
        tileId: tile.id,
        section: tile.section,
        scope: InsightsScope.Org,
        connectionState: InsightsGitHubConnectionState.Disconnected,
        sourceKind: InsightsTileSourceKind.Cloud,
      })
    );

    expect(screen.getAllByRole("button", { name: CONNECT_CTA })).toHaveLength(
      GITHUB_DEPENDENT_METRIC_COUNT
    );
    // The positive control: Top model reads no GitHub data, so it keeps its
    // value under the same resolver and the count above is not "every metric".
    expect(screen.getByText(MODEL_NAME)).toBeInTheDocument();
  });

  it("keeps each metric's own value when its tile is unavailable rather than gated", () => {
    renderCard(unavailableGitHubTiles);

    expect(screen.getByText(MODEL_NAME)).toBeInTheDocument();
    expect(
      screen.queryByText(METRIC_CARD_NO_DATA_LABEL)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: CONNECT_CTA })
    ).not.toBeInTheDocument();
  });
});
