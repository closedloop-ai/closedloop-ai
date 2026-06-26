import { ConfirmationDialog } from "@repo/app/shared/components/confirmation-dialog";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
  title: "Design System/Primitives/Confirmation Dialog",
  component: ConfirmationDialog,
  tags: ["autodocs"],
  args: {
    open: true,
    onOpenChange: () => undefined,
    title: "Confirm compute target switch",
    description:
      "Switching targets will reset any in-flight local context for this draft.",
    confirmLabel: "Switch target",
    cancelLabel: "Keep current target",
    onConfirm: async () => undefined,
    isPending: false,
    variant: "default",
  },
} satisfies Meta<typeof ConfirmationDialog>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Destructive: Story = {
  args: {
    title: "Delete workspace",
    description:
      "This removes the workspace and all associated drafts for your organization.",
    confirmLabel: "Delete workspace",
    variant: "destructive",
  },
};
