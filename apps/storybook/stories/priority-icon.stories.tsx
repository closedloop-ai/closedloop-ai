import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * Draws a small signal bar icon for a priority level: one bar lit for Low,
 * two for Medium, three for High. Urgent swaps the bars for a solid filled
 * rectangle with an exclamation mark, so it reads as its own shape rather
 * than just more bars. Use it in a tight spot like a table cell or list row
 * where Priority Badge's text label would not fit; its size is set in
 * pixels, and it takes its colour from the surrounding text.
 */
const meta = {
  title: "Primitives/Data Display/Priority Icon",
  component: PriorityIcon,
  tags: ["autodocs"],
  argTypes: {
    priority: {
      control: { type: "radio" },
      options: ["LOW", "MEDIUM", "HIGH", "URGENT"],
      description:
        "Priority level. LOW/MEDIUM/HIGH light one, two or three signal bars; URGENT swaps to the filled exclamation glyph.",
    },
    size: {
      control: { type: "number", min: 8, max: 64, step: 1 },
      description: "Icon width and height in pixels.",
    },
    className: {
      control: "text",
      description: "Extra classes merged onto the `svg`.",
    },
  },
  parameters: {
    layout: "centered",
  },
  args: {
    priority: "LOW",
    size: 16,
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
