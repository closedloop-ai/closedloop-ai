import { Toggle } from "@repo/design-system/components/ui/toggle";
import type { Meta, StoryObj } from "@storybook/react";
import { Bold, Italic } from "lucide-react";
import { fn } from "storybook/test";

/**
 * A pressable button that stays either on or off, showing its state with a
 * shaded background instead of a checkmark or switch. Use it for a
 * self-contained setting that toggles itself, like a bold or italic button
 * in a toolbar; reach for Button instead when a click fires a one-time
 * action, and use a checkbox or switch when the state belongs to a form
 * rather than a toolbar. It needs its own aria-label when its content is
 * just an icon, since there is no visible text to announce whether it is
 * pressed.
 */
const meta: Meta<typeof Toggle> = {
  title: "Primitives/Actions/Toggle",
  component: Toggle,
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
    disabled: {
      control: "boolean",
      table: { category: "State" },
    },
    children: {
      control: { disable: true },
      table: { category: "Content" },
    },
    asChild: { control: false, table: { category: "Content" } },
    onPressedChange: { control: false, table: { category: "Events" } },
  },
  args: {
    variant: "default",
    size: "default",
    disabled: false,
    children: <Bold className="h-4 w-4" />,
    "aria-label": "Toggle bold",
    onPressedChange: fn(),
  },
  parameters: {
    layout: "centered",
  },
};
export default meta;

type Story = StoryObj<typeof Toggle>;

/**
 * The default form of the toggle.
 */
export const Default: Story = {};

/**
 * Use the `outline` variant for a distinct outline, emphasizing the boundary
 * of the selection circle for clearer visibility
 */
export const Outline: Story = {
  args: {
    variant: "outline",
    children: <Italic className="h-4 w-4" />,
    "aria-label": "Toggle italic",
  },
};

/**
 * Use the text element to add a label to the toggle.
 */
export const WithText: Story = {
  render: (args) => (
    <Toggle {...args}>
      <Italic className="mr-2 h-4 w-4" />
      Italic
    </Toggle>
  ),
  args: { ...Outline.args },
};

/**
 * Use the `sm` size for a smaller toggle, suitable for interfaces needing
 * compact elements without sacrificing usability.
 */
export const Small: Story = {
  args: {
    size: "sm",
  },
};

/**
 * Use the `lg` size for a larger toggle, offering better visibility and
 * easier interaction for users.
 */
export const Large: Story = {
  args: {
    size: "lg",
  },
};

/**
 * Add the `disabled` prop to prevent interactions with the toggle.
 */
export const Disabled: Story = {
  args: {
    disabled: true,
  },
};
