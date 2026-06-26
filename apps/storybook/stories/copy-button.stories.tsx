import { CopyButton } from "@repo/design-system/components/ui/primitives/copy-button";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
  title: "Design System/Primitives/Copy Button",
  component: CopyButton,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  args: {
    text: "pnpm -C apps/storybook build",
    label: "Copy command",
  },
} satisfies Meta<typeof CopyButton>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
