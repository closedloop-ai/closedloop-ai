import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@repo/design-system/components/ui/sheet";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";

/**
 * Extends the Dialog component to display content that complements the main
 * content of the screen.
 */
const meta: Meta<typeof SheetContent> = {
  title: "Design System/Primitives/Sheet",
  component: Sheet,
  tags: ["autodocs"],
  argTypes: {
    side: {
      options: ["top", "bottom", "left", "right"],
      control: {
        type: "radio",
      },
    },
    hideClose: {
      control: "boolean",
      description:
        "Hide the built-in close button for sheets that carry their own dismiss control.",
    },
    className: {
      control: "text",
    },
    children: {
      control: false,
    },
    onOpenAutoFocus: {
      control: false,
      table: { category: "Events" },
    },
    onCloseAutoFocus: {
      control: false,
      table: { category: "Events" },
    },
    onEscapeKeyDown: {
      control: false,
      table: { category: "Events" },
    },
    onPointerDownOutside: {
      control: false,
      table: { category: "Events" },
    },
    onInteractOutside: {
      control: false,
      table: { category: "Events" },
    },
  },
  args: {
    side: "right",
    hideClose: false,
    onOpenAutoFocus: fn(),
    onCloseAutoFocus: fn(),
    onEscapeKeyDown: fn(),
    onPointerDownOutside: fn(),
    onInteractOutside: fn(),
  },
  render: (args) => (
    <Sheet>
      <SheetTrigger>Open</SheetTrigger>
      <SheetContent {...args}>
        <SheetHeader>
          <SheetTitle>Are you absolutely sure?</SheetTitle>
          <SheetDescription>
            This action cannot be undone. This will permanently delete your
            account and remove your data from our servers.
          </SheetDescription>
        </SheetHeader>
        <SheetFooter>
          <SheetClose>
            <button className="hover:underline" type="button">
              Cancel
            </button>
          </SheetClose>
          <button
            className="rounded bg-primary px-4 py-2 text-primary-foreground"
            type="button"
          >
            Submit
          </button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  ),
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof SheetContent>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default form of the sheet.
 */
export const Default: Story = {};
