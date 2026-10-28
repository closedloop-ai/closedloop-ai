import { BADGE_VARIANTS, Badge } from "@repo/design-system/components/ui/badge";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * Displays a badge or a component that looks like a badge.
 */
const meta = {
  title: "Primitives v1.0/Data Display/Badge",
  component: Badge,
  tags: ["deprecated", "autodocs"],
  argTypes: {
    children: {
      control: "text",
    },
    variant: {
      options: BADGE_VARIANTS,
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
 * The default form of the badge: `variant="default"`. Explicit here (rather
 * than left to render implicitly with no props) so both a human and any
 * static-analysis tooling reading this file can see it is genuinely
 * exercised, not just visually correct by luck.
 */
export const Default: Story = {
  args: {
    variant: "default",
  },
};

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
 * Use the `ai` badge for the agentic/AI tone.
 */
export const Ai: Story = {
  args: {
    variant: "ai",
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
 * Use the `neutral` badge for a bordered, filled chip whose text stays the
 * plain foreground color — distinct from `default` (a solid primary chip)
 * and from `outline` (no fill at all).
 */
export const Neutral: Story = {
  args: {
    variant: "neutral",
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
 * Every badge variant displayed together for comparison, driven by
 * BADGE_VARIANTS so this can't go stale the way a hand-typed list did.
 */
export const AllVariants: Story = {
  tags: ["!manifest"],
  parameters: {
    controls: { disable: true },
  },
  render: () => (
    <div className="flex flex-wrap gap-2">
      {BADGE_VARIANTS.map((variant) => (
        <Badge key={variant} variant={variant}>
          {variant}
        </Badge>
      ))}
    </div>
  ),
};
