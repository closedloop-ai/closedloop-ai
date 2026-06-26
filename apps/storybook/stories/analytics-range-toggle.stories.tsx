import { AnalyticsRangeToggle } from "@repo/design-system/components/ui/analytics-range-toggle";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";

const meta = {
  title: "Design System/Data Display/Analytics Range Toggle",
  component: AnalyticsRangeToggle,
  args: {
    label: "Range",
    value: "30d",
    onValueChange: fn(),
    options: [
      { label: "7d", value: "7d" },
      { label: "30d", value: "30d" },
      { label: "90d", value: "90d" },
      { label: "All", value: "all" },
    ],
  },
} satisfies Meta<typeof AnalyticsRangeToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
