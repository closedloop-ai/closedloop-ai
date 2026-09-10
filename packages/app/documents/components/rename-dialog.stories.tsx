import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import { RenameDialog } from "./rename-dialog";

const meta = {
  title: "Composites/Documents/Rename Dialog",
  component: RenameDialog,
  tags: ["autodocs"],
  argTypes: {
    title: { control: "text", table: { category: "Content" } },
    description: { control: "text", table: { category: "Content" } },
    currentTitle: {
      control: "text",
      description:
        "Seeds the Title field. Changing it remounts the body, so the field picks the new value up.",
      table: { category: "Content" },
    },
    currentFileName: {
      control: "text",
      description: "Seeds the File name field, on the same remount rule.",
      table: { category: "Content" },
    },
    open: { control: "boolean", table: { category: "State" } },
    isPending: { control: "boolean", table: { category: "State" } },
    onOpenChange: { control: false, table: { category: "Events" } },
    onRename: {
      control: false,
      description: "Resolving true closes the dialog; false keeps it open.",
      table: { category: "Events" },
    },
  },
  args: {
    open: true,
    onOpenChange: fn(),
    title: "Rename document",
    description: "Update the title and file name for this document.",
    currentTitle: "Implementation Plan",
    currentFileName: "implementation-plan.md",
    onRename: fn(async () => true),
    isPending: false,
  },
} satisfies Meta<typeof RenameDialog>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Saving: Story = {
  args: { isPending: true },
};
