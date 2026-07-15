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
  argTypes: {
    variant: {
      options: [
        "default",
        "secondary",
        "destructive",
        "success",
        "warning",
        "info",
        "accent",
        "muted",
        "outline",
      ],
      control: { type: "radio" },
    },
    size: {
      options: ["sm", "default", "lg"],
      control: { type: "radio" },
    },
  },
  args: {
    children: "Shared chip",
  },
} satisfies Meta<typeof Chip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <Chip variant="default">Default</Chip>
      <Chip variant="secondary">Secondary</Chip>
      <Chip variant="destructive">Destructive</Chip>
      <Chip variant="success">Success</Chip>
      <Chip variant="warning">Warning</Chip>
      <Chip variant="info">Info</Chip>
      <Chip variant="accent">Accent</Chip>
      <Chip variant="muted">Muted</Chip>
      <Chip variant="outline">Outline</Chip>
    </div>
  ),
};

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
