import {
  RankedBar,
  RankedBarPresentation,
} from "@repo/design-system/components/ui/primitives/ranked-bar";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";

/**
 * One row in a ranked list: a label on the left, a value and percentage
 * badge on the right, and a horizontal fill bar underneath showing that
 * row's share of the total. Use it for top-N style lists, like top workflow
 * transitions or top contributors, where the length of the bar carries
 * meaning, rather than a plain table row. The percentage is clamped between
 * 0 and 100, so a bad or missing number renders as an empty bar instead of
 * breaking the layout, and a flat presentation drops its own border and
 * background for use inside a card that already has one.
 */
const meta = {
  title: "Composites/Charts/Ranked Bar",
  component: RankedBar,
  tags: ["autodocs"],
  argTypes: {
    label: {
      control: "text",
      description: "Row title. Accepts a node, but a plain string is typical.",
    },
    value: {
      control: "text",
      description: "Formatted figure shown at the end of the row.",
    },
    percent: {
      control: { type: "range", min: 0, max: 100, step: 1 },
      description:
        "Fill width as a percentage. Clamped to 0-100; a non-finite value falls back to 0.",
    },
    description: {
      control: "text",
      description: "Muted caption under the label.",
    },
    badge: {
      control: false,
      description: "Optional node rendered beside the label.",
    },
    presentation: {
      control: { type: "radio" },
      options: [RankedBarPresentation.Framed, RankedBarPresentation.Flat],
      description:
        "`framed` draws the bordered card around the row; `flat` drops the frame for rows already inside one.",
    },
    showPercent: {
      control: "boolean",
      description: "Renders the percentage badge beside the value.",
    },
    className: {
      control: "text",
      description: "Extra classes merged onto the row container.",
    },
  },
  parameters: {
    layout: "centered",
  },
  args: {
    description:
      "Most common workflow transition from the upstream dashboard/workflow surfaces.",
    label: "Read -> Edit",
    percent: 76,
    value: "126 lines/$",
    presentation: RankedBarPresentation.Framed,
    showPercent: true,
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
