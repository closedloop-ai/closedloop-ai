import { Chip } from "@repo/design-system/components/ui/chip";
import type { Meta, StoryObj } from "@storybook/react";
import { GitPullRequest, Play, Sparkles } from "lucide-react";

const meta = {
  title: "Primitives v1.0/Data Display/Chip",
  component: Chip,
  tags: ["deprecated", "autodocs"],
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
    interactive: {
      control: "boolean",
      description:
        "Adds the focus-visible ring and hover treatment, so a chip that means to be reached by keyboard (e.g. a tooltip trigger) is not a plain, unfocusable <span>.",
    },
  },
  args: {
    children: "Shared chip",
  },
} satisfies Meta<typeof Chip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** The three real `size` values — only `default` (this story's own implicit
 * render) was ever shown before; `sm` and `lg` had no story of their own. */
export const Sizes: Story = {
  tags: ["!manifest"],
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Chip size="sm">Small</Chip>
      <Chip size="default">Default</Chip>
      <Chip size="lg">Large</Chip>
    </div>
  ),
  parameters: { controls: { disable: true } },
};

/**
 * `interactive` on its own, as the real "keyboard-reachable trigger" pattern
 * this prop exists for (`resolution-badge.tsx`): a plain `<span>` chip is not
 * focusable by default, so a chip that opens a tooltip pairs `interactive`
 * with `tabIndex={0}` to put it in the tab order and give it a visible focus
 * ring. Tab to it to see the ring; without `interactive` it would not appear.
 */
export const Interactive: Story = {
  args: {
    interactive: true,
    tabIndex: 0,
  },
};

export const AllVariants: Story = {
  tags: ["!manifest"],
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
  parameters: { controls: { disable: true } },
};

export const Variants: Story = {
  tags: ["!manifest"],
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
  parameters: { controls: { disable: true } },
};
