import { Badge } from "@repo/design-system/components/ui/badge";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * Displays a badge or a component that looks like a badge.
 */
const meta = {
  title: "Design System/Data Display/Badge",
  component: Badge,
  tags: ["autodocs"],
  argTypes: {
    children: {
      control: "text",
    },
    variant: {
      options: [
        "default",
        "secondary",
        "destructive",
        "error",
        "success",
        "warning",
        "info",
        "accent",
        "muted",
        "outline",
      ],
      control: { type: "radio" },
    },
  },
  args: {
    children: "Badge",
  },
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof Badge>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default form of the badge.
 */
export const Default: Story = {};

/**
 * Use the `secondary` badge to call for less urgent information, blending
 * into the interface while still signaling minor updates or statuses.
 */
export const Secondary: Story = {
  args: {
    variant: "secondary",
  },
};

/**
 * Use the `destructive` badge to  indicate errors, alerts, or the need for
 * immediate attention.
 */
export const Destructive: Story = {
  args: {
    variant: "destructive",
  },
};

/**
 * Use the `error` badge for a light destructive tint — signaling errors or
 * failed states without the heavier solid fill of the `destructive` variant.
 */
export const ErrorVariant: Story = {
  args: {
    variant: "error",
  },
};

/**
 * Use the `success` badge to indicate a positive outcome or completed state.
 */
export const Success: Story = {
  args: {
    variant: "success",
  },
};

/**
 * Use the `warning` badge to flag items needing caution or attention.
 */
export const Warning: Story = {
  args: {
    variant: "warning",
  },
};

/**
 * Use the `info` badge to convey neutral, contextual information.
 */
export const Info: Story = {
  args: {
    variant: "info",
  },
};

/**
 * Use the `accent` badge to highlight featured or promoted content.
 */
export const Accent: Story = {
  args: {
    variant: "accent",
  },
};

/**
 * Use the `muted` badge for low-emphasis metadata or supplementary labels.
 */
export const Muted: Story = {
  args: {
    variant: "muted",
  },
};

/**
 * Use the `outline` badge for overlaying without obscuring interface details,
 * emphasizing clarity and subtlety.
 */
export const Outline: Story = {
  args: {
    variant: "outline",
  },
};

/**
 * All 10 badge variants displayed together for comparison.
 */
export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <Badge>Default</Badge>
      <Badge variant="secondary">Secondary</Badge>
      <Badge variant="destructive">Destructive</Badge>
      <Badge variant="error">Error</Badge>
      <Badge variant="success">Success</Badge>
      <Badge variant="warning">Warning</Badge>
      <Badge variant="info">Info</Badge>
      <Badge variant="accent">Accent</Badge>
      <Badge variant="muted">Muted</Badge>
      <Badge variant="outline">Outline</Badge>
    </div>
  ),
};
