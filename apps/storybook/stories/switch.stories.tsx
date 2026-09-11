import { Switch } from "@repo/design-system/components/ui/switch";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";

/**
 * A sliding toggle that switches a single setting between on and off, with
 * the thumb moving to one side or the other to show the current state. Use
 * it for a setting that takes effect right away, like turning a feature on,
 * rather than Checkbox, which is the better choice for selecting several
 * items in a list or agreeing to a term before a form submits. It renders a
 * hidden input behind the scenes, so you can give it a name and value for
 * form submission even though nothing on screen looks like a text field.
 */
const meta: Meta<typeof Switch> = {
  title: "Primitives/Inputs/Switch",
  component: Switch,
  tags: ["autodocs"],
  argTypes: {
    // `checked` is deliberately left without an arg. Supplying one makes the
    // switch controlled, and the story has no state to write back, so the
    // thumb would stop moving on click.
    checked: {
      control: "boolean",
      description:
        "Controlled state. Set it only alongside an onCheckedChange handler that stores the value.",
      table: { category: "State" },
    },
    defaultChecked: {
      control: "boolean",
      description: "Starting state when the switch is uncontrolled.",
      table: { category: "State" },
    },
    disabled: { control: "boolean", table: { category: "State" } },
    required: { control: "boolean", table: { category: "State" } },
    name: {
      control: "text",
      description: "Name of the hidden input submitted with a form.",
      table: { category: "Form" },
    },
    value: {
      control: "text",
      description: 'Submitted value when checked. Defaults to "on".',
      table: { category: "Form" },
    },
    id: { control: "text", table: { category: "Form" } },
    onCheckedChange: { control: false, table: { category: "Events" } },
    asChild: { control: false },
  },
  args: {
    defaultChecked: false,
    disabled: false,
    required: false,
    onCheckedChange: fn(),
  },
  parameters: {
    layout: "centered",
  },
  render: (args) => (
    <div className="flex items-center space-x-2">
      <Switch {...args} />
      <label className="peer-disabled:text-foreground/50" htmlFor={args.id}>
        Airplane Mode
      </label>
    </div>
  ),
};

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default form of the switch.
 */
export const Default: Story = {
  args: {
    id: "default-switch",
  },
};

/**
 * Use the `disabled` prop to disable the switch.
 */
export const Disabled: Story = {
  args: {
    id: "disabled-switch",
    disabled: true,
  },
};
