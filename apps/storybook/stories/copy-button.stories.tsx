import { CopyButton } from "@repo/design-system/components/ui/primitives/copy-button";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * A small ghost button that copies a piece of text to the clipboard when you
 * click it. The icon and label switch to a checkmark and the word Copied for
 * a moment, so you get confirmation without a separate toast. Use it next to
 * short values like a command, an ID, or a path that someone would otherwise
 * have to select and copy by hand.
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
