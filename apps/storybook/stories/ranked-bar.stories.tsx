import { RankedBar } from "@repo/design-system/components/ui/primitives/ranked-bar";
import type { Meta, StoryObj } from "@storybook/react";

const RankedBarCanvas = () => (
  <div className="w-[480px]">
    <RankedBar
      description="Most common workflow transition from the upstream dashboard/workflow surfaces."
      label="Read -> Edit"
      percent={76}
      value={126}
    />
  </div>
);

const meta = {
  title: "Design System/Data Display/Data Visualization/Ranked Bar",
  component: RankedBarCanvas,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof RankedBarCanvas>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
