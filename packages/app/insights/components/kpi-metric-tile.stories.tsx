import { KpiDeltaBasis, KpiFormat } from "@repo/api/src/types/insights";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import type { Meta, StoryObj } from "@storybook/react";
import { InsightsKpiKey } from "../lib/kpi-polarity";
import { KpiMetricTile } from "./kpi-stat-tile";

const PinnedKpiMetricTileCanvas = () => (
  <div className="group h-[180px] w-[300px]">
    <KpiMetricTile
      kpi={{
        key: InsightsKpiKey.Merged,
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
      polarity={MetricPolarity.HigherIsBetter}
      showDragHandle
      showResizeControls
      tileId="kpi:merged"
      title="Merged PRs"
    />
  </div>
);

// ISS-4633: the same +38% reads as a win on a throughput metric and a
// regression on spend. Both are shown side by side so the polarity contract is
// visible in the catalog, not just in a test.
const RisingDeltaPolarityCanvas = () => (
  <div className="flex gap-4">
    {/* `group` sits on each tile, matching production — a shared wrapper group
        would pop both overlays on one hover. */}
    <div className="group h-[180px] w-[300px]">
      <KpiMetricTile
        kpi={{
          key: InsightsKpiKey.Merged,
          label: "Merged PRs",
          value: 128,
          format: KpiFormat.Number,
          sub: "PRs found in local sessions",
          deltaPct: 38,
        }}
        pinned={false}
        polarity={MetricPolarity.HigherIsBetter}
        tileId="kpi:merged"
        title="Merged PRs"
      />
    </div>
    <div className="group h-[180px] w-[300px]">
      <KpiMetricTile
        kpi={{
          key: InsightsKpiKey.Cost,
          label: "Cost",
          value: 123_607,
          format: KpiFormat.Currency,
          sub: "Estimated agent spend",
          deltaPct: 38,
        }}
        pinned={false}
        polarity={MetricPolarity.LowerIsBetter}
        tileId="kpi:cost"
        title="Cost"
      />
    </div>
  </div>
);

// Review on #4148: the three states that share a muted look — a NEUTRAL-polarity
// delta (a real number we pass no verdict on), a flat 0% (nothing moved), and a
// "No comparison" placeholder (no prior period at all) — shown together so their
// distinction is reviewable in the catalog, not just described. A neutral chip
// keeps its arrow + %, a flat chip shows the steady minus + "0%", and only the
// placeholder reads "No comparison"; none of them should look like a failed load.
const MutedTrioCanvas = () => (
  <div className="flex gap-4">
    <div className="group h-[180px] w-[300px]">
      <KpiMetricTile
        kpi={{
          key: InsightsKpiKey.Tokens,
          label: "Tokens",
          value: 4_120_000,
          format: KpiFormat.Number,
          sub: "Total tokens across sessions",
          deltaPct: 38,
        }}
        pinned={false}
        polarity={MetricPolarity.Neutral}
        tileId="kpi:tokens"
        title="Tokens"
      />
    </div>
    <div className="group h-[180px] w-[300px]">
      <KpiMetricTile
        kpi={{
          key: InsightsKpiKey.Merged,
          label: "Merged PRs",
          value: 128,
          format: KpiFormat.Number,
          sub: "PRs found in local sessions",
          deltaPct: 0,
        }}
        pinned={false}
        polarity={MetricPolarity.HigherIsBetter}
        tileId="kpi:merged"
        title="Merged PRs"
      />
    </div>
    <div className="group h-[180px] w-[300px]">
      <KpiMetricTile
        kpi={{
          key: InsightsKpiKey.Sessions,
          label: "Sessions",
          value: 512,
          format: KpiFormat.Number,
          sub: "Sessions in range",
          deltaPct: null,
        }}
        pinned={false}
        polarity={MetricPolarity.Neutral}
        tileId="kpi:sessions"
        title="Sessions"
      />
    </div>
  </div>
);

// ISS-4995: the two absent-delta tiles side by side. The visible chip is
// deliberately identical — only the tooltip and screen-reader sentence differ —
// so this is the one place a reviewer can see that the shared "No comparison"
// affordance still reads as one state while carrying two different reasons.
//
// Review thread on #4388: two matching chips and nothing else is the one thing
// this story must NOT be, because the difference it exists to show is the part
// Storybook will never reveal on its own. The play function below focuses the
// second chip so the frame ships with its tooltip open beside the closed one.
const NoComparisonReasonsCanvas = () => (
  <div className="flex gap-4">
    <div className="group h-[180px] w-[300px]">
      <KpiMetricTile
        kpi={{
          key: InsightsKpiKey.Merged,
          label: "Merged PRs",
          value: 422,
          format: KpiFormat.Number,
          sub: "PRs merged in range",
          deltaPct: null,
          deltaBasis: KpiDeltaBasis.Computed,
        }}
        pinned={false}
        polarity={MetricPolarity.HigherIsBetter}
        tileId="kpi:merged"
        title="Merged PRs"
      />
    </div>
    <div className="group h-[180px] w-[300px]">
      <KpiMetricTile
        kpi={{
          key: InsightsKpiKey.Kloc,
          label: "KLOC merged",
          value: 863.5,
          format: KpiFormat.Number,
          sub: "thousand lines landed",
          deltaPct: null,
          deltaBasis: KpiDeltaBasis.NotComputed,
        }}
        pinned={false}
        polarity={MetricPolarity.HigherIsBetter}
        tileId="kpi:kloc"
        title="KLOC merged"
      />
    </div>
  </div>
);

/**
 * A dashboard tile showing one KPI's current value, a short description, and
 * a trend arrow with a percent change from the prior period. That percent
 * change is colored to say whether it's good or bad for this specific
 * metric, since a rising cost is bad while a rising count of merged pull
 * requests is good. Hovering the tile reveals pin, edit, resize, and drag
 * controls for rearranging the dashboard, which otherwise stay out of the
 * way. A metric with no prior period to compare against shows the 'No
 * comparison' placeholder chip instead of a percentage.
 */
const meta = {
  title: "Composites/Insights/KPI Metric Tile",
  component: PinnedKpiMetricTileCanvas,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof PinnedKpiMetricTileCanvas>;

export default meta;

type Story = StoryObj<typeof meta>;

export const PinnedWithInfo: Story = {};

export const RisingDeltaByPolarity: Story = {
  render: () => <RisingDeltaPolarityCanvas />,
};

export const MutedStatesTrio: Story = {
  render: () => <MutedTrioCanvas />,
};

export const NoComparisonReasons: Story = {
  render: () => <NoComparisonReasonsCanvas />,
  play: ({ canvasElement }) => {
    // Focus, not hover: Radix opens a tooltip immediately on focus and only after
    // the provider's 700ms delay on hover, so focusing is what puts the sentence
    // in the frame deterministically. The SECOND chip is the "we never compute
    // this" one; leaving the first closed is the point, since the reviewer needs
    // to see one chip with its reason open next to an identical chip without it.
    const chips = canvasElement.querySelectorAll<HTMLButtonElement>(
      '[data-testid="kpi-delta-placeholder"]'
    );
    chips[1]?.focus();
  },
};

function noop() {
  return undefined;
}

function noopResize() {
  return undefined;
}
