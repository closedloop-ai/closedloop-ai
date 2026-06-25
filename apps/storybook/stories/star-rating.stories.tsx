import { StarRating } from "@repo/design-system/components/ui/star-rating";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

const InteractiveStarRating = ({
  value,
  size,
}: Readonly<{ value: number; size: "sm" | "default" | "lg" }>) => {
  const [currentValue, setCurrentValue] = useState(value);
  return (
    <StarRating onChange={setCurrentValue} size={size} value={currentValue} />
  );
};

const meta = {
  title: "Design System/Primitives/Star Rating",
  component: StarRating,
  tags: ["autodocs"],
  args: {
    value: 4,
    size: "default",
    readonly: false,
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
