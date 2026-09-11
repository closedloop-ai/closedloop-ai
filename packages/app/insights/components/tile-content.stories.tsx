import { InsightsSection } from "@repo/api/src/types/insights";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { Button } from "@repo/design-system/components/ui/button";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { type TileDescriptor, TileKind } from "../lib/tile-catalog";
import {
  makeDeliverySections,
  makeRepoSections,
} from "./insights-section-fixtures";
import {
  DELIVERY_SEGMENT_FEATURE_FLAG_KEY,
  InsightsChartContent,
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

const initialSections = makeDeliverySections([
  ["2026-01-01", 8],
  ["2026-01-02", 18],
  ["2026-01-03", 13],
]);
const updatedSections = makeDeliverySections([
  ["2026-01-01", 3],
  ["2026-02-01", 21],
  ["2026-02-02", 8],
]);

/**
 * The chart inside a dashboard tile, a time series, bar chart, heatmap,
 * donut, or table, chosen automatically by the tile's own data descriptor.
 */
const meta = {
  title: "Composites/Insights/Tile Content",
  component: InsightsChartContent,
  tags: ["autodocs"],
  argTypes: {
    tile: {
      control: "object",
      description:
        "The catalog descriptor that picks the chart kind, its data key, and its grouping.",
    },
    sections: {
      control: "object",
      description:
        "Per-section responses. A missing section renders a skeleton rather than an empty chart.",
    },
    comparisonSections: { control: "object" },
    comparisonLabel: { control: "text" },
  },
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
