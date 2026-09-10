import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";

/**
 * A control that allows the user to toggle between checked and not checked.
 */
const meta: Meta<typeof Checkbox> = {
  title: "Primitives/Inputs/Checkbox",
  component: Checkbox,
  tags: ["autodocs"],
  argTypes: {
    checked: {
      options: [false, true, "indeterminate"],
      control: { type: "radio" },
      description:
        "Controlled state. Leave unset to let the checkbox track its own state.",
    },
    defaultChecked: {
      control: false,
      description: "Initial state when the checkbox is uncontrolled.",
    },
    disabled: { control: "boolean" },
    required: { control: "boolean" },
    id: { control: "text" },
    onCheckedChange: { control: false, table: { category: "Events" } },
  },
  args: {
    id: "terms",
    disabled: false,
    required: false,
    onCheckedChange: fn(),
  },
  render: (args) => (
    <div className="flex space-x-2">
      <Checkbox {...args} />
      <label
        className="font-medium text-sm leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-50"
        htmlFor={args.id}
      >
        Accept terms and conditions
      </label>
    </div>
  ),
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof Checkbox>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default form of the checkbox.
 */
export const Default: Story = {};

/**
 * Use the `disabled` prop to disable the checkbox.
 */
export const Disabled: Story = {
  args: {
    id: "disabled-terms",
    disabled: true,
  },
};
