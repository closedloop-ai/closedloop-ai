import {
  RadioGroup,
  RadioGroupItem,
} from "@repo/design-system/components/ui/radio-group";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";

/**
 * A set of checkable buttons—known as radio buttons—where no more than one of
 * the buttons can be checked at a time.
 */
const meta: Meta<typeof RadioGroup> = {
  title: "Design System/Primitives/Radio Group",
  component: RadioGroup,
  tags: ["autodocs"],
  argTypes: {
    children: {
      control: false,
      description:
        "The `RadioGroupItem` set and its labels. Supplied by the story render, not by a control.",
    },
    defaultValue: {
      control: "text",
      description:
        "Item value checked on first render while the group is uncontrolled. Use one of `default`, `comfortable` or `compact` here.",
    },
    value: {
      control: "text",
      description:
        "Controlled checked value. Leave unset to let `defaultValue` and the items drive it.",
    },
    disabled: {
      control: "boolean",
      description: "Disables every item in the group.",
    },
    required: {
      control: "boolean",
      description: "Marks the group as required in an enclosing form.",
    },
    orientation: {
      control: { type: "radio" },
      options: ["horizontal", "vertical"],
      description:
        "Which arrow keys move the roving focus. Unset accepts both axes.",
    },
    className: {
      control: "text",
      description: "Extra classes merged onto the group container.",
    },
    onValueChange: {
      control: false,
      table: { category: "Events" },
    },
  },
  args: {
    defaultValue: "comfortable",
    className: "grid gap-2 grid-cols-[1rem_1fr] items-center",
    disabled: false,
    required: false,
    onValueChange: fn(),
  },
  render: (args) => (
    <RadioGroup {...args}>
      <RadioGroupItem id="r1" value="default" />
      <label htmlFor="r1">Default</label>
      <RadioGroupItem id="r2" value="comfortable" />
      <label htmlFor="r2">Comfortable</label>
      <RadioGroupItem id="r3" value="compact" />
      <label htmlFor="r3">Compact</label>
    </RadioGroup>
  ),
};

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default form of the radio group.
 */
export const Default: Story = {};
