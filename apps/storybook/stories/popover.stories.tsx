import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, screen, userEvent, within } from "storybook/test";

/**
 * A floating panel of custom content that opens near a clicked button, for
 * anything richer than a Dropdown Menu's list of choices or a Tooltip's
 * hover-only hint.
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
export const Default: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Open" }));
    // The content is a Radix popover portaled to the document body.
    await expect(
      await screen.findByText("Place content for the popover here.")
    ).toBeVisible();
    await expect(args.onOpenChange).toHaveBeenCalledWith(true);
  },
};
