import { Label } from "@repo/design-system/components/ui/label";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * The text that names a form control, clicking it focuses or toggles that
 * control while giving it an accessible name for screen readers.
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
