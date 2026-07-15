import { KpiFormat } from "@repo/api/src/types/insights";
import type { Meta, StoryObj } from "@storybook/react";
import { KpiMetricTile } from "./kpi-stat-tile";

const PinnedKpiMetricTileCanvas = () => (
  <div className="group h-[180px] w-[300px]">
    <KpiMetricTile
      kpi={{
        key: "merged",
        label: "Merged PRs",
        value: 128,
        format: KpiFormat.Number,
        sub: "PRs found in local sessions",
        deltaPct: null,
      }}
      onEditTile={noop}
      onResizeWidth={noopResize}
      onTogglePin={noop}
      pinned
      showDragHandle
      showResizeControls
      tileId="kpi:merged"
      title="Merged PRs"
    />
  </div>
);

const meta = {
  title: "App Core/Insights/KPI Metric Tile",
  component: PinnedKpiMetricTileCanvas,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof PinnedKpiMetricTileCanvas>;

export default meta;

type Story = StoryObj<typeof meta>;

export const PinnedWithInfo: Story = {};

function noop() {
  return undefined;
}

function noopResize() {
  return undefined;
}
