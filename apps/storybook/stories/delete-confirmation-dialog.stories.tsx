import { DeleteConfirmationDialog } from "@repo/app/shared/components/delete-confirmation-dialog";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, screen, userEvent } from "storybook/test";

/**
 * A modal built specifically for delete actions, with the heading and
 * destructive styling already set, so you reach for it instead of a general
 * confirmation dialog.
 */
const meta = {
  title: "Composites/Overlays/Delete Confirmation Dialog",
  component: DeleteConfirmationDialog,
  tags: ["autodocs"],
  argTypes: {
    title: {
      control: "text",
      description: 'Noun rendered after "Delete" in the heading.',
    },
    itemName: {
      control: "text",
      description: "Name quoted in the default body copy.",
    },
    description: {
      control: "text",
      description: "Overrides the default body copy.",
    },
    open: { control: "boolean" },
    isPending: { control: "boolean" },
    onOpenChange: { control: false, table: { category: "Events" } },
    // Resolving false keeps the dialog open, so the mock has to resolve true.
    onConfirm: { control: false, table: { category: "Events" } },
  },
  args: {
    open: true,
    onOpenChange: fn(),
    title: "project",
    itemName: "Editor refresh",
    onConfirm: fn(async () => true),
    isPending: false,
  },
} satisfies Meta<typeof DeleteConfirmationDialog>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args }) => {
    // The dialog renders through a Dialog/Sheet portal, outside canvasElement,
    // so the buttons are queried from `screen` rather than `within`.
    await userEvent.click(
      await screen.findByRole("button", { name: "Delete" })
    );
    await expect(args.onConfirm).toHaveBeenCalled();
    await expect(args.onOpenChange).toHaveBeenCalledWith(false);
  },
};
