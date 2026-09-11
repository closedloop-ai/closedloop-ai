import { Button } from "@repo/design-system/components/ui/button";
import type { Meta, StoryObj } from "@storybook/react";
import { Loader2, Mail } from "lucide-react";

/**
 * A clickable control for triggering a one-time action, like submitting a
 * form, versus Toggle for a control that stays pressed.
 */
const meta = {
  title: "Primitives/Actions/Button",
  component: Button,
  tags: ["autodocs"],
  argTypes: {
    children: {
      control: "text",
    },
    variant: {
      options: [
        "default",
        "destructive",
        "outline",
        "secondary",
        "ghost",
        "link",
        "linkForeground",
      ],
      control: { type: "radio" },
    },
    size: {
      options: ["default", "sm", "lg", "icon", "icon-sm", "icon-lg"],
      control: { type: "radio" },
    },
  },
  parameters: {
    layout: "centered",
  },
  args: {
    variant: "default",
    size: "default",
    children: "Button",
  },
} satisfies Meta<typeof Button>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default form of the button, used for primary actions and commands.
 */
export const Default: Story = {};

/**
 * Every `variant` value rendered side by side, labelled, so one Chromatic
 * snapshot keeps visual coverage of the full set instead of one story per
 * value. Drive `variant` from the Controls panel on Default to preview a
 * single value in isolation.
 */
export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-wrap items-end gap-4">
      {(
        [
          "default",
          "destructive",
          "outline",
          "secondary",
          "ghost",
          "link",
          "linkForeground",
        ] as const
      ).map((variant) => (
        <div className="flex flex-col items-center gap-2" key={variant}>
          <span className="text-muted-foreground text-xs">{variant}</span>
          <Button variant={variant}>Button</Button>
        </div>
      ))}
    </div>
  ),
};

/**
 * Every `size` value rendered side by side, labelled, so one Chromatic
 * snapshot keeps visual coverage of the full set instead of one story per
 * value. Drive `size` from the Controls panel on Default to preview a single
 * value in isolation.
 */
export const AllSizes: Story = {
  render: () => (
    <div className="flex flex-wrap items-end gap-4">
      <div className="flex flex-col items-center gap-2">
        <span className="text-muted-foreground text-xs">default</span>
        <Button>Button</Button>
      </div>
      <div className="flex flex-col items-center gap-2">
        <span className="text-muted-foreground text-xs">sm</span>
        <Button size="sm">Button</Button>
      </div>
      <div className="flex flex-col items-center gap-2">
        <span className="text-muted-foreground text-xs">lg</span>
        <Button size="lg">Button</Button>
      </div>
      <div className="flex flex-col items-center gap-2">
        <span className="text-muted-foreground text-xs">icon</span>
        <Button size="icon" variant="secondary">
          <Mail />
        </Button>
      </div>
      <div className="flex flex-col items-center gap-2">
        <span className="text-muted-foreground text-xs">icon-sm</span>
        <Button size="icon-sm" variant="secondary">
          <Mail />
        </Button>
      </div>
      <div className="flex flex-col items-center gap-2">
        <span className="text-muted-foreground text-xs">icon-lg</span>
        <Button size="icon-lg" variant="secondary">
          <Mail />
        </Button>
      </div>
    </div>
  ),
};

/**
 * Add the `disabled` prop to a button to prevent interactions and add a
 * loading indicator, such as a spinner, to signify an in-progress action.
 */
export const Loading: Story = {
  render: (args) => (
    <Button {...args}>
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      Button
    </Button>
  ),
  args: {
    variant: "outline",
    disabled: true,
  },
};

/**
 * Add an icon element to a button to enhance visual communication and
 * providing additional context for the action.
 */
export const WithIcon: Story = {
  render: (args) => (
    <Button {...args}>
      <Mail className="mr-2 h-4 w-4" /> Login with Email Button
    </Button>
  ),
  args: {
    variant: "secondary",
  },
};

/**
 * Add the `disabled` prop to prevent interactions with the button.
 */
export const Disabled: Story = {
  args: {
    disabled: true,
  },
};
