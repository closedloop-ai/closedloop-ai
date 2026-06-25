import { StatusPercentageIcon } from "@repo/design-system/components/ui/status-percentage-icon";
import type { Meta, StoryObj } from "@storybook/react";

/**
 * Renders a circular SVG icon representing numeric completion (0-100%).
 * At 100% it becomes a filled green circle with a check mark. Supports
 * a "thinking" spinner overlay for AI/agent processing.
 */
const meta = {
  title: "Design System/Data Display/Status Percentage Icon",
  component: StatusPercentageIcon,
  tags: ["autodocs"],
  argTypes: {
    value: { control: { type: "range", min: 0, max: 100, step: 1 } },
    size: { control: "select", options: [16, 20] },
    thinking: { control: "boolean" },
  },
  parameters: { layout: "centered" },
} satisfies Meta<typeof StatusPercentageIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { value: 50 },
};

export const Empty: Story = {
  args: { value: 0 },
};

export const Quarter: Story = {
  args: { value: 25 },
};

export const Half: Story = {
  args: { value: 50 },
};

export const ThreeQuarters: Story = {
  args: { value: 75 },
};

export const Full: Story = {
  args: { value: 100 },
};

/** Increments of 25%. */
export const AllIncrements: Story = {
  args: { value: 0 },
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      {[0, 25, 50, 75, 100].map((pct) => (
        <div
          key={pct}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
          }}
        >
          <StatusPercentageIcon value={pct} />
          <span style={{ fontSize: 11 }}>{pct}%</span>
        </div>
      ))}
    </div>
  ),
};

/** Fine-grained increments of 10%. */
export const FineGrained: Story = {
  args: { value: 0 },
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      {[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((pct) => (
        <div
          key={pct}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
          }}
        >
          <StatusPercentageIcon value={pct} />
          <span style={{ fontSize: 11 }}>{pct}%</span>
        </div>
      ))}
    </div>
  ),
};

/** Thinking spinner at various percentages — inner fill stays visible while outer ring spins. */
export const Thinking: Story = {
  args: { value: 50, thinking: true },
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      {[0, 25, 50, 75].map((pct) => (
        <div
          key={pct}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
          }}
        >
          <StatusPercentageIcon thinking value={pct} />
          <span style={{ fontSize: 11 }}>{pct}%</span>
        </div>
      ))}
    </div>
  ),
};

/** Side-by-side comparison: normal vs thinking at the same percentage. */
export const NormalVsThinking: Story = {
  args: { value: 60 },
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {[25, 50, 75].map((pct) => (
        <div
          key={pct}
          style={{ display: "flex", alignItems: "center", gap: 24 }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
            }}
          >
            <StatusPercentageIcon size={20} value={pct} />
            <span style={{ fontSize: 11 }}>{pct}%</span>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 4,
            }}
          >
            <StatusPercentageIcon size={20} thinking value={pct} />
            <span style={{ fontSize: 11 }}>{pct}% thinking</span>
          </div>
        </div>
      ))}
    </div>
  ),
};

/** Size 20 variants. */
export const Size20: Story = {
  args: { value: 50, size: 20 },
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      {[0, 25, 50, 75, 100].map((pct) => (
        <div
          key={pct}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
          }}
        >
          <StatusPercentageIcon size={20} value={pct} />
          <span style={{ fontSize: 11 }}>{pct}%</span>
        </div>
      ))}
    </div>
  ),
};
