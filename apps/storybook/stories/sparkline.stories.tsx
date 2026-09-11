import { Sparkline } from "@repo/design-system/components/ui/primitives/sparkline";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * A tiny plain line drawn from a list of numbers, with no axis, label or
 * hover behavior. Use it for a glance-only trend inside a table cell or a
 * compact stat, where even a tooltip would be too much; reach for the Line
 * Chart primitive instead when readers need to hover a point for its value,
 * or Time Series Area Chart for a full chart with axes and a legend. It is
 * hidden from screen readers by design, since it carries no label of its
 * own, and it renders nothing at all when fewer than two valid points remain
 * after non-numeric values are dropped.
 */
const meta = {
  title: "Primitives/Charts/Sparkline",
  component: Sparkline,
  tags: ["autodocs"],
  argTypes: {
    values: {
      control: "object",
      description:
        "Series to plot. Non-finite entries are dropped, and fewer than two remaining points renders nothing.",
    },
    width: {
      control: { type: "number", min: 20, max: 400, step: 4 },
    },
    height: {
      control: { type: "number", min: 8, max: 160, step: 2 },
    },
    stroke: {
      control: "text",
      description:
        'Line color. Accepts any CSS color, including "currentColor" and custom properties.',
    },
    className: { control: "text" },
  },
  args: {
    values: [12, 14, 13, 18, 21, 20, 24],
    width: 80,
    height: 20,
    stroke: "currentColor",
  },
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof Sparkline>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
