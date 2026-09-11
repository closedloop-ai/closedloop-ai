import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";

/**
 * A small square box you click to turn a single choice on or off, showing a
 * check mark when selected. Use it for an independent yes-or-no choice, like
 * agreeing to terms, or for one item in a multi-select list. Reach for
 * Switch instead when the choice takes effect immediately, like a settings
 * toggle, and Radio Group when only one of several options can be picked. It
 * also supports an indeterminate state, shown as a dash instead of a check,
 * for when only some items in a group it represents are selected.
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
    // `items-center` is load-bearing, and this story shipped without it. A bare
    // `flex` row is `align-items: stretch`, so the 16px box and the
    // `leading-none` label both start at the top and the text sits about a pixel
    // above the box's centre. Every one of the 11 places production pairs a
    // Checkbox with a label uses `flex items-center gap-*` (the twelfth,
    // `findings-triage-list`, uses `items-start` on purpose for multi-line
    // findings), so the story was showing an alignment the product never renders.
    <div className="flex items-center gap-2">
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
