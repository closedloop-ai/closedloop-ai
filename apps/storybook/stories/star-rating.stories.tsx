import { StarRating } from "@repo/design-system/components/ui/star-rating";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";

const InteractiveStarRating = ({
  value,
  size,
}: Readonly<{ value: number; size: "sm" | "default" | "lg" }>) => {
  const [currentValue, setCurrentValue] = useState(value);
  return (
    <StarRating onChange={setCurrentValue} size={size} value={currentValue} />
  );
};

/**
 * Five stars that fill in as you click or drag across them for a whole
 * number rating from zero to five, used instead of Switch or Checkbox for a
 * small numeric scale.
 */
const meta = {
  title: "Primitives/Inputs/Star Rating",
  component: StarRating,
  tags: ["autodocs"],
  argTypes: {
    value: {
      control: { type: "range", min: 0, max: 5, step: 1 },
      description: "Filled star count. The component clamps to 0 through 5.",
    },
    size: {
      options: ["sm", "default", "lg"],
      control: { type: "radio" },
    },
    readonly: {
      control: "boolean",
      description:
        "Turns off hover, click and keyboard interaction even when onChange is supplied.",
    },
    onChange: { control: false, table: { category: "Events" } },
  },
  args: {
    value: 4,
    size: "default",
    readonly: false,
    onChange: fn(),
  },
} satisfies Meta<typeof StarRating>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    // Individual stars have no accessible name, only a shared `role="radio"`,
    // so there is genuinely no accessible handle to query by beyond position.
    const stars = await canvas.findAllByRole("radio");

    await userEvent.click(stars[0]);

    await expect(args.onChange).toHaveBeenCalledWith(1);
  },
};

export const Interactive: Story = {
  render: (args) => (
    <InteractiveStarRating
      size={args.size ?? "default"}
      value={args.value ?? 0}
    />
  ),
};
