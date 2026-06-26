import { PriorityBadge } from "@repo/design-system/components/ui/priority-badge";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * Displays a color-coded badge for project priority levels.
 */
const meta = {
  title: "Design System/Data Display/Priority Badge",
  component: PriorityBadge,
  tags: ["autodocs"],
  argTypes: {
    priority: {
      control: "select",
      options: ["LOW", "MEDIUM", "HIGH", "URGENT"],
    },
  },
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof PriorityBadge>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default priority badge at MEDIUM priority.
 */
export const Default: Story = {
  args: {
    priority: "MEDIUM",
  },
};

/**
 * Low priority badge.
 */
export const Low: Story = {
  args: {
    priority: "LOW",
  },
};

/**
 * Medium priority badge.
 */
export const Medium: Story = {
  args: {
    priority: "MEDIUM",
  },
};

/**
 * High priority badge.
 */
export const High: Story = {
  args: {
    priority: "HIGH",
  },
};

/**
 * Urgent priority badge.
 */
export const Urgent: Story = {
  args: {
    priority: "URGENT",
  },
};

/**
 * All priority badges displayed together.
 */
export const AllPriorities: Story = {
  args: {
    priority: "MEDIUM",
  },
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {(["LOW", "MEDIUM", "HIGH", "URGENT"] as const).map((level) => (
        <PriorityBadge key={level} priority={level} />
      ))}
    </div>
  ),
};
