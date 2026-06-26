import type { Meta, StoryObj } from "@storybook/react";
import { RenameDialog } from "./rename-dialog";

const meta = {
  title: "App Core/Documents/Rename Dialog",
  component: RenameDialog,
  tags: ["autodocs"],
  args: {
    open: true,
    onOpenChange: () => undefined,
    title: "Rename document",
    description: "Update the title and file name for this document.",
    currentTitle: "Implementation Plan",
    currentFileName: "implementation-plan.md",
    onRename: async () => true,
    isPending: false,
  },
} satisfies Meta<typeof RenameDialog>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Saving: Story = {
  args: { isPending: true },
};
