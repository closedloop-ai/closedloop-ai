import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import type { Meta, StoryObj } from "@storybook/react";
import { Bold, Italic, Underline } from "lucide-react";
import { fn } from "storybook/test";

/**
 * A set of two-state buttons that can be toggled on or off.
 */
const meta: Meta<typeof ToggleGroup> = {
  title: "Design System/Primitives/Toggle Group",
  component: ToggleGroup,
  tags: ["autodocs"],
  argTypes: {
    variant: {
      options: ["default", "outline"],
      control: { type: "radio" },
      table: { category: "Appearance" },
    },
    size: {
      options: ["default", "sm", "lg"],
      control: { type: "radio" },
      table: { category: "Appearance" },
    },
    spacing: {
      control: { type: "number", min: 0, max: 8, step: 1 },
      table: { category: "Appearance" },
      description: "Gap between items, in spacing-scale units.",
    },
    type: {
      options: ["multiple", "single"],
      control: { type: "radio" },
      table: { category: "State" },
    },
    disabled: {
      control: "boolean",
      table: { category: "State" },
    },
    orientation: {
      options: ["horizontal", "vertical"],
      control: { type: "radio" },
      table: { category: "State" },
    },
    // Selection shape follows `type` (a string for single, a string array for
    // multiple), so editing it from the panel can hand Radix the wrong shape.
    value: { control: false, table: { category: "State" } },
    defaultValue: { control: false, table: { category: "State" } },
    children: { control: false, table: { category: "Content" } },
    onValueChange: { control: false, table: { category: "Events" } },
  },
  args: {
    variant: "default",
    size: "default",
    spacing: 0,
    type: "multiple",
    orientation: "horizontal",
    disabled: false,
    onValueChange: fn(),
  },
  render: (args) => (
    <ToggleGroup {...args}>
      <ToggleGroupItem aria-label="Toggle bold" value="bold">
        <Bold className="h-4 w-4" />
      </ToggleGroupItem>
      <ToggleGroupItem aria-label="Toggle italic" value="italic">
        <Italic className="h-4 w-4" />
      </ToggleGroupItem>
      <ToggleGroupItem aria-label="Toggle underline" value="underline">
        <Underline className="h-4 w-4" />
      </ToggleGroupItem>
    </ToggleGroup>
  ),
  parameters: {
    layout: "centered",
  },
};

export default meta;

type Story = StoryObj<typeof ToggleGroup>;

/**
 * The default form of the toggle group.
 */
export const Default: Story = {};

/**
 * Use the `outline` variant to emphasizing the individuality of each button
 * while keeping them visually cohesive.
 */
export const Outline: Story = {
  args: {
    variant: "outline",
  },
};

/**
 * Use the `single` type to create exclusive selection within the button
 * group, allowing only one button to be active at a time.
 */
export const Single: Story = {
  args: {
    type: "single",
  },
};

/**
 * Use the `sm` size for a compact version of the button group, featuring
 * smaller buttons for spaces with limited real estate.
 */
export const Small: Story = {
  args: {
    size: "sm",
  },
};

/**
 * Use the `lg` size for a more prominent version of the button group, featuring
 * larger buttons for emphasis.
 */
export const Large: Story = {
  args: {
    size: "lg",
  },
};

/**
 * Add the `disabled` prop to a button to prevent interactions.
 */
export const Disabled: Story = {
  args: {
    disabled: true,
  },
};
