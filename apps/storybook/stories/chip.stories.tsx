import { Chip } from "@repo/design-system/components/ui/chip";
import type { Meta, StoryObj } from "@storybook/react";
import { GitPullRequest, Play, Sparkles } from "lucide-react";

const meta = {
  title: "Design System/Primitives/Chip",
  component: Chip,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
  args: {
    children: "Shared chip",
  },
} satisfies Meta<typeof Chip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Variants: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <Chip variant="outline">
        <GitPullRequest />
        PR #1328
      </Chip>
      <Chip variant="accent">
        <Sparkles />
        Awaiting input
      </Chip>
      <Chip variant="success">
        <Play />
        Run
      </Chip>
    </div>
  ),
};
