import type {
  CategoryBucket,
  DeliveryInsightsResponse,
  TimeSeries,
} from "@repo/api/src/types/insights";
import { InsightsSection, KpiFormat } from "@repo/api/src/types/insights";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import type { CategoryDatum } from "@repo/design-system/components/ui/category-bar-chart";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { type TileDescriptor, TileKind } from "../../lib/tile-catalog";
import {
  DELIVERY_SEGMENT_FEATURE_FLAG_KEY,
  InsightsChartContent,
} from "../tile-content";

vi.mock("@repo/design-system/components/ui/category-bar-chart", () => ({
  CategoryBarChart: ({
    data,
    onDatumClick,
    selectedKey,
  }: {
    data: CategoryDatum[];
    onDatumClick?: (datum: CategoryDatum) => void;
    selectedKey?: string | null;
  }) => (
    <div data-testid="mock-category-bar-chart">
      {selectedKey ? (
        <div data-testid="selected-key">{`sel:${selectedKey}`}</div>
      ) : null}
      {data.map((datum) => (
        <button
          key={datum.key}
          onClick={() => onDatumClick?.(datum)}
          type="button"
        >
          {`Bar ${datum.label}`}
        </button>
      ))}
    </div>
  ),
}));

const prByRepoTile: TileDescriptor = {
  id: "chart:prByRepo",
  section: InsightsSection.Delivery,
  title: "Merged PRs by repository",
  kind: TileKind.CategoryBar,
  dataKey: "prByRepo",
  metricKey: "merged",
  metricLabel: "Pull requests",
  groupBy: { key: "repo", label: "Repository" },
  horizontal: true,
  grid: { w: 6, h: 4 },
};

const SELECT_PROMPT = /Select a repository to drill into/;
const SHARE_ANY = /% of total/;
const SHARE_50 = /50% of total/;
const SHARE_API = /6 · 30% of total · #2 of 3/;

function renderWithFlag(node: ReactElement, enabled: boolean) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: enabled ? [DELIVERY_SEGMENT_FEATURE_FLAG_KEY] : [],
      })}
    >
      {node}
    </FeatureFlagAdapterProvider>
  );
}

describe("Delivery repo segment drilldown (FEA-2993)", () => {
  it("keeps the plain category chart with no drilldown while the flag is off", () => {
    renderWithFlag(
      <InsightsChartContent
        sections={{
          [InsightsSection.Delivery]: makeDeliveryResponse([
            { key: "acme/web", label: "acme/web", value: 10 },
            { key: "acme/api", label: "acme/api", value: 10 },
          ]),
        }}
        tile={prByRepoTile}
      />,
      false
    );

    expect(screen.getByTestId("mock-category-bar-chart")).toBeInTheDocument();
    expect(screen.queryByText(SELECT_PROMPT)).not.toBeInTheDocument();
    // Clicking a bar is inert when the flag is off — no summary appears.
    fireEvent.click(screen.getByRole("button", { name: "Bar acme/web" }));
    expect(screen.queryByText(SHARE_ANY)).not.toBeInTheDocument();
  });

  it("prompts for a selection, then reports the picked repo's share and rank", () => {
    renderWithFlag(
      <InsightsChartContent
        sections={{
          [InsightsSection.Delivery]: makeDeliveryResponse([
            { key: "acme/web", label: "acme/web", value: 10 },
            { key: "acme/api", label: "acme/api", value: 6 },
            { key: "acme/cli", label: "acme/cli", value: 4 },
          ]),
        }}
        tile={prByRepoTile}
      />,
      true
    );

    expect(screen.getByText(SELECT_PROMPT)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Bar acme/api" }));

    expect(screen.getByText("acme/api")).toBeInTheDocument();
    // 6 of (10+6+4)=20 → 30%, ranked #2 of 3 repos.
    expect(screen.getByText(SHARE_API)).toBeInTheDocument();
    expect(screen.getByTestId("selected-key")).toHaveTextContent("acme/api");
    expect(screen.queryByText(SELECT_PROMPT)).not.toBeInTheDocument();
  });

  it("toggles the selection off when the same repo bar is clicked again", () => {
    renderWithFlag(
      <InsightsChartContent
        sections={{
          [InsightsSection.Delivery]: makeDeliveryResponse([
            { key: "acme/web", label: "acme/web", value: 10 },
            { key: "acme/api", label: "acme/api", value: 10 },
          ]),
        }}
        tile={prByRepoTile}
      />,
      true
    );

    fireEvent.click(screen.getByRole("button", { name: "Bar acme/web" }));
    expect(screen.getByText(SHARE_50)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Bar acme/web" }));
    expect(screen.getByText(SELECT_PROMPT)).toBeInTheDocument();
    expect(screen.queryByText(SHARE_ANY)).not.toBeInTheDocument();
  });

  it("clears a stale selection when the repo set no longer includes it", () => {
    const { rerender } = renderWithFlag(
      <InsightsChartContent
        sections={{
          [InsightsSection.Delivery]: makeDeliveryResponse([
            { key: "acme/web", label: "acme/web", value: 10 },
            { key: "acme/api", label: "acme/api", value: 10 },
          ]),
        }}
        tile={prByRepoTile}
      />,
      true
    );

    fireEvent.click(screen.getByRole("button", { name: "Bar acme/web" }));
    expect(screen.getByText(SHARE_50)).toBeInTheDocument();

    rerender(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [DELIVERY_SEGMENT_FEATURE_FLAG_KEY],
        })}
      >
        <InsightsChartContent
          sections={{
            [InsightsSection.Delivery]: makeDeliveryResponse([
              { key: "acme/api", label: "acme/api", value: 6 },
              { key: "acme/cli", label: "acme/cli", value: 4 },
            ]),
          }}
          tile={prByRepoTile}
        />
      </FeatureFlagAdapterProvider>
    );

    expect(screen.getByText(SELECT_PROMPT)).toBeInTheDocument();
  });

  it("shows the shared empty state when there are no repo buckets, even with the flag on", () => {
    renderWithFlag(
      <InsightsChartContent
        sections={{
          [InsightsSection.Delivery]: makeDeliveryResponse([]),
        }}
        tile={prByRepoTile}
      />,
      true
    );

    expect(screen.getByText("No data yet")).toBeInTheDocument();
    expect(screen.queryByText(SELECT_PROMPT)).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("mock-category-bar-chart")
    ).not.toBeInTheDocument();
  });
});

function makeDeliveryResponse(
  prByRepo: CategoryBucket[]
): DeliveryInsightsResponse {
  return {
    kpis: [
      {
        key: "merged",
        label: "Merged PRs",
        value: 0,
        format: KpiFormat.Number,
        sub: "pull requests",
        deltaPct: null,
      },
    ],
    charts: {
      prTrend: emptyTimeSeries(),
      klocTrend: undefined,
      prByRepo,
      meanTimeToMerge: [],
      prByState: [],
      branchLifespan: [],
      branchesWithoutPr: [],
    },
  };
}

function emptyTimeSeries(): TimeSeries {
  return { series: [{ key: "merged", label: "Merged" }], points: [] };
}
