import { Label } from "@repo/design-system/components/ui/label";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * Renders an accessible label associated with controls.
 */
const meta = {
  title: "Primitives/Inputs/Label",
  component: Label,
  tags: ["autodocs"],
  argTypes: {
    children: {
      control: { type: "text" },
    },
    htmlFor: {
      control: "text",
      description: "Id of the form control this label names.",
    },
    className: { control: "text" },
  },
  args: {
    children: "Your email address",
    htmlFor: "email",
  },
} satisfies Meta<typeof Label>;

export default meta;

type Story = StoryObj<typeof Label>;

/**
 * The default form of the label.
 */
export const Default: Story = {};
