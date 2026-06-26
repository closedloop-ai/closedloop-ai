import { DeleteConfirmationDialog } from "@repo/app/shared/components/delete-confirmation-dialog";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
  title: "Design System/Primitives/Delete Confirmation Dialog",
  component: DeleteConfirmationDialog,
  tags: ["autodocs"],
  args: {
    open: true,
    onOpenChange: () => undefined,
    title: "project",
    itemName: "Editor refresh",
    onConfirm: async () => true,
    isPending: false,
  },
} satisfies Meta<typeof DeleteConfirmationDialog>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
