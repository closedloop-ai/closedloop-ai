import { PriorityBadge } from "@repo/design-system/components/ui/priority-badge";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * A project's priority level as a colored pill with a text label, used
 * instead of Priority Icon when the row has room for words, not just a
 * glyph.
 */
const meta = {
  title: "Primitives/Data Display/Priority Badge",
  component: PriorityBadge,
  tags: ["autodocs"],
  argTypes: {
    priority: {
      control: { type: "radio" },
      options: ["LOW", "MEDIUM", "HIGH", "URGENT"],
      description:
        "Priority level. Drives both the badge colour and its visible label.",
    },
    className: {
      control: "text",
      description: "Extra classes merged onto the badge.",
    },
  },
  parameters: {
    layout: "centered",
  },
  args: {
    priority: "MEDIUM",
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
 * Renders every priority level together, each labelled by the badge's own
 * text, so one Chromatic snapshot keeps visual coverage for all four levels
 * instead of four separate story snapshots.
 */
export const AllVariants: Story = {
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
