import { CopyButton } from "@repo/design-system/components/ui/primitives/copy-button";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * A small ghost button that copies a value like a command, ID, or path to
 * the clipboard, flashing a checkmark and Copied for confirmation.
 */
const meta = {
  title: "Composites/Actions/Copy Button",
  component: CopyButton,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  argTypes: {
    text: {
      control: "text",
      description: "Value written to the clipboard on click.",
    },
    label: {
      control: "text",
      description: "Button label before the copy succeeds.",
    },
  },
  args: {
    text: "pnpm -C apps/storybook build",
    label: "Copy command",
  },
} satisfies Meta<typeof CopyButton>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
