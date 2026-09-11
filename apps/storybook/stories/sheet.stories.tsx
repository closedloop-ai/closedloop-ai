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
import { expect, fn, screen, userEvent, within } from "storybook/test";

/**
 * A side panel that slides in from a screen edge for filters or details,
 * without interrupting the page the way a Dialog does.
 */
const meta: Meta<typeof SheetContent> = {
  title: "Primitives/Overlays/Sheet",
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
export const Default: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Open" }));
    await expect(await screen.findByRole("dialog")).toBeVisible();
    await expect(args.onOpenAutoFocus).toHaveBeenCalled();
  },
};
