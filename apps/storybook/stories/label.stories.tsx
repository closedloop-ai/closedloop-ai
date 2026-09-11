import { Label } from "@repo/design-system/components/ui/label";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * The text that names a form control, such as a Checkbox, Input or Radio
 * Group item. Set htmlFor to the control's id, and clicking the label
 * focuses or toggles that control while also giving it an accessible name
 * for screen readers. It carries no visual style beyond a small bold weight,
 * so it always sits next to the control it names rather than standing alone
 * as a heading.
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
