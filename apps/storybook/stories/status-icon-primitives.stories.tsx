import {
  FilledStatusCircle,
  StatusRing,
} from "@repo/design-system/components/ui/status-icon-primitives";
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";

/**
 * Generic, domain-agnostic building blocks for circular status icons.
 * `StatusRing` renders a percentage-complete arc + inner pie; `FilledStatusCircle`
 * renders a solid circle with a centered white glyph. Domain status-icon
 * components compose these to render their own status vocabularies.
 */
const meta = {
  title: "Design System/Primitives/Status Icon Primitives",
  component: StatusRing,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
} satisfies Meta<typeof StatusRing>;

export default meta;
type Story = StoryObj<typeof meta>;

function Swatch({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
      }}
    >
      {children}
      <span style={{ fontSize: 11 }}>{label}</span>
    </div>
  );
}

/** StatusRing at the standard percentage stops. */
export const Ring: Story = {
  args: { percentage: 50, color: "var(--progress-foreground)", label: "Ring" },
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <Swatch label="empty">
        <StatusRing
          color="var(--progress-foreground)"
          label="Empty"
          percentage={0}
        />
      </Swatch>
      <Swatch label="dashed">
        <StatusRing
          color="var(--progress-foreground)"
          dashed
          label="Dashed"
          percentage={0}
        />
      </Swatch>
      <Swatch label="25%">
        <StatusRing
          color="var(--progress-foreground)"
          label="25%"
          percentage={25}
        />
      </Swatch>
      <Swatch label="50%">
        <StatusRing
          color="var(--progress-foreground)"
          label="50%"
          percentage={48.5}
        />
      </Swatch>
      <Swatch label="75%">
        <StatusRing
          color="var(--progress-foreground)"
          label="75%"
          percentage={73.5}
        />
      </Swatch>
      <Swatch label="100%">
        <StatusRing
          color="var(--progress-foreground)"
          label="100%"
          percentage={100}
        />
      </Swatch>
      <Swatch label="thinking">
        <StatusRing
          color="var(--progress-foreground)"
          label="Thinking"
          percentage={48.5}
          thinking
        />
      </Swatch>
    </div>
  ),
};

/** FilledStatusCircle for each glyph. */
export const Filled: Story = {
  args: {
    percentage: 100,
    color: "var(--progress-foreground)",
    label: "Filled",
  },
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <Swatch label="check">
        <FilledStatusCircle fill="var(--success)" glyph="check" label="Check" />
      </Swatch>
      <Swatch label="x">
        <FilledStatusCircle fill="var(--foreground)" glyph="x" label="X" />
      </Swatch>
      <Swatch label="swap">
        <FilledStatusCircle fill="var(--ai)" glyph="swap" label="Swap" />
      </Swatch>
      <Swatch label="exclamation">
        <FilledStatusCircle
          fill="var(--warning)"
          glyph="exclamation"
          label="Exclamation"
        />
      </Swatch>
    </div>
  ),
};
