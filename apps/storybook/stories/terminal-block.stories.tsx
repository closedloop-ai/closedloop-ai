import { TerminalBlock } from "@repo/design-system/components/ui/primitives/terminal-block";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
  title: "Design System/Primitives/Terminal Block",
  component: TerminalBlock,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    command: "pnpm -C apps/storybook build",
    description: "Build Storybook for review",
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
