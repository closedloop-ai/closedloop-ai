import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";

/**
 * Displays rich content in a portal, triggered by a button.
 */
const meta: Meta<typeof Popover> = {
  title: "Primitives/Overlays/Popover",
  component: Popover,
  tags: ["autodocs"],
  argTypes: {
    children: {
      control: false,
      description:
        "The `PopoverTrigger` / `PopoverContent` pair. Supplied by the story render, not by a control.",
    },
    open: {
      control: "boolean",
      description:
        "Controlled open state. Leave unset to let `defaultOpen` and the trigger drive it.",
    },
    defaultOpen: {
      control: "boolean",
      description:
        "Open state on first render when the popover is uncontrolled.",
    },
    modal: {
      control: "boolean",
      description:
        "Traps focus and blocks outside interaction while the popover is open.",
    },
    onOpenChange: {
      control: false,
      table: { category: "Events" },
    },
  },
  args: {
    defaultOpen: false,
    modal: false,
    onOpenChange: fn(),
  },

  render: (args) => (
    <Popover {...args}>
      <PopoverTrigger>Open</PopoverTrigger>
      <PopoverContent>Place content for the popover here.</PopoverContent>
    </Popover>
  ),
  parameters: {
    layout: "centered",
  },
};

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default form of the popover.
 */
export const Default: Story = {};
