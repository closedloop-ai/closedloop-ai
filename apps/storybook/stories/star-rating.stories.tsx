import { StarRating } from "@repo/design-system/components/ui/star-rating";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { fn } from "storybook/test";

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
 * Shows five stars that fill in as you click or drag across them, giving a
 * whole-number rating from zero to five. Reach for it when someone needs to
 * rate something on a small numeric scale, rather than Switch or Checkbox,
 * which only handle on and off. It also responds to arrow keys, and the
 * readonly flag turns off all interaction even when you still pass an
 * onChange handler, which is how you display a rating without letting anyone
 * change it.
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

export const Default: Story = {};

export const Interactive: Story = {
  render: (args) => (
    <InteractiveStarRating
      size={args.size ?? "default"}
      value={args.value ?? 0}
    />
  ),
};
