import { TerminalBlock } from "@repo/design-system/components/ui/primitives/terminal-block";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * A dark terminal-style panel for a shell command and its output, used
 * instead of Code Block when you're showing a shell session, not source
 * code.
 */
const meta = {
  title: "Primitives/Content/Terminal Block",
  component: TerminalBlock,
  tags: ["autodocs"],
  argTypes: {
    command: {
      control: "text",
      description: "Rendered as a `$ ` line under the description.",
    },
    description: {
      control: "text",
      description: "Rendered as a `# ` comment line above the command.",
    },
    label: {
      control: "text",
      description: "Header caption used when no stream is set.",
    },
    text: {
      control: "text",
      description:
        "Raw body. Replaces the command and description pair when supplied.",
    },
    stream: {
      options: ["stdout", "stderr"],
      control: { type: "radio" },
      description: "Names the header and tints stderr output red.",
    },
  },
  parameters: { layout: "padded" },
  args: {
    command: "pnpm -C apps/storybook build",
    description: "Build Storybook for review",
    label: "terminal",
  },
} satisfies Meta<typeof TerminalBlock>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Stderr: Story = {
  args: {
    text: "Error: Duplicate stories with id: design-system-primitives-status-badges--default",
    stream: "stderr",
  },
};
