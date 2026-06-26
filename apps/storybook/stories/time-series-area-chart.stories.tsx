import { TimeSeriesAreaChart } from "@repo/design-system/components/ui/time-series-area-chart";
import type { Meta, StoryObj } from "@storybook/react";

const series = [
  { key: "accepted", label: "Accepted" },
  { key: "reworked", label: "Reworked" },
];

const points = [
  { date: "2026-06-08", values: { accepted: 12, reworked: 4 } },
  { date: "2026-06-09", values: { accepted: 18, reworked: 6 } },
  { date: "2026-06-10", values: { accepted: 16, reworked: 5 } },
  { date: "2026-06-11", values: { accepted: 24, reworked: 8 } },
  { date: "2026-06-12", values: { accepted: 29, reworked: 7 } },
  { date: "2026-06-13", values: { accepted: 34, reworked: 9 } },
];

const comparison = {
  series: [{ key: "previous", label: "Previous" }],
  points: [
    { date: "2026-06-08", values: { previous: 14 } },
    { date: "2026-06-09", values: { previous: 17 } },
    { date: "2026-06-10", values: { previous: 18 } },
    { date: "2026-06-11", values: { previous: 20 } },
    { date: "2026-06-12", values: { previous: 23 } },
    { date: "2026-06-13", values: { previous: 25 } },
  ],
};

const meta = {
  title: "Design System/Primitives/Time Series Area Chart",
  component: TimeSeriesAreaChart,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  args: {
    comparison,
    comparisonLabel: "Previous week",
    points,
    series,
  },
  decorators: [
    (Story) => (
      <div className="h-80 w-[640px] rounded-lg border bg-background p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TimeSeriesAreaChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const StackedWithComparison: Story = {};

export const SingleSeries: Story = {
  args: {
    comparison: undefined,
    points,
    series: [series[0]],
  },
};

export const Empty: Story = {
  args: {
    comparison: undefined,
    points: [],
    series,
    emptyMessage: "No trend data is available.",
  },
};
