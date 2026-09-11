import { ConfirmationDialog } from "@repo/app/shared/components/confirmation-dialog";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";

/**
 * A modal that asks someone to confirm an action before it happens: a title,
 * a description, and Cancel and Confirm buttons. It shows as a full dialog
 * on desktop and slides up as a sheet on narrow screens, so the same
 * component works everywhere. Reach for it any time an action needs a yes or
 * no before it runs, and switch the confirm button to the destructive
 * variant when that action can't be undone. If the confirm action fails, the
 * dialog stays open so someone can try again instead of silently closing.
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
