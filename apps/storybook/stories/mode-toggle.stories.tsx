import { ModeToggle } from "@repo/design-system/components/ui/mode-toggle";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
  title: "Design System/Navigation & Shell/Mode Toggle",
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
