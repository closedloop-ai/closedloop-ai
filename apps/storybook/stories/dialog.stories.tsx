import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@repo/design-system/components/ui/dialog";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";

/**
 * A centered window that blocks the page until closed, for general modal
 * content, unlike the Sheet which slides in alongside the page or the Alert
 * Dialog which forces a yes or no.
 */
const meta: Meta<typeof Dialog> = {
  title: "Primitives/Overlays/Dialog",
  component: Dialog,
  tags: ["autodocs"],
  argTypes: {
    // Left out of `args` on purpose: setting it makes the dialog controlled and
    // the trigger stops opening it.
    open: {
      control: "boolean",
      description: "Controlled open state. Overrides defaultOpen.",
      table: { category: "State" },
    },
    defaultOpen: { control: "boolean", table: { category: "State" } },
    modal: {
      control: "boolean",
      description: "Marks content outside the dialog inert while it is open.",
      table: { category: "State" },
    },
    children: { control: false, table: { category: "Content" } },
    onOpenChange: { control: false, table: { category: "Events" } },
  },
  args: {
    defaultOpen: false,
    modal: true,
    onOpenChange: fn(),
  },
  render: (args) => (
    <Dialog {...args}>
      <DialogTrigger>Open</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Are you absolutely sure?</DialogTitle>
          <DialogDescription>
            This action cannot be undone. This will permanently delete your
            account and remove your data from our servers.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-4">
          <button className="hover:underline" type="button">
            Cancel
          </button>
          <DialogClose>
            <button
              className="rounded bg-primary px-4 py-2 text-primary-foreground"
              type="button"
            >
              Continue
            </button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
  parameters: {
    layout: "centered",
  },
};

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default form of the dialog.
 */
export const Default: Story = {};
