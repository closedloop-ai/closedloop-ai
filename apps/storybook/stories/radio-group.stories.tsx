import {
  RadioGroup,
  RadioGroupItem,
} from "@repo/design-system/components/ui/radio-group";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * A set of checkable buttons—known as radio buttons—where no more than one of
 * the buttons can be checked at a time.
 */
const meta: Meta<typeof RadioGroup> = {
  title: "Primitives v1.0/Inputs/Radio Group",
  component: RadioGroup,
  tags: ["deprecated", "autodocs"],
  argTypes: {
    variant: {
      options: ["default", "segmented"],
      control: { type: "radio" },
    },
  },
  args: {
    defaultValue: "comfortable",
    className: "grid gap-2 grid-cols-[1rem_1fr] items-center",
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

/**
 * The `segmented` variant: the outline segmented control's look with radio
 * keyboard behavior, where arrow keys move the selection. Each item's children
 * are its visible label and accessible name.
 */
export const Segmented: Story = {
  args: {
    variant: "segmented",
    className: undefined,
    "aria-label": "Density",
  },
  render: (args) => (
    <RadioGroup {...args}>
      <RadioGroupItem value="default">Default</RadioGroupItem>
      <RadioGroupItem value="comfortable">Comfortable</RadioGroupItem>
      <RadioGroupItem value="compact">Compact</RadioGroupItem>
    </RadioGroup>
  ),
};
