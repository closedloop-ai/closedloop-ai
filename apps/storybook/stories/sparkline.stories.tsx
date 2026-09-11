import { Sparkline } from "@repo/design-system/components/ui/primitives/sparkline";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * A tiny line for a glance only trend in a table cell or stat, without the
 * axes and hover a Line Chart or Time Series Area Chart give you.
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
