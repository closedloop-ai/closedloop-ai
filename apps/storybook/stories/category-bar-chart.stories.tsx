import { spendByOutcomeFixture } from "@repo/app/insights/components/insights-section-fixtures";
import { SPEND_OUTCOME_COLORS } from "@repo/app/insights/lib/spend-outcome-palette";
import { CategoryBarChart } from "@repo/design-system/components/ui/category-bar-chart";
import type { Meta, StoryObj } from "@storybook/react";
import type { ComponentProps } from "react";
import { useState } from "react";
import { fn } from "storybook/test";

const categoryData = [
  { key: "planning", label: "Planning", value: 18 },
  { key: "build", label: "Build", value: 42 },
  { key: "review", label: "Review", value: 27 },
  { key: "verify", label: "Verify", value: 14 },
];
const timeBucketData = [
  { key: "2026-01-01", label: "01/01", value: 8 },
  { key: "2026-02-01", label: "02/01", value: 18 },
  { key: "2027-01-01", label: "01/01", value: 13 },
  { key: "2027-02-01", label: "02/01", value: 27 },
];

const meta = {
  title: "Design System/Primitives/Category Bar Chart",
  component: CategoryBarChart,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  argTypes: {
    data: {
      control: "object",
      table: { category: "Content" },
    },
    emptyMessage: {
      control: "text",
      description: "Shown when there is no data, or every value is zero.",
      table: { category: "Content" },
    },
    horizontal: {
      control: "boolean",
      description: "Lay the bars out horizontally, for label-heavy categories.",
      table: { category: "Appearance" },
    },
    showValueLabels: {
      control: "boolean",
      description: "Draw each value on its bar so it reads without hovering.",
      table: { category: "Appearance" },
    },
    colorByKey: {
      control: "object",
      description:
        "Fixed datum key to color map for semantic categories. Unmapped keys fall back to the index palette.",
      table: { category: "Appearance" },
    },
    allowDecimals: {
      control: "boolean",
      description: "Allow fractional ticks on the numeric axis.",
      table: { category: "Formatting" },
    },
    valueFormatter: {
      control: false,
      description: "Formats the numeric axis, tooltip, and on-bar labels.",
      table: { category: "Formatting" },
    },
    selectedKey: {
      control: "text",
      description: "Datum key marked with the tracker line.",
      table: { category: "State" },
    },
    onDatumClick: {
      control: false,
      table: { category: "Events" },
    },
  },
  args: {
    allowDecimals: false,
    data: categoryData,
    emptyMessage: "No data",
    horizontal: false,
    onDatumClick: fn(),
    selectedKey: null,
    showValueLabels: false,
  },
  decorators: [
    (Story) => (
      <div className="h-72 w-[520px] rounded-lg border bg-background p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CategoryBarChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Vertical: Story = {};

export const Horizontal: Story = {
  args: {
    horizontal: true,
  },
};

// Mirrors the dashboard "Spend by model" chart: horizontal bars with each
// model's spend rendered on the bar (readable without hovering) and formatted
// as currency, exercising small, large, and mixed values.
const spendData = [
  { key: "opus", label: "Claude Opus", value: 36_400 },
  { key: "sonnet", label: "Claude Sonnet", value: 4210 },
  { key: "haiku", label: "Claude Haiku", value: 42 },
  { key: "gpt", label: "GPT-4o", value: 3 },
];
const formatSpend = (value: number) =>
  value >= 1000
    ? `$${(value / 1000).toFixed(1)}k`
    : `$${value.toFixed(value < 10 ? 2 : 0)}`;

export const HorizontalWithValueLabels: Story = {
  args: {
    data: spendData,
    horizontal: true,
    showValueLabels: true,
    allowDecimals: true,
    valueFormatter: formatSpend,
  },
};

export const Empty: Story = {
  args: {
    data: [],
    emptyMessage: "No categories matched the current filters.",
  },
};

export const SelectedTracker: Story = {
  args: {
    data: timeBucketData,
    selectedKey: "2026-02-01",
  },
};

export const ClickableTracker: Story = {
  args: {
    data: timeBucketData,
  },
  render: (args) => <ClickableTrackerChart {...args} />,
};

// ISS-4463: `colorByKey` gives this chart a SEMANTIC colour contract — the
// failure bar is destructive because it means failure, not because of where it
// happens to sit in the array. The stories below are the visual guard on that:
// without them a regression that stops applying the map falls back to the index
// palette and silently paints meaning the data does not carry (green for the
// errored bucket, three bars over).
//
// ISS-5335 (review): the data and the map used to be hand-copied here, and had
// drifted onto `var(--chart-4)` for `clean` and `var(--muted)` for `unknown` —
// the two values that ticket banned for measuring 1.31:1 and 1.10:1 against the
// card. Both now come from the shipping constants, so the visual guard is a
// guard on what actually ships rather than on a stale copy of it.
const outcomeData = spendByOutcomeFixture;
const outcomeColors = SPEND_OUTCOME_COLORS;
/**
 * The shipping map minus its last two buckets in render order, for the
 * partial-map fallback story. Derived so no outcome key is spelled out here — a
 * hand-written key is how the full map drifted onto banned colours in the first
 * place.
 */
const partialOutcomeColors: Record<string, string> = Object.fromEntries(
  outcomeData
    .slice(0, -2)
    .map((bucket) => [bucket.key, outcomeColors[bucket.key]])
);
const formatOutcomeSpend = (value: number) => `$${value.toFixed(2)}`;

export const SemanticColors: Story = {
  args: {
    data: outcomeData,
    colorByKey: outcomeColors,
  },
};

/**
 * Deliberately PARTIAL — the trailing buckets are absent from the map — to
 * exercise the documented fallback: an unmapped key keeps the index palette, so
 * a partial map stays safe rather than dropping the bar's fill.
 */
export const PartialSemanticColors: Story = {
  args: {
    data: outcomeData,
    colorByKey: partialOutcomeColors,
  },
};

/**
 * How the map actually ships on the "Spend by session outcome" tile: horizontal
 * bars, long category labels, and on-bar currency values. Pairs with the donut's
 * `SemanticColors` story so the two renderings of one dimension stay consistent.
 */
export const HorizontalSemanticColorsWithValueLabels: Story = {
  args: {
    data: outcomeData,
    colorByKey: outcomeColors,
    horizontal: true,
    showValueLabels: true,
    allowDecimals: true,
    valueFormatter: formatOutcomeSpend,
  },
};

function ClickableTrackerChart(args: ComponentProps<typeof CategoryBarChart>) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  return (
    <CategoryBarChart
      {...args}
      onDatumClick={(datum) => setSelectedKey(datum.key)}
      selectedKey={selectedKey}
    />
  );
}
