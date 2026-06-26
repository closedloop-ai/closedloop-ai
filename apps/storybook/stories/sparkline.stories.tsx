import { Sparkline } from "@repo/design-system/components/ui/primitives/sparkline";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
  title: "Design System/Data Display/Data Visualization/Sparkline",
  component: Sparkline,
  tags: ["autodocs"],
  args: {
    values: [12, 14, 13, 18, 21, 20, 24],
  },
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof Sparkline>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
