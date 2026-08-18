import {
  RankedBar,
  RankedBarPresentation,
} from "@repo/design-system/components/ui/primitives/ranked-bar";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";

const meta = {
  title: "Design System/Data Display/Data Visualization/Ranked Bar",
  component: RankedBar,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
  args: {
    description:
      "Most common workflow transition from the upstream dashboard/workflow surfaces.",
    label: "Read -> Edit",
    percent: 76,
    value: "126 lines/$",
  },
  render: (args) => (
    <div className="w-[480px]">
      <RankedBar {...args} />
    </div>
  ),
} satisfies Meta<typeof RankedBar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.queryByRole("progressbar")).not.toBeInTheDocument();
    await expect(canvas.getByText("126 lines/$")).toBeVisible();
  },
};

export const FlatWithoutPercent: Story = {
  args: {
    presentation: RankedBarPresentation.Flat,
    showPercent: false,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.queryByRole("progressbar")).not.toBeInTheDocument();
    await expect(canvas.getByText("126 lines/$")).toBeVisible();
    await expect(canvas.queryByText("76%")).not.toBeInTheDocument();
  },
};
