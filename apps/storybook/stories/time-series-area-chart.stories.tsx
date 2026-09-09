import { CHART_SERIES_COLOR_LIMIT } from "@repo/design-system/components/ui/chart-colors";
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
  argTypes: {
    series: {
      control: "object",
      table: { category: "Data" },
      description: "One entry per drawn band, as { key, label }.",
    },
    points: {
      control: "object",
      table: { category: "Data" },
      description:
        "Time buckets. `date` is YYYY-MM-DD and `values` maps a series key to its number.",
    },
    comparison: {
      control: "object",
      table: { category: "Data" },
      description: "Optional dashed trend line drawn behind the stacked areas.",
    },
    comparisonLabel: {
      control: "text",
      table: { category: "Data" },
    },
    markers: {
      control: "object",
      table: { category: "Data" },
      description:
        "Vertical event markers. Only dates matching a rendered bucket are drawn.",
    },
    maxSeries: {
      control: {
        type: "number",
        min: 1,
        max: CHART_SERIES_COLOR_LIMIT,
        step: 1,
      },
      table: { category: "Appearance" },
      description:
        "Cap on separately colored series. Anything past it folds into one aggregate band.",
    },
    otherSeriesLabel: {
      control: "text",
      table: { category: "Appearance" },
      description: "Noun the folded aggregate band is named with.",
    },
    colorOffset: {
      control: { type: "number", min: 0, max: 9, step: 1 },
      table: { category: "Appearance" },
      description: "Shifts where the categorical palette starts.",
    },
    allowDecimals: {
      control: "boolean",
      table: { category: "Appearance" },
      description: "Allow fractional y-axis ticks.",
    },
    emptyMessage: {
      control: "text",
      table: { category: "Appearance" },
    },
    valueFormatter: { control: false, table: { category: "Appearance" } },
    resetKey: {
      control: "text",
      table: { category: "State" },
      description:
        "Change it to clear the legend's hidden-series state when the data identity changes.",
    },
  },
  args: {
    allowDecimals: false,
    colorOffset: 0,
    comparison,
    comparisonLabel: "Previous week",
    emptyMessage: "No data",
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

// Several version-lifecycle events crowded into a short window, including
// created/first-used pairs that land on the same day. The chart merges same-day
// markers onto one line (label joined with " · ") so the tags never overpaint
// each other — the case the token-trend usage graph hits with multiple
// revisions in range (FEA-4027).
export const CrowdedMarkers: Story = {
  args: {
    comparison: undefined,
    points,
    series: [series[0]],
    markers: [
      { date: "2026-06-08", label: "Rev 1", description: "Rev 1 created" },
      {
        date: "2026-06-08",
        label: "Rev 1 used",
        description: "Rev 1 first used",
      },
      { date: "2026-06-10", label: "Rev 2", description: "Rev 2 created" },
      {
        date: "2026-06-11",
        label: "Rev 2 used",
        description: "Rev 2 first used",
      },
      { date: "2026-06-12", label: "Rev 3", description: "Rev 3 created" },
      {
        date: "2026-06-12",
        label: "Rev 3 used",
        description: "Rev 3 first used",
      },
      { date: "2026-06-13", label: "Current", description: "Current created" },
    ],
  },
};

// ISS-5523: the state matrix for the series cap. The chart's categorical
// palette holds ten mutually distinguishable colours; handed more series than
// that it used to wrap, so unrelated series drew in the SAME fill and the
// legend could not resolve which band was which. These two stories sit side by
// side deliberately — the defect is only visible by comparison.

const MANY_SERIES_COUNT = 17;

const manySeries = Array.from(
  { length: MANY_SERIES_COUNT },
  (_unused, index) => ({
    key: `model-${index}`,
    label: `model-${index}`,
  })
);

const manyPoints = points.map((point, pointIndex) => ({
  date: point.date,
  values: Object.fromEntries(
    manySeries.map((entry, index) => [
      entry.key,
      (MANY_SERIES_COUNT - index) * (pointIndex + 2),
    ])
  ),
}));

// Uncapped — the pre-ISS-5523 rendering, kept as the reference for what the
// gate turns off. Series 11 through 17 repeat the colours of series 1 through 7.
export const ManySeriesUncapped: Story = {
  args: {
    comparison: undefined,
    points: manyPoints,
    series: manySeries,
  },
};

// Capped — ten series keep a distinct colour and the remaining seven collapse
// into one neutral band that names how many it stands for ("Other models (7)"),
// so no reader mistakes the aggregate for a model.
export const ManySeriesCapped: Story = {
  args: {
    comparison: undefined,
    maxSeries: CHART_SERIES_COLOR_LIMIT,
    otherSeriesLabel: "Other models",
    points: manyPoints,
    series: manySeries,
  },
};
