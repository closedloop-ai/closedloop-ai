import { Chip } from "@repo/design-system/components/ui/chip";
import type { Meta, StoryObj } from "@storybook/react";
import { GitPullRequest, Play, Sparkles } from "lucide-react";

const meta = {
  title: "Primitives/Data Display/Chip",
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
      control: { type: "select" },
    },
    size: {
      options: ["sm", "default", "lg"],
      control: { type: "radio" },
    },
    interactive: {
      control: "boolean",
      description: "Adds the shared focus ring and hover treatment.",
    },
    asChild: {
      control: false,
      description: "Render the child element instead of a span.",
    },
    className: { control: "text" },
    children: { control: "text" },
  },
  args: {
    children: "Shared chip",
    interactive: false,
    size: "default",
    variant: "muted",
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
