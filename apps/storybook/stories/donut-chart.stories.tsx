import { DonutChart } from "@repo/design-system/components/ui/donut-chart";
import type { Meta, StoryObj } from "@storybook/react";

const donutData = [
  { key: "planning", label: "Planning", value: 18 },
  { key: "build", label: "Build", value: 42 },
  { key: "review", label: "Review", value: 27 },
  { key: "verify", label: "Verify", value: 14 },
];

const meta = {
  title: "Design System/Data Display/Data Visualization/Donut Chart",
  component: DonutChart,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  args: {
    data: donutData,
  },
  decorators: [
    (Story) => (
      <div className="h-72 w-[520px] rounded-lg border bg-background p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DonutChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = {
  args: {
    data: [],
    emptyMessage: "No categories matched the current filters.",
  },
};
