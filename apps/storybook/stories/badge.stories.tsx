import { Badge } from "@repo/design-system/components/ui/badge";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * A small static pill labeling a state or category, used instead of Chip
 * when the label isn't clickable and doesn't need an icon.
 */
const meta = {
  title: "Primitives/Data Display/Badge",
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
        "ai",
        "muted",
        "neutral",
        "outline",
      ],
      control: { type: "select" },
    },
    asChild: {
      control: false,
      description:
        "Renders the badge styles onto the single child element instead of a span.",
    },
  },
  args: {
    children: "Badge",
    variant: "default",
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
 * Every `variant` value rendered together, labelled, so one Chromatic
 * snapshot keeps visual coverage of the full set instead of one story per
 * value. Drive `variant` from the Controls panel on Default to preview a
 * single value in isolation.
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
      <Badge variant="ai">Ai</Badge>
      <Badge variant="muted">Muted</Badge>
      <Badge variant="neutral">Neutral</Badge>
      <Badge variant="outline">Outline</Badge>
    </div>
  ),
};
