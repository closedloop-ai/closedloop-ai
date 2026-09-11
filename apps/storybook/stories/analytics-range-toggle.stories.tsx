import { AnalyticsRangeToggle } from "@repo/design-system/components/ui/analytics-range-toggle";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";

const rangeOptions = [
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
  { label: "90d", value: "90d" },
  { label: "All", value: "all" },
];

/**
 * A labelled row of pill buttons for picking a time range, like 7 days or 30
 * days, used instead of Select when every option should be visible and one
 * tap away.
 */
const meta = {
  title: "Primitives/Inputs/Analytics Range Toggle",
  component: AnalyticsRangeToggle,
  tags: ["autodocs"],
  argTypes: {
    label: {
      control: "text",
      description: "Text rendered ahead of the segmented control.",
    },
    value: {
      // Derived from the options arg so the control can never offer a value the
      // toggle has no segment for.
      options: rangeOptions.map((option) => option.value),
      control: { type: "radio" },
      description: "Value of the active segment. Must match one of `options`.",
    },
    options: {
      control: "object",
      description: "Segments to render, each a { label, value } pair.",
    },
    onValueChange: { control: false, table: { category: "Events" } },
  },
  args: {
    label: "Range",
    value: "30d",
    onValueChange: fn(),
    options: rangeOptions,
  },
} satisfies Meta<typeof AnalyticsRangeToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
