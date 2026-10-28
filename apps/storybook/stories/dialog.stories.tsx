import { Button } from "@repo/design-system/components/ui/button";
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

/**
 * A window overlaid on either the primary window or another dialog window,
 * rendering the content underneath inert.
 */
const meta: Meta<typeof Dialog> = {
  title: "Primitives v1.0/Overlays/Dialog",
  component: Dialog,
  tags: ["deprecated", "autodocs"],
  argTypes: {},
  render: (args) => renderDialog(args),
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

/**
 * A large dialog keeps the 900 by 680 canvas on roomy screens and leaves a
 * one-rem inset on every edge when the viewport is smaller.
 */
export const Large: Story = {
  args: {
    defaultOpen: true,
  },
  render: (args) => renderDialog(args, "large"),
};

/**
 * An xlarge dialog hosts its own multi-column layout rather than a single
 * column of fields, so it carries a softer radius along with the wider canvas.
 */
export const XLarge: Story = {
  args: {
    defaultOpen: true,
  },
  render: (args) => renderDialog(args, "xlarge"),
};

type DialogStoryArgs = React.ComponentProps<typeof Dialog>;
type DialogStorySize = React.ComponentProps<typeof DialogContent>["size"];

function renderDialog(args: DialogStoryArgs, size?: DialogStorySize) {
  return (
    <Dialog {...args}>
      <DialogTrigger asChild>
        <Button variant="outline">Open dialog</Button>
      </DialogTrigger>
      <DialogContent
        className={size === undefined ? undefined : "flex flex-col"}
        size={size}
      >
        <DialogHeader>
          <DialogTitle>Choose a dialog size</DialogTitle>
          <DialogDescription>
            The sized presets reserve room for structured content and keep every
            edge inside the viewport.
          </DialogDescription>
        </DialogHeader>
        {size === undefined ? null : (
          <div className="flex-1 text-muted-foreground text-sm">
            {size} dialog content
          </div>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <DialogClose asChild>
            <Button>Continue</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
