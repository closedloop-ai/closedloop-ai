import { DeleteConfirmationDialog } from "@repo/app/shared/components/delete-confirmation-dialog";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";

/**
 * A modal built specifically for delete actions: the heading reads 'Delete'
 * plus whatever you're removing, and the body warns that the action can't be
 * undone. Use it instead of a general purpose confirmation dialog whenever
 * the action is a delete, since the wording and destructive styling are
 * already built in. You can swap in custom body copy when the default
 * warning would be misleading, for example when deleting a record only
 * removes it from ClosedLoop and not a linked GitHub pull request. Like a
 * plain confirmation dialog, it stays open if the delete fails so the person
 * can try again.
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

export const Default: Story = {};
