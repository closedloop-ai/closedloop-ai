import type {
  CategoryBucket,
  DeliveryInsightsResponse,
  TimeSeries,
} from "@repo/api/src/types/insights";
import { InsightsSection, KpiFormat } from "@repo/api/src/types/insights";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { Button } from "@repo/design-system/components/ui/button";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { type TileDescriptor, TileKind } from "../lib/tile-catalog";
import {
  DELIVERY_SEGMENT_FEATURE_FLAG_KEY,
  InsightsChartContent,
  type InsightsSectionData,
} from "./tile-content";

const timeSeriesBarTile: TileDescriptor = {
  id: "chart:prTrend:bar",
  section: InsightsSection.Delivery,
  title: "PR throughput by day",
  kind: TileKind.TimeSeriesBar,
  dataKey: "prTrend",
  metricKey: "merged",
  metricLabel: "Pull requests",
  groupBy: { key: "date", label: "Date" },
  grid: { w: 12, h: 4 },
};

const initialSections = makeSections([
  ["2026-01-01", 8],
  ["2026-01-02", 18],
  ["2026-01-03", 13],
]);
const updatedSections = makeSections([
  ["2026-01-01", 3],
  ["2026-02-01", 21],
  ["2026-02-02", 8],
]);

const meta = {
  title: "App Core/Insights/Tile Content",
  component: InsightsChartContent,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  args: {
    sections: initialSections,
    tile: timeSeriesBarTile,
  },
  decorators: [
    (Story) => (
      <div className="h-80 w-[560px] rounded-lg border bg-background p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof InsightsChartContent>;

export default meta;

type Story = StoryObj<typeof meta>;

export const TimeSeriesBarTracker: Story = {};

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

/**
 * FEA-2993 first slice: with the `emergent` flag on, the "Merged PRs by
 * repository" bars become selectable and reveal a per-repo segment summary.
 */
export const RepoSegmentDrilldown: Story = {
  args: {
    sections: makeRepoSections([
      { key: "acme/web", label: "acme/web", value: 14 },
      { key: "acme/api", label: "acme/api", value: 9 },
      { key: "acme/cli", label: "acme/cli", value: 5 },
    ]),
    tile: prByRepoTile,
  },
  decorators: [
    (Story) => (
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [DELIVERY_SEGMENT_FEATURE_FLAG_KEY],
        })}
      >
        <Story />
      </FeatureFlagAdapterProvider>
    ),
  ],
};

export const TimeSeriesBarTrackerDataChange: Story = {
  render: () => <ChangingTimeSeriesBarContent />,
};

function ChangingTimeSeriesBarContent() {
  const [useUpdatedSections, setUseUpdatedSections] = useState(false);

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex justify-end">
        <Button
          onClick={() => setUseUpdatedSections((current) => !current)}
          size="sm"
          type="button"
          variant="outline"
        >
          {useUpdatedSections ? "Reset range" : "Update range"}
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <InsightsChartContent
          sections={useUpdatedSections ? updatedSections : initialSections}
          tile={timeSeriesBarTile}
        />
      </div>
    </div>
  );
}

function makeSections(points: [string, number][]): InsightsSectionData {
  return {
    [InsightsSection.Delivery]: makeDeliveryResponse(makeTimeSeries(points)),
  };
}

function makeRepoSections(prByRepo: CategoryBucket[]): InsightsSectionData {
  const base = makeDeliveryResponse(makeTimeSeries([["2026-01-01", 28]]));
  return {
    [InsightsSection.Delivery]: {
      ...base,
      charts: { ...base.charts, prByRepo },
    },
  };
}

function makeTimeSeries(points: [string, number][]): TimeSeries {
  return {
    series: [{ key: "merged", label: "Merged" }],
    points: points.map(([date, value]) => ({
      date,
      values: { merged: value },
    })),
  };
}

function makeDeliveryResponse(prTrend: TimeSeries): DeliveryInsightsResponse {
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
      prTrend,
      klocTrend: undefined,
      prByRepo: [],
      meanTimeToMerge: [],
      prByState: [],
      checkStatus: [],
      branchLifespan: [],
      branchesWithoutPr: [],
    },
  };
}
