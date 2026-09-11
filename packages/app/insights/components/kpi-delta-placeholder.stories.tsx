import { KpiDeltaBasis } from "@repo/api/src/types/insights";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";
import type { Meta, StoryObj } from "@storybook/react";
import { userEvent } from "storybook/test";
import { kpiNoComparisonReason } from "../lib/kpi-no-comparison-copy";
import { KpiDeltaPlaceholder } from "./kpi-delta-placeholder";
import { DASHBOARD_METRIC_CARD_CLASS_NAME } from "./overview/dashboard-card";

// Roughly what a dashboard KPI card measures on a 1440 screen, where the stats
// row is an `xl:grid-cols-5` with `gap-3`. Narrower than the 300 the tile
// stories use, because a story whose whole pitch is "the chip where it really
// sits" should not show it at a width the dashboard never renders.
const CARD_WIDTH_CLASS = "w-[220px]";

// A Tab budget, not a tab count. Walking to the chip beats hardcoding "the
// fourth stop", which would point somewhere else the day a card gains or loses
// an `info` trigger.
const TAB_LIMIT = 12;

// ISS-4995 (review thread on #4388): the sibling `NoComparisonReasons` story on
// `KpiMetricTile` covers the `bare` variant only. `pill` is the default and the
// one that renders on ~12 of the 16 dashboard KPI cards, through
// `OverviewKpiCard` / `OverviewCostKpiCard`, and it had no story on the real
// component at all. The `MetricCard` catalog story pinned a hand-copied `<span>`
// lookalike that predated the chip becoming a focusable button, so nothing in
// Storybook showed the pill's actual focus ring, cursor, or tooltip.
//
// The chip renders where it really sits: in `MetricCard`'s `deltaPlaceholder`
// slot, wearing the dashboard card class, with the reason resolved by the same
// `kpiNoComparisonReason` the dashboard row calls. `Computed` returns
// `undefined` and falls through to the range-based default; `NotComputed`
// returns the ISS-4995 sentence. KLOC carries its `unitLabel` because the real
// `kpi:kloc` tile does.
//
// The third card is the part the `bare` story cannot cover. The placeholder
// exists to mirror the numeric delta rather than out-design it (FEA-3961 VQA),
// and in `pill` it wears the same rounded-full muted chrome as a real
// `MetricDeltaChip`. That adjacency is geometry, so it belongs in a frame and
// not in an assertion.
const PillNoComparisonCanvas = () => (
  <div className="flex gap-3">
    <div className={CARD_WIDTH_CLASS}>
      <MetricCard
        className={DASHBOARD_METRIC_CARD_CLASS_NAME}
        deltaPlaceholder={
          <KpiDeltaPlaceholder
            reason={kpiNoComparisonReason(KpiDeltaBasis.Computed)}
          />
        }
        info={{ what: "PRs merged in range" }}
        label="Merged PRs"
        value={422}
      />
    </div>
    <div className={CARD_WIDTH_CLASS}>
      <MetricCard
        className={DASHBOARD_METRIC_CARD_CLASS_NAME}
        deltaPlaceholder={
          <KpiDeltaPlaceholder
            reason={kpiNoComparisonReason(KpiDeltaBasis.NotComputed)}
          />
        }
        info={{ what: "Thousand lines landed" }}
        label="KLOC merged"
        unitLabel="KLOC"
        value={863.5}
      />
    </div>
    <div className={CARD_WIDTH_CLASS}>
      <MetricCard
        className={DASHBOARD_METRIC_CARD_CLASS_NAME}
        delta={12}
        deltaLabel="MoM"
        deltaPolarity={MetricPolarity.HigherIsBetter}
        info={{ what: "Sessions in range" }}
        label="Sessions"
        value={1284}
      />
    </div>
  </div>
);

/**
 * A small No comparison chip filling the spot where a KPI card would show
 * its change, so a metric with nothing to compare doesn't look like it
 * failed to load.
 */
const meta = {
  title: "Composites/Insights/KPI Delta Placeholder",
  component: PillNoComparisonCanvas,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof PillNoComparisonCanvas>;

export default meta;

type Story = StoryObj<typeof meta>;

export const PillNoComparisonReasons: Story = {
  play: async ({ canvasElement }) => {
    // Real Tab presses, not `.focus()`. The chip's ring is `focus-visible:`, and
    // Chromium applies that only when the last input was a keyboard, so a
    // programmatic focus would ship a frame with the tooltip open and the ring
    // this story exists to show missing.
    //
    // Focus, not hover, because Radix opens a tooltip immediately on focus and
    // only after the provider's 700ms delay on hover. The SECOND chip is the "we
    // never compute this" one; leaving the first closed is what makes the
    // difference legible, since the two chips are meant to look the same.
    const chips = canvasElement.querySelectorAll<HTMLButtonElement>(
      '[data-testid="kpi-delta-placeholder"]'
    );
    const target = chips[1];
    if (!target) {
      return;
    }
    for (let step = 0; step < TAB_LIMIT; step++) {
      if (document.activeElement === target) {
        return;
      }
      await userEvent.tab();
    }
  },
};
