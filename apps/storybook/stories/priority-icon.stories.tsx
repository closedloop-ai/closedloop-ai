import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * A small signal bar icon for a priority level, used instead of Priority
 * Badge in a tight spot like a table cell where its text label wouldn't fit.
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
 * Renders every priority level side by side, each labelled with its own
 * name, so one Chromatic snapshot keeps visual coverage for all four levels
 * instead of four separate story snapshots.
 */
export const AllVariants: Story = {
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
