import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";

/**
 * A floating panel of custom content that opens near a button you click, for
 * anything richer than a menu of actions or a plain hover hint. Reach for
 * the Dropdown Menu instead when the content is really a list of choices,
 * and reach for a Tooltip instead when it should only appear on hover and
 * never be interacted with. Unlike a dialog it does not block the rest of
 * the page by default, so you can still work outside it while it is open,
 * though you can turn that on if the content needs full attention.
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
