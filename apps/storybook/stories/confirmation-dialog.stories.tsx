import { ConfirmationDialog } from "@repo/app/shared/components/confirmation-dialog";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, screen, userEvent } from "storybook/test";

/**
 * A modal asking someone to confirm an action before it runs, shown as a
 * full dialog on desktop and a slide up sheet on narrow screens, for any
 * action needing a yes or no.
 */
const meta = {
  title: "Composites/Overlays/Confirmation Dialog",
  component: ConfirmationDialog,
  tags: ["autodocs"],
  argTypes: {
    title: { control: "text", table: { category: "Content" } },
    description: { control: "text", table: { category: "Content" } },
    confirmLabel: { control: "text", table: { category: "Content" } },
    cancelLabel: { control: "text", table: { category: "Content" } },
    variant: {
      options: ["default", "destructive"],
      control: { type: "radio" },
      description: "Button variant used for the confirm action.",
      table: { category: "Appearance" },
    },
    open: { control: "boolean", table: { category: "State" } },
    isPending: {
      control: "boolean",
      description: "Disables both buttons and shows a spinner on confirm.",
      table: { category: "State" },
    },
    onOpenChange: { control: false, table: { category: "Events" } },
    onConfirm: { control: false, table: { category: "Events" } },
  },
  args: {
    open: true,
    onOpenChange: fn(),
    title: "Confirm compute target switch",
    description:
      "Switching targets will reset any in-flight local context for this draft.",
    confirmLabel: "Switch target",
    cancelLabel: "Keep current target",
    onConfirm: fn(),
    isPending: false,
    variant: "default",
  },
} satisfies Meta<typeof ConfirmationDialog>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args }) => {
    // The dialog renders through a Dialog/Sheet portal, outside canvasElement,
    // so the button is queried from `screen` rather than `within`.
    await userEvent.click(
      await screen.findByRole("button", { name: "Switch target" })
    );
    await expect(args.onConfirm).toHaveBeenCalled();
    await expect(args.onOpenChange).toHaveBeenCalledWith(false);
  },
};

export const Destructive: Story = {
  args: {
    title: "Delete workspace",
    description:
      "This removes the workspace and all associated drafts for your organization.",
    confirmLabel: "Delete workspace",
    variant: "destructive",
  },
};
