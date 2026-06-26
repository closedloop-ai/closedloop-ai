import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * Renders a signal-bar SVG icon representing a priority level.
 */
const meta = {
  title: "Design System/Data Display/Priority Icon",
  component: PriorityIcon,
  tags: ["autodocs"],
  argTypes: {
    priority: {
      control: "select",
      options: ["LOW", "MEDIUM", "HIGH", "URGENT"],
    },
    size: {
      control: "number",
    },
  },
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof PriorityIcon>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The default priority icon at LOW priority.
 */
export const Default: Story = {
  args: {
    priority: "LOW",
  },
};

/**
 * Low priority — one active bar.
 */
export const Low: Story = {
  args: {
    priority: "LOW",
  },
};

/**
 * Medium priority — two active bars.
 */
export const Medium: Story = {
  args: {
    priority: "MEDIUM",
  },
};

/**
 * High priority — three active bars.
 */
export const High: Story = {
  args: {
    priority: "HIGH",
  },
};

/**
 * Urgent priority — filled rectangle with exclamation mark.
 */
export const Urgent: Story = {
  args: {
    priority: "URGENT",
  },
};

/**
 * All four priority levels displayed side by side.
 */
export const AllPriorities: Story = {
  args: {
    priority: "LOW",
  },
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      {(["LOW", "MEDIUM", "HIGH", "URGENT"] as const).map((level) => (
        <div
          key={level}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
          }}
        >
          <PriorityIcon priority={level} />
          <span style={{ fontSize: 11 }}>{level}</span>
        </div>
      ))}
    </div>
  ),
};

/**
 * Demonstrates a custom icon size of 24px.
 */
export const CustomSize: Story = {
  args: {
    priority: "HIGH",
    size: 24,
  },
};
