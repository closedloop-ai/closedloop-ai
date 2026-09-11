import { ModeToggle } from "@repo/design-system/components/ui/mode-toggle";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * An icon button that opens a menu for Light, Dark and System color themes,
 * rendering a plain sun icon at first load to avoid a flash of the wrong
 * theme.
 */
const meta = {
  title: "Primitives/Navigation/Mode Toggle",
  component: ModeToggle,
  tags: ["autodocs"],
  argTypes: {
    className: {
      control: "text",
      description: "Extra classes merged onto the icon trigger button.",
    },
  },
  args: {
    className: "",
  },
} satisfies Meta<typeof ModeToggle>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
