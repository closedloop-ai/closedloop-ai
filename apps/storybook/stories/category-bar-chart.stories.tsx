import { CategoryBarChart } from "@repo/design-system/components/ui/category-bar-chart";
import type { Meta, StoryObj } from "@storybook/react";
import type { ComponentProps } from "react";
import { useState } from "react";

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
  args: {
    data: categoryData,
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
