import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, screen, userEvent } from "storybook/test";
import { RenameDialog } from "./rename-dialog";

/**
 * A small dialog for renaming a document's title and file name without
 * leaving what you're doing, staying open with your edits if the save fails.
 */
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

export const Default: Story = {
  play: async ({ args }) => {
    // The dialog renders through a Radix Dialog portal, outside the story
    // canvas, so this queries the whole screen rather than canvasElement.
    const titleField = await screen.findByLabelText("Title");
    await userEvent.clear(titleField);
    await userEvent.type(titleField, "Renamed Plan");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await expect(args.onRename).toHaveBeenCalledWith(
      "Renamed Plan",
      "implementation-plan.md"
    );
  },
};

export const Saving: Story = {
  args: { isPending: true },
};
