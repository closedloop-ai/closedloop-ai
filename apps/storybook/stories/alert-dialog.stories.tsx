import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@repo/design-system/components/ui/alert-dialog";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";

/**
 * A modal that forces you to confirm or cancel an action like deleting an
 * account, with no close button and no dismissing it by clicking outside,
 * unlike a plain Dialog.
 */
const meta: Meta<typeof AlertDialog> = {
  title: "Composites/Overlays/Alert Dialog",
  component: AlertDialog,
  tags: ["autodocs"],
  argTypes: {
    // `open` is left without an arg on purpose: supplying it makes the dialog
    // controlled, and the trigger would then stop opening it.
    open: {
      control: "boolean",
      description:
        "Controlled open state. Leave unset so the trigger drives the dialog.",
    },
    defaultOpen: {
      control: "boolean",
      description: "Open state on first render when `open` is not supplied.",
    },
    onOpenChange: { control: false, table: { category: "Events" } },
    children: { control: false },
  },
  args: {
    defaultOpen: false,
    onOpenChange: fn(),
  },
  render: (args) => (
    <AlertDialog {...args}>
      <AlertDialogTrigger>Open</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Are you sure absolutely sure?</AlertDialogTitle>
          <AlertDialogDescription>
            This action cannot be undone. This will permanently delete your
            account and remove your data from our servers.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction>Continue</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  ),
  parameters: {
    layout: "centered",
  },
};

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default form of the alert dialog.
 */
export const Default: Story = {};
