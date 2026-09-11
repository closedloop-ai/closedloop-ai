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
 * A labelled row of pill buttons for picking a time range, such as 7 days,
 * 30 days or all time, sitting above a chart or table. Reach for it instead
 * of Select when you want every option visible and one tap away, which
 * matters for something people switch often, like a reporting window. Only
 * one segment can be active at a time, and it always shows a short label,
 * such as "Range", ahead of the pills so the row reads clearly on its own.
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
