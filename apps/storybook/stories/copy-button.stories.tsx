import { CopyButton } from "@repo/design-system/components/ui/primitives/copy-button";
import type { Meta, StoryObj } from "@storybook/react";

const meta = {
  title: "Primitives v1.0/Actions/Copy Button",
  component: CopyButton,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "centered" },
  args: {
    text: "pnpm -C apps/storybook build",
    label: "Copy command",
  },
} satisfies Meta<typeof CopyButton>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
